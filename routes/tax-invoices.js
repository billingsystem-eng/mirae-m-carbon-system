// Electronic tax invoices (전자세금계산서) for issued bills, through Bolta (https://bolta.io).
//
//   GET  /api/tax-invoices/bills/:id          what would be issued + every attempt so far
//   GET  /api/tax-invoices/bills/:id/client   the issued tax invoice, for the client login (only once payment is confirmed)
//   POST /api/tax-invoices/bills/:id/issue    send the invoice to Bolta (admin / finance only)
//   POST /api/tax-invoices/:id/refresh        re-check an attempt that has no final answer yet
//   POST /api/bolta/webhook/<token>           Bolta's result callback (public; the token authenticates it).
//                                              ?token=<token> on /api/bolta/webhook works too.
//
// "Accepted by Bolta" is NOT "issued". Bolta answers the issue call with an issuanceKey immediately and
// reports the real outcome later: by webhook (test key ≈ 10–30 s, live key ≈ 10 min) or by lookup.
// So a row stays `requested` until the webhook (or Refresh) confirms it.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const audit = require('../lib/audit');
const bolta = require('../lib/bolta');
const { invoiceReady } = require('../lib/invoice-ready');
const { requireRole, notViewer, viewerScope } = require('../middleware/auth');

const router = express.Router();
const canIssue = requireRole('admin', 'finance_hr');

const VAT_MODES = {
  add: 'Amount is before VAT — add 10% VAT',
  incl: 'Amount already includes 10% VAT',
  zero: 'Zero-rated (영세율)',
  free: 'VAT-exempt (면세 계산서)'
};
const defaultVatMode = () => (VAT_MODES[process.env.BOLTA_VAT_MODE] ? process.env.BOLTA_VAT_MODE : 'add');
const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const clip = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
// First setting that has a value. Both naming styles work, so nothing has to be renamed on the server.
const env = (...names) => { for (const n of names) if (process.env[n]) return process.env[n]; return ''; };

/** Mirae ESP's own details (the supplier / 공급자 on every invoice), from the environment. */
function supplierFromEnv() {
  return {
    brn: bolta.digits(env('BOLTA_SUPPLIER_BRN', 'SUPPLIER_BRN')),
    name: clip(env('BOLTA_SUPPLIER_NAME', 'SUPPLIER_NAME'), 70),
    rep: clip(env('BOLTA_SUPPLIER_REPRESENTATIVE', 'BOLTA_SUPPLIER_REP', 'SUPPLIER_REP'), 30),
    email: clip(env('BOLTA_SUPPLIER_EMAIL', 'SUPPLIER_EMAIL'), 40),
    contact: clip(env('BOLTA_SUPPLIER_CONTACT_NAME'), 30),
    address: clip(env('BOLTA_SUPPLIER_ADDRESS'), 150),
    type: clip(env('BOLTA_SUPPLIER_BUSINESS_TYPE'), 100),
    item: clip(env('BOLTA_SUPPLIER_BUSINESS_ITEM'), 100)
  };
}

const koAddress = (c) => clip([c.addr_region, c.addr_city, c.addr_street, c.addr_unit, c.addr_building && `(${c.addr_building})`].filter(Boolean).join(' '), 150);

