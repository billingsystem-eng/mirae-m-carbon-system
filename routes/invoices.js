// Scanned copies of the Sales Invoice, attached to a bill or a quotation once it has been paid.
// Files are stored on disk under DATA_DIR/uploads/invoices; the database keeps only the record.
// Upload is a plain binary POST (no extra packages): the browser sends the file as the request
// body with the original name in the X-Filename header.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { randomUUID: uuid } = require('crypto'); // built in; the uuid package is ESM-only in v12+ and can't be require()d on Node 18
const db = require('../db');
const { requireRole, notViewer } = require('../middleware/auth');
const audit = require('../lib/audit');

const router = express.Router();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DIR = path.join(DATA_DIR, 'uploads', 'invoices');
fs.mkdirSync(DIR, { recursive: true });

const MAX_BYTES = 15 * 1024 * 1024;
const TYPES = {
  'application/pdf': { ext: '.pdf', magic: (b) => b.slice(0, 5).toString('latin1') === '%PDF-' },
  'image/jpeg': { ext: '.jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: '.png', magic: (b) => b.slice(1, 4).toString('latin1') === 'PNG' }
};
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** { ok, reason } — may a Sales Invoice be attached to this record yet? */
function eligibility(entity, id) {
  if (entity === 'bill') {
    const b = db.prepare('SELECT * FROM bills WHERE id = ?').get(id);
    if (!b) return { missing: true };
    const paid = db.prepare('SELECT COALESCE(SUM(amount),0) s, COUNT(*) n FROM payments WHERE bill_id = ?').get(id);
    const adj = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM adjustments WHERE bill_id = ?').get(id).s;
    const due = r2(b.amount_billed + b.previous_balance + b.interest_charged + adj - paid.s);
    if (b.status !== 'issued') return { ok: false, label: b.statement_no, reason: 'The bill must be issued and paid before a Sales Invoice can be attached.' };
    if (!paid.n || due > 0) return { ok: false, label: b.statement_no, reason: 'Record the full payment on this bill first — the Sales Invoice can be attached once nothing is owed.' };
    return { ok: true, label: b.statement_no };
  }
  if (entity === 'quotation') {
    const q = db.prepare('SELECT * FROM quotations WHERE id = ?').get(id);
    if (!q) return { missing: true };
    if (q.status !== 'paid') return { ok: false, label: q.quote_no, reason: 'Set the quotation status to Paid before attaching the Sales Invoice.' };
    return { ok: true, label: q.quote_no };
  }
  return { missing: true };
}

const list = (entity, id) => db.prepare(
  'SELECT id, original_name, mime, size, uploaded_by, uploaded_at FROM invoice_files WHERE entity = ? AND entity_id = ? ORDER BY id DESC'
).all(entity, id);

// Download one file (staff only — client logins don't see internal invoice scans).
router.get('/file/:fileId', notViewer, (req, res) => {
  const f = db.prepare('SELECT * FROM invoice_files WHERE id = ?').get(Number(req.params.fileId));
  const full = f && path.join(DIR, path.basename(f.stored_name));
  if (!f || !fs.existsSync(full)) return res.status(404).json({ error: 'File not found.' });
  res.setHeader('Content-Type', f.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(f.original_name)}`);
  res.sendFile(full);
});

router.delete('/file/:fileId', requireRole('admin'), (req, res) => {
  const f = db.prepare('SELECT * FROM invoice_files WHERE id = ?').get(Number(req.params.fileId));
  if (!f) return res.status(404).json({ error: 'File not found.' });
  db.prepare('DELETE FROM invoice_files WHERE id = ?').run(f.id);
  fs.promises.unlink(path.join(DIR, path.basename(f.stored_name))).catch(() => {});
  audit.log(req, f.entity, f.entity_id, 'invoice-remove', `Removed Sales Invoice scan ${f.original_name}`);
  res.json({ ok: true });
});

// List the files for a bill / quotation and say whether one can be uploaded yet.
router.get('/:entity/:id', notViewer, (req, res) => {
  const id = Number(req.params.id), e = eligibility(req.params.entity, id);
  if (e.missing) return res.status(404).json({ error: 'Record not found.' });
  res.json({ can_upload: !!e.ok && ['admin', 'billing_officer'].includes(req.session.role), eligible: !!e.ok, reason: e.reason || '', files: list(req.params.entity, id) });
});

router.post('/:entity/:id', requireRole('admin', 'billing_officer'),
  express.raw({ type: () => true, limit: MAX_BYTES }), (req, res) => {
    const entity = req.params.entity, id = Number(req.params.id), e = eligibility(entity, id);
    if (e.missing) return res.status(404).json({ error: 'Record not found.' });
    if (!e.ok) return res.status(400).json({ error: e.reason });
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const type = TYPES[mime];
    const buf = req.body;
    if (!type || !Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'Upload the scanned invoice as a PDF, JPG or PNG file.' });
    if (!type.magic(buf)) return res.status(400).json({ error: 'That file doesn’t look like a valid ' + type.ext.slice(1).toUpperCase() + '.' });
    let name = '';
    try { name = decodeURIComponent(String(req.headers['x-filename'] || '')); } catch (_) { /* keep blank */ }
    name = path.basename(name).replace(/[\r\n"]/g, '').slice(0, 150) || ('sales-invoice' + type.ext);
    const stored = uuid() + type.ext;
    fs.writeFileSync(path.join(DIR, stored), buf);
    const info = db.prepare('INSERT INTO invoice_files (entity, entity_id, original_name, stored_name, mime, size, uploaded_by) VALUES (?,?,?,?,?,?,?)')
      .run(entity, id, name, stored, mime, buf.length, req.session.username || null);
    audit.log(req, entity, id, 'invoice-upload', `Attached Sales Invoice scan ${name} to ${e.label}`);
    res.status(201).json({ id: info.lastInsertRowid, files: list(entity, id) });
  });

module.exports = router;