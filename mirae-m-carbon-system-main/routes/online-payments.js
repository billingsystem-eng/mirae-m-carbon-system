// Online payments through PayMongo's hosted checkout (GCash, cards, QR Ph, ...).
//
//   1. A client clicks "Pay online" on an issued bill -> POST /api/online-payments/bills/:id/checkout.
//      The SERVER works out the amount owed (the browser never sends one), creates a PayMongo
//      checkout session and returns its URL; the browser is redirected there to pay.
//   2. When the client pays, PayMongo calls POST /api/online-payments/webhook. That call is
//      signature-checked, de-duplicated by event id, and only then recorded as a payment on the
//      bill. The redirect back to the site is NEVER trusted as proof of payment.
//
// Configuration (.env): PAYMONGO_SECRET_KEY, PAYMONGO_WEBHOOK_SECRET, APP_BASE_URL,
// PAYMONGO_METHODS (optional), PAYMONGO_AUTO_CONFIRM (optional). See .env.example.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const audit = require('../lib/audit');
const { viewerScope } = require('../middleware/auth');
const { balanceDue, fullyPaid } = require('../lib/invoice-ready');

const router = express.Router();

const API_BASE = () => (process.env.PAYMONGO_API_BASE || 'https://api.paymongo.com').replace(/\/$/, '');
const SECRET_KEY = () => process.env.PAYMONGO_SECRET_KEY || '';
const enabled = () => !!SECRET_KEY();
const isLiveKey = () => SECRET_KEY().startsWith('sk_live_');
const methods = () => (process.env.PAYMONGO_METHODS || 'card,gcash,qrph').split(',').map((m) => m.trim()).filter(Boolean);
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const manilaToday = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------
// Start a payment
// ---------------------------------------------------------------------------------------------
router.post('/bills/:id/checkout', async (req, res) => {
  if (!enabled()) return res.status(503).json({ error: 'Online payment is not set up yet.' });

  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(Number(req.params.id));
  if (!bill) return res.status(404).json({ error: 'Bill not found.' });

  // A client login can only pay its own issued bills (same 404 as a missing bill).
  const scope = viewerScope(req);
  if (scope && (!scope.clientId || bill.client_id !== scope.clientId || bill.status !== 'issued')) {
    return res.status(404).json({ error: 'Bill not found.' });
  }
  if (bill.status !== 'issued') return res.status(400).json({ error: 'Only an issued bill can be paid online.' });

  const due = balanceDue(bill.id);
  if (due <= 0) return res.status(400).json({ error: 'Nothing is owed on this bill.' });

  const reference = `${bill.statement_no}-${crypto.randomBytes(4).toString('hex')}`;
  const base = (process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const body = {
    data: {
      attributes: {
        line_items: [{
          name: `Billing statement ${bill.statement_no}`,
          amount: Math.round(due * 100),   // PayMongo amounts are in centavos
          currency: 'PHP',
          quantity: 1
        }],
        payment_method_types: methods(),
        description: `Mirae ESP - statement ${bill.statement_no}`,
        reference_number: reference,
        success_url: `${base}/bill.html?id=${bill.id}&paid=1`,
        cancel_url: `${base}/bill.html?id=${bill.id}`,
        metadata: { bill_id: String(bill.id), statement_no: bill.statement_no }
      }
    }
  };

  let json;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    const r = await fetch(`${API_BASE()}/v2/checkout_sessions`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(SECRET_KEY() + ':').toString('base64'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: ctl.signal
    }).finally(() => clearTimeout(timer));
    json = await r.json().catch(() => ({}));
    if (!r.ok) {
      const detail = json && json.errors && json.errors[0] && json.errors[0].detail;
      console.error('[paymongo] checkout failed', r.status, JSON.stringify(json).slice(0, 500));
      return res.status(502).json({ error: 'The payment provider refused the request' + (detail ? `: ${detail}` : '.') });
    }
  } catch (e) {
    console.error('[paymongo] checkout error', e.message);
    return res.status(502).json({ error: 'Could not reach the payment provider. Please try again.' });
  }

  const session = json && json.data;
  const url = session && session.attributes && session.attributes.checkout_url;
  if (!session || !session.id || !url) {
    console.error('[paymongo] unexpected checkout response', JSON.stringify(json).slice(0, 500));
    return res.status(502).json({ error: 'The payment provider returned an unexpected response.' });
  }

  db.prepare('INSERT INTO online_payments (bill_id, reference, session_id, amount, checkout_url, created_by) VALUES (?,?,?,?,?,?)')
    .run(bill.id, reference, session.id, due, url, req.session.username);
  audit.log(req, 'bill', bill.id, 'online-payment-start', `Started online payment of ${due} (${session.id})`);
  res.json({ checkout_url: url });
});

