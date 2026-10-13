const express = require('express');
const db = require('../db');
const audit = require('../lib/audit');
const { requireRole } = require('../middleware/auth');
const { buildPayload, issueTaxInvoice } = require('../lib/bolta');

const router = express.Router();
const canIssue = requireRole('admin', 'billing_officer', 'finance_hr');

// POST /api/bolta/bills/:id/tax-invoice  - send a final/issued bill to Bolta as a tax invoice
router.post('/bills/:id/tax-invoice', canIssue, async (req, res) => {
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id);
  if (!bill) return res.status(404).json({ error: 'Bill not found.' });
  if (!['final', 'issued'].includes(bill.status)) {
    return res.status(400).json({ error: 'Only final or issued bills can get a tax invoice.' });
  }
  if (bill.bolta_issuance_key && bill.tax_invoice_status !== 'failed') {
    return res.status(409).json({ error: 'A tax invoice was already requested for this bill.', issuanceKey: bill.bolta_issuance_key });
  }
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(bill.client_id);
  const contact = db.prepare("SELECT email FROM contacts WHERE client_id = ? AND email IS NOT NULL AND email != '' ORDER BY is_primary DESC, id LIMIT 1").get(bill.client_id);

  const missing = [];
  if (!process.env.SUPPLIER_BRN) missing.push('SUPPLIER_BRN (server setting)');
  if (!process.env.SUPPLIER_REP) missing.push('SUPPLIER_REP (server setting)');
  if (!process.env.SUPPLIER_EMAIL) missing.push('SUPPLIER_EMAIL (server setting)');
  if (!client.tin) missing.push('client business registration number (TIN field)');
  if (!client.representative_name) missing.push('client representative name');
  if (!contact) missing.push('client contact email');
  if (!(Number(bill.amount_billed) > 0)) missing.push('amount billed');
  if (missing.length) return res.status(400).json({ error: 'Missing: ' + missing.join(', ') });

  const attempt = (bill.tax_invoice_attempts || 0) + 1;
  const refId = `mirae-bill-${bill.id}-${attempt}`;
  try {
    const out = await issueTaxInvoice(buildPayload(bill, client, contact), refId);
    db.prepare(`UPDATE bills SET bolta_issuance_key = ?, bolta_ref_id = ?, tax_invoice_status = 'requested',
                tax_invoice_error = NULL, tax_invoice_attempts = ?, tax_invoice_at = datetime('now') WHERE id = ?`)
      .run(out.issuanceKey, refId, attempt, bill.id);
    audit.log(req, 'bill', bill.id, 'tax_invoice_requested', { refId, issuanceKey: out.issuanceKey });
    res.json({ ok: true, status: 'requested', issuanceKey: out.issuanceKey });
  } catch (e) {
    db.prepare(`UPDATE bills SET tax_invoice_status = 'failed', tax_invoice_error = ?, tax_invoice_attempts = ?, bolta_ref_id = ? WHERE id = ?`)
      .run(JSON.stringify(e.detail || e.message).slice(0, 1000), attempt, refId, bill.id);
    audit.log(req, 'bill', bill.id, 'tax_invoice_failed', { refId, error: e.detail || e.message });
    res.status(502).json({ error: e.message, detail: e.detail });
  }
});

// GET /api/bolta/bills/:id/tax-invoice - current status of that bill's tax invoice
router.get('/bills/:id/tax-invoice', (req, res) => {
  const b = db.prepare(`SELECT bolta_issuance_key, bolta_ref_id, tax_invoice_status, tax_invoice_error, tax_invoice_at, tax_invoice_last_event
                        FROM bills WHERE id = ?`).get(req.params.id);
  if (!b) return res.status(404).json({ error: 'Bill not found.' });
  res.json(b);
});

// Webhook from Bolta. Mounted BEFORE express.json and without a session; the secret in the URL path authenticates it.
function webhook(req, res) {
  if (!process.env.BOLTA_WEBHOOK_SECRET || req.params.secret !== process.env.BOLTA_WEBHOOK_SECRET) return res.sendStatus(404);
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
  console.log('[bolta webhook] headers:', JSON.stringify(req.headers));
  console.log('[bolta webhook] body:', raw);

  db.prepare('INSERT INTO bolta_events (headers_json, body) VALUES (?, ?)').run(JSON.stringify(req.headers), raw.slice(0, 20000));

  // Find an issuanceKey anywhere in the payload and link it to a bill. The payload format hasn't been confirmed yet,
  // so this only records that an event arrived; read the stored body to see the real result.
  try {
    const found = [];
    (function walk(v) {
      if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => { if (k === 'issuanceKey' && typeof x === 'string') found.push(x); else walk(x); });
    })(JSON.parse(raw));
    for (const key of found) {
      db.prepare(`UPDATE bills SET tax_invoice_last_event = ?, tax_invoice_status = CASE WHEN tax_invoice_status = 'requested' THEN 'event_received' ELSE tax_invoice_status END
                  WHERE bolta_issuance_key = ?`).run(raw.slice(0, 4000), key);
    }
  } catch (e) { /* not JSON - already stored raw */ }
  res.sendStatus(200); // always acknowledge quickly
}

module.exports = { router, webhook };
