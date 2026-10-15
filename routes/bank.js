// Bank reconciliation. Reads deposits from the company bank accounts connected in Bolta and helps finance match
// each one to an issued bill. Nothing is recorded automatically: a person confirms every match.
//
//   GET  /api/bank/overview                 connected accounts (live from Bolta), last fetch, counts
//   POST /api/bank/pull                     fetch new / changed transactions from Bolta (free, incremental)
//   POST /api/bank/sync-request             ask Bolta to re-read the bank first (Bolta allows 1 per 30 min, 12 per day)
//   GET  /api/bank/transactions?status=     unmatched | matched | ignored | other   (+ suggested bills for unmatched deposits)
//   GET  /api/bank/open-bills               issued bills that still owe money (for choosing a bill by hand)
//   POST /api/bank/transactions/:id/match   record the deposit as a payment on a bill
//   POST /api/bank/transactions/:id/ignore  not a client payment   ·   /restore  puts it back
const express = require('express');
const db = require('../db');
const audit = require('../lib/audit');
const bolta = require('../lib/bolta');
const { balanceDue, fullyPaid } = require('../lib/invoice-ready');
const { openBills, suggestionsFor } = require('../lib/bank-match');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('admin', 'finance_hr'));

const kstDate = (iso) => new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const state = (key) => (db.prepare('SELECT value FROM bank_sync_state WHERE key = ?').get(key) || {}).value || null;
const setState = (key, value) => db.prepare(`INSERT INTO bank_sync_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value);

/** A plain-English message for a Bolta failure (or null when it is not one). */
function boltaProblem(e) {
  if (!(e instanceof bolta.BoltaError)) return null;
  const mins = e.retryAfter ? ` Try again in about ${Math.max(1, Math.ceil(Number(e.retryAfter) / 60))} minute(s).` : '';
  const known = {
    PLAN_UPGRADE_REQUIRED: 'Bank data needs Bolta’s Standard plan or higher.',
    BANK_ACCOUNT_NOT_CONNECTED: 'No bank account is connected yet. Connect one in the Bolta dashboard first.',
    SYNC_IN_PROGRESS: 'Bolta is already refreshing from the bank. Fetch again in a few minutes.',
    SYNC_RATE_LIMITED: 'Bolta limits bank refreshes to one every 30 minutes (12 a day).' + mins,
    SYNC_UNAVAILABLE: 'Bolta cannot start a bank refresh right now. Try again shortly.',
    SERVICE_UNAVAILABLE: 'Bolta is temporarily unavailable. Try again shortly.',
    INVALID_CURSOR: 'Bolta did not accept the saved position. Fetch again to start from the beginning.'
  };
  return known[e.code] || e.message;
}
const fail = (res, e) => {
  const msg = boltaProblem(e);
  if (msg) return res.status(502).json({ error: msg });
  console.error('[bank]', e);
  return res.status(500).json({ error: 'The bank data could not be loaded.' });
};
const needBolta = (req, res, next) => (bolta.enabled() ? next() : res.status(400).json({ error: 'Bolta is not set up (BOLTA_API_KEY is empty).' }));

// ---------------------------------------------------------------------------------------------
router.get('/overview', async (req, res) => {
  const env = bolta.environment();
  const out = { enabled: bolta.enabled(), environment: env, accounts: [], accountsError: null,
    lastPulledAt: state('pulled_at:' + env), counts: {} };
  const n = (where) => db.prepare(`SELECT COUNT(*) n FROM bank_transactions WHERE env = ? AND ${where}`).get(env).n;
  out.counts = {
    unmatched: n("type = 'DEPOSIT' AND match_status = 'unmatched' AND removed_at IS NULL"),
    matched: n("match_status = 'matched'"),
    ignored: n("match_status = 'ignored'"),
    other: n("type != 'DEPOSIT'")
  };
  if (out.enabled) {
    try { out.accounts = (await bolta.listBankAccounts()).items || []; }
    catch (e) { out.accountsError = boltaProblem(e) || 'Could not read the connected accounts.'; }
  }
  res.json(out);
});

router.post('/pull', needBolta, async (req, res) => {
  const env = bolta.environment();
  const key = 'cursor:' + env;
  let cursor = state(key);
  let restarted = false, pages = 0, changed = 0, removed = 0;
  const upsert = db.prepare(`INSERT INTO bank_transactions
    (id, env, bolta_id, bank_account_id, bank_code, account_number, transaction_at, paid_on, type, amount, balance_after, description, currency)
    VALUES (@id, @env, @bolta_id, @bank_account_id, @bank_code, @account_number, @transaction_at, @paid_on, @type, @amount, @balance_after, @description, @currency)
    ON CONFLICT(id) DO UPDATE SET bank_account_id = excluded.bank_account_id, bank_code = excluded.bank_code,
      account_number = excluded.account_number, transaction_at = excluded.transaction_at, paid_on = excluded.paid_on,
      type = excluded.type, amount = excluded.amount, balance_after = excluded.balance_after,
      description = excluded.description, currency = excluded.currency, removed_at = NULL`);
  const apply = db.transaction((items) => {
    for (const it of items) {
      const id = env + ':' + it.id;
      if (it.status === 'REMOVED') {
        const row = db.prepare('SELECT match_status FROM bank_transactions WHERE id = ?').get(id);
        if (!row) continue;
        removed++;
        // A deposit that was already matched keeps its payment; flag it so finance can look at it.
        if (row.match_status === 'matched') db.prepare("UPDATE bank_transactions SET removed_at = datetime('now') WHERE id = ?").run(id);
        else db.prepare('DELETE FROM bank_transactions WHERE id = ?').run(id);
        continue;
      }
      changed++;
      upsert.run({
        id, env, bolta_id: String(it.id), bank_account_id: it.bankAccountId == null ? null : String(it.bankAccountId),
        bank_code: it.bankCode || null, account_number: it.accountNumber || null,
        transaction_at: it.transactionAt, paid_on: kstDate(it.transactionAt), type: it.transactionType || 'OTHER',
        amount: Number(it.amount) || 0, balance_after: it.balanceAfterTransaction == null ? null : Number(it.balanceAfterTransaction),
        description: it.description || null, currency: it.currencyCode || 'KRW'
      });
    }
  });
  try {
    for (;;) {
      let page;
      try { page = await bolta.listBankTransactions({ cursor, limit: 500 }); }
      catch (e) {
        // A cursor Bolta no longer accepts: start again from the beginning once. Re-reading is harmless (upserts).
        if (e.code === 'INVALID_CURSOR' && cursor && !restarted) { cursor = null; restarted = true; continue; }
        throw e;
      }
      apply(page.items || []);
      cursor = page.nextCursor || cursor;
      if (cursor) setState(key, cursor);
      pages++;
      if (!page.hasMore || pages >= 40) break;   // hasMore, not items.length, says whether there is more
    }
    setState('pulled_at:' + env, new Date().toISOString());
    audit.log(req, 'bank', 0, 'pull', `Fetched bank transactions from Bolta (${env}): ${changed} new or changed, ${removed} removed`);
    res.json({ ok: true, changed, removed, pages, more: pages >= 40 });
  } catch (e) { fail(res, e); }
});

router.post('/sync-request', needBolta, async (req, res) => {
  try {
    const out = await bolta.requestBankSync();
    audit.log(req, 'bank', 0, 'sync-request', 'Asked Bolta to refresh the bank accounts');
    res.json({ ok: true, ...out });
  } catch (e) { fail(res, e); }
});

// ---------------------------------------------------------------------------------------------
router.get('/open-bills', (req, res) => {
  res.json({ bills: openBills().sort((a, b) => a.client_name.localeCompare(b.client_name) || a.statement_no.localeCompare(b.statement_no)) });
});

router.get('/transactions', (req, res) => {
  const env = bolta.environment();
  const status = ['unmatched', 'matched', 'ignored', 'other'].includes(req.query.status) ? req.query.status : 'unmatched';
  const where = {
    unmatched: "t.type = 'DEPOSIT' AND t.match_status = 'unmatched' AND t.removed_at IS NULL",
    matched: "t.match_status = 'matched'",
    ignored: "t.match_status = 'ignored'",
    other: "t.type != 'DEPOSIT'"
  }[status];
  const rows = db.prepare(`SELECT t.*, b.statement_no, c.name AS client_name
    FROM bank_transactions t LEFT JOIN bills b ON b.id = t.bill_id LEFT JOIN clients c ON c.id = b.client_id
    WHERE t.env = ? AND ${where} ORDER BY t.transaction_at DESC, t.id DESC LIMIT 300`).all(env);
  if (status === 'unmatched') {
    const open = openBills();
    for (const r of rows) r.suggestions = suggestionsFor(r, open);
  }
  res.json({ environment: env, transactions: rows });
});

router.post('/transactions/:id/match', (req, res) => {
  const env = bolta.environment();
  const tx = db.prepare('SELECT * FROM bank_transactions WHERE id = ? AND env = ?').get(req.params.id, env);
  if (!tx) return res.status(404).json({ error: 'Transaction not found.' });
  if (tx.match_status !== 'unmatched' || tx.removed_at) return res.status(409).json({ error: 'This transaction is already handled or was removed.' });
  if (tx.type !== 'DEPOSIT' || tx.currency !== 'KRW') return res.status(400).json({ error: 'Only won deposits can be matched to a bill.' });
  const b = req.body || {};
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(b.bill_id);
  if (!bill) return res.status(404).json({ error: 'Choose a bill to match.' });
  if (bill.status !== 'issued') return res.status(400).json({ error: 'Only issued bills can receive a payment.' });
  const due = Math.round(balanceDue(bill.id));
  if (due <= 0) return res.status(400).json({ error: 'That bill has nothing left to pay.' });
  const amount = Math.round(Number(b.amount == null || b.amount === '' ? Math.min(tx.amount, due) : b.amount));
  if (!(amount > 0)) return res.status(400).json({ error: 'Enter the amount to apply to the bill.' });
  if (amount > tx.amount) return res.status(400).json({ error: 'That is more than the deposit.' });
  if (amount > due) return res.status(400).json({ error: 'That is more than the bill still owes (' + due.toLocaleString('en-US') + ').' });

  const by = req.session.username;
  const result = db.transaction(() => {
    const ref = `Bank deposit${tx.description ? ' – ' + tx.description : ''} [${tx.bolta_id}]`.slice(0, 200);
    const pay = db.prepare('INSERT INTO payments (bill_id, paid_on, amount, reference, method, created_by) VALUES (?,?,?,?,?,?)')
      .run(bill.id, tx.paid_on, amount, ref, 'Bank transfer (Bolta)', by);
    const left = Math.round(balanceDue(bill.id));
    db.prepare('UPDATE bills SET total_due = ? WHERE id = ?').run(left, bill.id);
    if (left <= 0) db.prepare('UPDATE clients SET status = ? WHERE id = ?').run('Paid', bill.client_id);
    db.prepare(`UPDATE bank_transactions SET match_status = 'matched', bill_id = ?, payment_id = ?, applied_amount = ?,
                matched_by = ?, matched_at = datetime('now') WHERE id = ?`).run(bill.id, pay.lastInsertRowid, amount, by, tx.id);
    let confirmed = false;
    if (b.confirm && fullyPaid(bill.id)) {
      db.prepare("UPDATE bills SET payment_confirmed_by = ?, payment_confirmed_at = datetime('now') WHERE id = ?").run(by, bill.id);
      confirmed = true;
    }
    return { left, confirmed };
  })();
  audit.log(req, 'bill', bill.id, 'bank-match',
    `Matched bank deposit of ${tx.amount} on ${tx.paid_on}${tx.description ? ' (' + tx.description + ')' : ''}, applied ${amount} to ${bill.statement_no}` +
    (env === 'test' ? ' [Bolta TEST sample data]' : '') + (result.confirmed ? ', payment confirmed' : ''));
  res.json({ ok: true, total_due: result.left, confirmed: result.confirmed });
});

router.post('/transactions/:id/ignore', (req, res) => {
  const env = bolta.environment();
  const r = db.prepare("UPDATE bank_transactions SET match_status = 'ignored', matched_by = ?, matched_at = datetime('now') WHERE id = ? AND env = ? AND match_status = 'unmatched'")
    .run(req.session.username, req.params.id, env);
  if (!r.changes) return res.status(409).json({ error: 'This transaction cannot be ignored (it is already handled).' });
  audit.log(req, 'bank', 0, 'ignore', `Marked bank transaction ${req.params.id} as not a client payment`);
  res.json({ ok: true });
});

router.post('/transactions/:id/restore', (req, res) => {
  const env = bolta.environment();
  const r = db.prepare("UPDATE bank_transactions SET match_status = 'unmatched', matched_by = NULL, matched_at = NULL WHERE id = ? AND env = ? AND match_status = 'ignored'")
    .run(req.params.id, env);
  if (!r.changes) return res.status(409).json({ error: 'Only an ignored transaction can be put back.' });
  res.json({ ok: true });
});

module.exports = router;