/** Works out the Bolta request for a bill. Returns { payload, preview } or { problems: [...] }. */
function build(bill, vatMode) {
  const problems = [];
  const sup = supplierFromEnv();
  if (!bolta.validBrn(sup.brn)) problems.push('Set BOLTA_SUPPLIER_BRN (or SUPPLIER_BRN) to Mirae ESP’s valid 10-digit business registration number.');
  if (!sup.name) problems.push('Set BOLTA_SUPPLIER_NAME (Mirae ESP’s registered company name).');
  if (!sup.rep) problems.push('Set BOLTA_SUPPLIER_REPRESENTATIVE (or SUPPLIER_REP) (the representative’s name on the registration).');
  if (!EMAIL_RE.test(sup.email)) problems.push('Set BOLTA_SUPPLIER_EMAIL (or SUPPLIER_EMAIL) to a valid contact email (40 characters or fewer).');

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(bill.client_id);
  const contacts = db.prepare('SELECT * FROM contacts WHERE client_id = ? ORDER BY is_primary DESC, id').all(bill.client_id);
  const clientBrn = bolta.digits(client.tin);
  if (!bolta.validBrn(clientBrn)) problems.push(`${client.name}: the business registration no. is missing or not a valid 10-digit number (edit it on the client page).`);
  // Last NTS check (Clients → Verify with NTS). Only trusted if it was run on this exact number.
  if (client.brn_checked_number === clientBrn && ['CLOSED', 'NOT_REGISTERED'].includes(client.brn_status)) {
    problems.push(`${client.name}: the NTS says this business registration no. is ${client.brn_status === 'CLOSED' ? 'closed' + (client.brn_closed_on ? ' (' + client.brn_closed_on + ')' : '') : 'not registered'}. Check the number on the client page.`);
  }
  if (!clip(client.representative_name, 30)) problems.push(`${client.name}: add the representative’s name (대표자명) on the client page.`);
  if (clip(client.name, 70).length !== String(client.name).trim().length) problems.push(`${client.name}: the company name is longer than 70 characters, which tax invoices do not allow.`);
  const managers = contacts.filter((c) => c.email && EMAIL_RE.test(c.email.trim()) && c.email.trim().length <= 40)
    .slice(0, 2).map((c) => ({ email: c.email.trim(), ...(c.name ? { name: clip(c.name, 30) } : {}) }));
  if (!managers.length) problems.push(`${client.name}: add a contact with a valid email (40 characters or fewer) — Bolta emails the invoice to it.`);

  const amount = Math.round(Number(bill.amount_billed) || 0);
  const split = bolta.splitAmount(amount, vatMode);
  if (amount < 1) problems.push('The billed amount is zero, so there is nothing to invoice.');

  const today = bolta.kstToday();
  let supplyDate = (bill.period_end && bill.period_end <= today) ? bill.period_end : today;
  // Bolta only accepts a supply date inside the month of the write date (first of the month .. today).
  const monthStart = today.slice(0, 7) + '-01';
  if (supplyDate < monthStart) supplyDate = monthStart;
  const purpose = invoiceReady(bill.id) ? 'RECEIPT' : 'CLAIM'; // paid & confirmed → 영수, otherwise 청구
  const itemName = clip(`M-Carbon LED 절감 정산 ${bill.statement_no} (${bill.period_start} ~ ${bill.period_end})`, 100);

  const preview = {
    write_date: today, purpose, tax_type: split.taxType, supply_cost: split.supply, tax: split.tax,
    total: split.supply + (split.tax || 0), vat_mode: vatMode, item_name: itemName,
    recipient: { name: client.name, brn: clientBrn }
  };
  if (problems.length) return { problems, preview };

  const payload = {
    date: today,
    purpose,
    taxType: split.taxType,
    supplier: {
      identificationNumber: sup.brn,
      organizationName: sup.name,
      representativeName: sup.rep,
      ...(sup.address ? { address: sup.address } : {}),
      ...(sup.type ? { businessType: sup.type } : {}),
      ...(sup.item ? { businessItem: sup.item } : {}),
      manager: { email: sup.email, ...(sup.contact ? { name: sup.contact } : {}) }
    },
    supplied: {
      identificationNumber: clientBrn,
      organizationName: clip(client.name, 70),
      representativeName: clip(client.representative_name, 30),
      ...(koAddress(client) ? { address: koAddress(client) } : {}),
      ...(clip(client.business_type, 100) ? { businessType: clip(client.business_type, 100) } : {}),
      ...(clip(client.business_item, 100) ? { businessItem: clip(client.business_item, 100) } : {}),
      managers
    },
    items: [{
      date: supplyDate,
      name: itemName,
      supplyCost: split.supply,
      ...(split.taxType === 'TAX_FREE' ? {} : { tax: split.tax })
    }],
    description: clip(`Statement ${bill.statement_no}`, 150)
  };
  return { payload, preview };
}

const rowsFor = (billId) => db.prepare('SELECT * FROM tax_invoices WHERE bill_id = ? ORDER BY id DESC').all(billId);
const activeFor = (billId) => db.prepare("SELECT * FROM tax_invoices WHERE bill_id = ? AND status IN ('requested','issued','unknown') ORDER BY id DESC LIMIT 1").get(billId);