// ---------------------------------------------------------------------------------------------
// PayMongo webhook  (mounted in server.js with the RAW body, before express.json)
// ---------------------------------------------------------------------------------------------

/** Paymongo-Signature: t=<timestamp>,te=<test hmac>,li=<live hmac>; hmac = SHA256("<t>.<raw body>"). */
function validSignature(raw, header, secret, livemode) {
  if (!header || !secret) return false;
  const parts = {};
  String(header).split(',').forEach((kv) => {
    const i = kv.indexOf('=');
    if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  });
  const theirs = livemode ? parts.li : parts.te;
  if (!parts.t || !theirs) return false;
  const mine = crypto.createHmac('sha256', secret).update(`${parts.t}.`).update(raw).digest('hex');
  const a = Buffer.from(mine, 'utf8'), b = Buffer.from(theirs, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const applyPaid = db.transaction((eventId, row, paidAmount, providerPaymentId) => {
  const fresh = db.prepare('INSERT OR IGNORE INTO webhook_events (event_id) VALUES (?)').run(eventId);
  if (!fresh.changes) return 'duplicate';
  if (row.status === 'paid') return 'already-paid';

  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(row.bill_id);
  db.prepare('INSERT INTO payments (bill_id, paid_on, amount, reference, method, created_by) VALUES (?,?,?,?,?,?)')
    .run(bill.id, manilaToday(), paidAmount, `PayMongo ${providerPaymentId || row.session_id}`, 'PayMongo online', 'paymongo');
  const due = balanceDue(bill.id);
  db.prepare('UPDATE bills SET total_due = ? WHERE id = ?').run(due, bill.id);
  if (due <= 0 && bill.status === 'issued') db.prepare('UPDATE clients SET status = ? WHERE id = ?').run('Paid', bill.client_id);
  db.prepare("UPDATE online_payments SET status = 'paid', paid_at = datetime('now'), provider_payment_id = ? WHERE id = ?")
    .run(providerPaymentId || null, row.id);

  // Optional: skip the manual finance step for gateway payments (PayMongo has already verified the money).
  if (process.env.PAYMONGO_AUTO_CONFIRM === 'true' && fullyPaid(bill.id)) {
    db.prepare("UPDATE bills SET payment_confirmed_by = 'PayMongo (automatic)', payment_confirmed_at = datetime('now') WHERE id = ?").run(bill.id);
  }
  audit.log({}, 'bill', bill.id, 'online-payment',
    `Online payment of ${paidAmount} received via PayMongo (${providerPaymentId || row.session_id})` +
    (Math.abs(paidAmount - row.amount) > 0.005 ? ` - NOTE: requested ${row.amount}` : ''));
  return 'recorded';
});

function webhook(req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  let payload;
  try { payload = JSON.parse(raw.toString('utf8')); } catch (e) { return res.status(400).json({ error: 'Invalid body.' }); }

  const event = payload && payload.data;
  const attrs = (event && event.attributes) || {};
  if (!process.env.PAYMONGO_WEBHOOK_SECRET) {
    console.error('[paymongo] webhook received but PAYMONGO_WEBHOOK_SECRET is not set');
    return res.status(503).json({ error: 'Webhook is not configured.' });
  }
  // Nothing in the payload is acted on until the signature checks out.
  if (!validSignature(raw, req.get('paymongo-signature'), process.env.PAYMONGO_WEBHOOK_SECRET, !!attrs.livemode)) {
    return res.status(400).json({ error: 'Invalid signature.' });
  }

  // Unknown event types and the wrong environment are acknowledged and ignored (an error would trigger retries).
  if (attrs.type !== 'checkout_session.payment.paid') return res.json({ ok: true, ignored: 'event type' });
  if (!!attrs.livemode !== isLiveKey()) return res.json({ ok: true, ignored: 'livemode mismatch' });

  const session = attrs.data || {};
  const sattrs = session.attributes || {};
  const row = (sattrs.reference_number && db.prepare('SELECT * FROM online_payments WHERE reference = ?').get(sattrs.reference_number))
    || (session.id && db.prepare('SELECT * FROM online_payments WHERE session_id = ?').get(session.id));
  if (!row) {
    console.error('[paymongo] paid event for an unknown checkout session', session.id, sattrs.reference_number);
    return res.json({ ok: true, ignored: 'unknown session' });
  }

  const p = Array.isArray(sattrs.payments) ? sattrs.payments[0] : null;
  const cents = p && p.attributes && Number(p.attributes.amount);
  const paidAmount = cents > 0 ? r2(cents / 100) : row.amount;

  try {
    const result = applyPaid(event.id, row, paidAmount, p && p.id);
    return res.json({ ok: true, result });
  } catch (e) {
    console.error('[paymongo] could not record payment', e);
    return res.status(500).json({ error: 'Could not record the payment.' }); // PayMongo will retry
  }
}

module.exports = { router, webhook, enabled };