function eligibility(bill) {
  if (bill.status !== 'issued') return 'The bill must be issued before a tax invoice can be created.';
  return '';
}

// ---------------------------------------------------------------------------------------------
// The tax invoice is the invoice. Client logins see it for their own bill once finance has confirmed the payment
// (the same rule the old Sales Invoice followed). Only the issued invoice, and only fields the client needs.
router.get('/bills/:id/client', (req, res) => {
  if (!req.session || req.session.role !== 'viewer') return res.status(403).json({ error: 'Your role does not allow this.' });
  const bill = db.prepare('SELECT id, client_id, status FROM bills WHERE id = ?').get(Number(req.params.id));
  const scope = viewerScope(req);
  // Same 404 as a missing bill, so a client can't tell a hidden bill from a nonexistent one.
  if (!bill || !scope || !scope.clientId || bill.client_id !== scope.clientId || bill.status !== 'issued') {
    return res.status(404).json({ error: 'Bill not found.' });
  }
  if (!invoiceReady(bill.id)) return res.json({ released: false, invoice: null });
  const t = db.prepare("SELECT write_date, supply_cost, tax, purpose, environment, nts_transaction_id, tax_invoice_url FROM tax_invoices WHERE bill_id = ? AND status = 'issued' ORDER BY id DESC LIMIT 1").get(bill.id);
  res.json({ released: true, invoice: t || null });
});

router.get('/bills/:id', notViewer, (req, res) => {
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(Number(req.params.id));
  if (!bill) return res.status(404).json({ error: 'Bill not found.' });
  const mode = VAT_MODES[req.query.vat] ? req.query.vat : defaultVatMode();
  const built = build(bill, mode);
  res.json({
    enabled: bolta.enabled(),
    environment: bolta.enabled() ? bolta.environment() : null,
    can_issue: ['admin', 'finance_hr'].includes(req.session.role),
    blocked_reason: eligibility(bill),
    problems: built.problems || [],
    preview: built.preview,
    vat_modes: VAT_MODES,
    invoices: rowsFor(bill.id),
    has_active: !!activeFor(bill.id)
  });
});

router.post('/bills/:id/issue', canIssue, async (req, res) => {
  if (!bolta.enabled()) return res.status(503).json({ error: 'Tax invoices are not set up yet (BOLTA_API_KEY is empty).' });
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(Number(req.params.id));
  if (!bill) return res.status(404).json({ error: 'Bill not found.' });
  const blocked = eligibility(bill);
  if (blocked) return res.status(400).json({ error: blocked });

  const mode = VAT_MODES[req.body && req.body.vat_mode] ? req.body.vat_mode : defaultVatMode();
  const built = build(bill, mode);
  if (built.problems) return res.status(400).json({ error: built.problems[0], problems: built.problems });
  const p = built.preview;

  // Reserve the attempt in one synchronous transaction, so two clicks can never issue twice.
  // The reference id is never reused: Bolta rejects a repeated id even for a failed attempt.
  const reserve = db.transaction(() => {
    if (activeFor(bill.id)) return null;
    const n = db.prepare('SELECT COUNT(*) n FROM tax_invoices WHERE bill_id = ?').get(bill.id).n + 1;
    const ref = `mcb-${bill.id}-${n}`;
    const info = db.prepare(`INSERT INTO tax_invoices
      (bill_id, client_reference_id, environment, status, write_date, tax_type, supply_cost, tax, purpose, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(bill.id, ref, bolta.environment(), 'requested', p.write_date, p.tax_type, p.supply_cost, p.tax, p.purpose, req.session.username);
    return { id: info.lastInsertRowid, ref };
  });
  const slot = reserve();
  if (!slot) return res.status(409).json({ error: 'A tax invoice has already been requested or issued for this bill.' });

  try {
    const out = await bolta.issue(built.payload, slot.ref);
    db.prepare("UPDATE tax_invoices SET issuance_key = ?, updated_at = datetime('now') WHERE id = ?").run(out.issuanceKey, slot.id);
    audit.log(req, 'bill', bill.id, 'tax-invoice-request',
      `Requested ${bolta.environment()} tax invoice ${slot.ref} (supply ${p.supply_cost}, VAT ${p.tax ?? 0}) — ${out.issuanceKey}`);
    return res.status(202).json({ id: slot.id, status: 'requested', issuance_key: out.issuanceKey });
  } catch (e) {
    if (e.status && e.status < 500) {
      // Bolta answered and said no: nothing was issued, and the attempt is closed.
      db.prepare("UPDATE tax_invoices SET status = 'failed', failure_code = ?, failure_message = ?, updated_at = datetime('now') WHERE id = ?")
        .run(e.code || String(e.status), e.message, slot.id);
      audit.log(req, 'bill', bill.id, 'tax-invoice-rejected', `Bolta rejected ${slot.ref}: ${e.code || e.status} ${e.message}`);
      return res.status(400).json({ error: `Bolta rejected the request: ${e.message}`, code: e.code, trace_id: e.traceId });
    }
    // No answer, or a 5xx: Bolta MAY have the request. Do not retry blindly — Refresh checks by reference id.
    db.prepare("UPDATE tax_invoices SET status = 'unknown', failure_message = ?, updated_at = datetime('now') WHERE id = ?").run(e.message, slot.id);
    audit.log(req, 'bill', bill.id, 'tax-invoice-unknown', `No clear answer from Bolta for ${slot.ref}: ${e.message}`);
    return res.status(502).json({ error: 'Bolta did not give a clear answer. Press Refresh in a minute to see whether it was received — do not issue again yet.' });
  }
});

/** Ask Bolta where an unfinished attempt stands. Safe to call repeatedly. */
async function refreshRow(row) {
  const needsNumber = row.status === 'issued' && !row.nts_transaction_id && row.issuance_key;   // issued, approval number not fetched yet
  if (!['requested', 'unknown'].includes(row.status) && !needsNumber) return row;
  let key = row.issuance_key;
  if (!key) {
    try {
      const s = await bolta.statusByReference(row.client_reference_id);
      key = s.issuanceKey;
      db.prepare("UPDATE tax_invoices SET issuance_key = ?, status = 'requested', updated_at = datetime('now') WHERE id = ?").run(key, row.id);
    } catch (e) {
      if (e.status === 400) { // Bolta has no request under that id: it never arrived, so a retry is safe.
        db.prepare("UPDATE tax_invoices SET status = 'failed', failure_code = 'NOT_RECEIVED', failure_message = ?, updated_at = datetime('now') WHERE id = ?")
          .run('Bolta has no record of this request, so nothing was issued. You can issue again.', row.id);
      }
      return db.prepare('SELECT * FROM tax_invoices WHERE id = ?').get(row.id);
    }
  }
  try {
    const t = await bolta.retrieve(key); // only answers once the invoice is issued
    db.prepare("UPDATE tax_invoices SET status = 'issued', nts_transaction_id = COALESCE(?, nts_transaction_id), tax_invoice_url = COALESCE(?, tax_invoice_url), issued_at = COALESCE(?, datetime('now')), updated_at = datetime('now') WHERE id = ?")
      .run(t.ntsTransactionId || null, t.taxInvoiceUrl || null, t.issuedAt || null, row.id);
    audit.log({}, 'bill', row.bill_id, 'tax-invoice-issued', `Tax invoice ${row.client_reference_id} confirmed issued (NTS ${t.ntsTransactionId || 'n/a'})`);
  } catch (e) { /* not issued yet (or failed — a failure arrives by webhook) */ }
  return db.prepare('SELECT * FROM tax_invoices WHERE id = ?').get(row.id);
}

router.post('/:id/refresh', canIssue, async (req, res) => {
  const row = db.prepare('SELECT * FROM tax_invoices WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Tax invoice not found.' });
  try { res.json(await refreshRow(row)); }
  catch (e) { console.error('[bolta] refresh', e); res.status(502).json({ error: 'Could not reach Bolta. Try again shortly.' }); }
});

// ---------------------------------------------------------------------------------------------
// Bolta webhook  (mounted in server.js before the session, so it has no login)
// ---------------------------------------------------------------------------------------------
// Bolta's docs describe no signature, so the endpoint is protected by a secret token in the URL you
// register in the Bolta developer center:  https://YOUR-DOMAIN/api/bolta/webhook?token=<BOLTA_WEBHOOK_TOKEN>
// Optionally also restrict the sender: BOLTA_WEBHOOK_IPS=43.201.136.252 (Bolta's published address).
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

function webhook(req, res) {
  const secret = env('BOLTA_WEBHOOK_TOKEN', 'BOLTA_WEBHOOK_SECRET');
  if (!secret) { console.error('[bolta] webhook called but BOLTA_WEBHOOK_TOKEN is not set'); return res.status(503).json({ error: 'Webhook is not configured.' }); }
  // The secret may be the last part of the address (/api/bolta/webhook/<secret>) or ?token=<secret>.
  const given = req.params.secret || req.query.token || '';
  if (!crypto.timingSafeEqual(sha(given), sha(secret))) return res.status(401).json({ error: 'Unauthorized.' });
  const allow = (process.env.BOLTA_WEBHOOK_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ip = String(req.ip || '').replace(/^::ffff:/, '');
  if (allow.length && !allow.includes(ip)) { console.error('[bolta] webhook from a disallowed address', ip); return res.status(403).json({ error: 'Forbidden.' }); }

  // Keep a copy of every event, so a delivery can always be checked afterwards.
  try { db.prepare('INSERT INTO bolta_events (headers_json, body) VALUES (?, ?)').run(JSON.stringify(req.headers), JSON.stringify(req.body || {}).slice(0, 20000)); } catch (_) { /* logging only */ }

  const { eventType, data } = req.body || {};
  const key = data && data.issuanceKey;
  if (!eventType || !key) return res.status(400).json({ error: 'Invalid body.' });

  const row = db.prepare('SELECT * FROM tax_invoices WHERE issuance_key = ?').get(String(key));
  // Unknown key (e.g. an invoice made from Bolta's own dashboard): acknowledge so Bolta does not keep retrying.
  if (!row) return res.json({ ok: true, ignored: 'unknown issuance key' });
  // A duplicate or late event must never overwrite a final answer.
  if (!['requested', 'unknown'].includes(row.status)) return res.json({ ok: true, ignored: 'already ' + row.status });

  if (eventType === 'TAX_INVOICE_ISSUANCE_SUCCESS') {
    db.prepare("UPDATE tax_invoices SET status = 'issued', tax_invoice_url = ?, issued_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
      .run(data.taxInvoiceUrl || null, row.id);
    audit.log({}, 'bill', row.bill_id, 'tax-invoice-issued', `Bolta reports tax invoice ${row.client_reference_id} issued`);
    res.json({ ok: true });
    // Fetch the NTS approval number afterwards; the webhook itself does not carry it. Bolta can need a moment,
    // so try a few times; if it still is not there, Refresh on the bill page fetches it later.
    const fetchNumber = (attempt) => bolta.retrieve(key).then((t) => {
      db.prepare('UPDATE tax_invoices SET nts_transaction_id = COALESCE(?, nts_transaction_id), tax_invoice_url = COALESCE(?, tax_invoice_url), issued_at = COALESCE(?, issued_at) WHERE id = ?')
        .run(t.ntsTransactionId || null, t.taxInvoiceUrl || null, t.issuedAt || null, row.id);
    }).catch((e) => {
      if (attempt < 3) setTimeout(() => fetchNumber(attempt + 1), attempt * 5000);
      else console.error('[bolta] could not fetch the NTS number for', row.client_reference_id, e.message);
    });
    fetchNumber(1);
    return;
  }
  if (eventType === 'TAX_INVOICE_ISSUANCE_FAILURE') {
    const cause = data.cause || {};
    db.prepare("UPDATE tax_invoices SET status = 'failed', failure_code = ?, failure_message = ?, updated_at = datetime('now') WHERE id = ?")
      .run(cause.code || null, cause.message || null, row.id);
    audit.log({}, 'bill', row.bill_id, 'tax-invoice-failed', `Tax invoice ${row.client_reference_id} failed: ${cause.code || ''} ${cause.message || ''}`);
    return res.json({ ok: true });
  }
  return res.json({ ok: true, ignored: 'event type' });
}

module.exports = { router, webhook };
