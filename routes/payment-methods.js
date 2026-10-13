const express = require('express');
const db = require('../db');
const { canEdit, requireRole } = require('../middleware/auth');
const adminOnly = requireRole('admin');
const audit = require('../lib/audit');

const router = express.Router();

// Anyone signed in can read (the statement page needs them); admins and billing
// officers can add/change them. A method only prints on statements once an
// ADMIN has approved it. Billing officers' additions/edits go back to pending.

const text = (v, max) => String(v ?? '').trim().slice(0, max);

router.get('/', (req, res) => {
  // Only APPROVED methods appear for everyone except admins. Admins also see
  // pending ones, since they are the only people who can approve them.
  // ?active=1 (used by statements) is always active AND approved, even for admins.
  const conds = [];
  if (req.query.active === '1') conds.push('active = 1');
  if (req.query.active === '1' || req.session.role !== 'admin') conds.push("approval_status = 'approved'");
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  res.json(db.prepare(
    `SELECT id, name, details, active, approval_status, approved_by, approved_at, created_by
       FROM payment_methods ${where} ORDER BY id`).all());
});

router.post('/', canEdit, (req, res) => {
  const name = text(req.body?.name, 120);
  if (!name) return res.status(400).json({ error: 'A payment method name is required.' });
  const details = text(req.body?.details, 600);
  const isAdmin = req.session.role === 'admin';
  const who = req.session.fullName || req.session.username || null;
  const info = db.prepare(
    `INSERT INTO payment_methods (name, details, approval_status, approved_by, approved_at, created_by)
     VALUES (?, ?, ?, ?, ${isAdmin ? "datetime('now')" : 'NULL'}, ?)`
  ).run(name, details || null, isAdmin ? 'approved' : 'pending', isAdmin ? who : null, who);
  audit.log(req, 'payment_method', info.lastInsertRowid, 'create',
    `Added payment method "${name}"${isAdmin ? ' (approved)' : ' (pending approval)'}`);
  res.status(201).json(db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(info.lastInsertRowid));
});

router.put('/:id', canEdit, (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ error: 'Payment method not found.' });

  const b = req.body || {};
  const name = b.name !== undefined ? text(b.name, 120) : cur.name;
  if (!name) return res.status(400).json({ error: 'A payment method name is required.' });
  const details = b.details !== undefined ? text(b.details, 600) : cur.details;
  const active = b.active !== undefined ? (b.active ? 1 : 0) : cur.active;

  db.prepare('UPDATE payment_methods SET name = ?, details = ?, active = ? WHERE id = ?')
    .run(name, details || null, active, id);

  // A non-admin changing the content of an approved method sends it back for approval.
  const contentChanged = name !== cur.name || (details || null) !== (cur.details || null);
  if (contentChanged && req.session.role !== 'admin' && cur.approval_status === 'approved') {
    db.prepare("UPDATE payment_methods SET approval_status = 'pending', approved_by = NULL, approved_at = NULL WHERE id = ?").run(id);
    audit.log(req, 'payment_method', id, 'approval_reset', `Edited \"${name}\" — needs admin re-approval`);
  }
  const what = b.active !== undefined && b.active !== !!cur.active
    ? (active ? 'reactivate' : 'deactivate') : 'update';
  audit.log(req, 'payment_method', id, what, `${what === 'update' ? 'Updated' : what === 'deactivate' ? 'Deactivated' : 'Reactivated'} payment method "${name}"`);
  res.json(db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(id));
});

// Admin-only: approve or revoke approval. Never reachable by billing officers/viewers.
router.post('/:id/approve', adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ error: 'Payment method not found.' });
  db.prepare("UPDATE payment_methods SET approval_status = 'approved', approved_by = ?, approved_at = datetime('now') WHERE id = ?")
    .run(req.session.fullName || req.session.username, id);
  audit.log(req, 'payment_method', id, 'approve', `Approved payment method \"${cur.name}\"`);
  res.json(db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(id));
});

router.post('/:id/revoke', adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ error: 'Payment method not found.' });
  db.prepare("UPDATE payment_methods SET approval_status = 'pending', approved_by = NULL, approved_at = NULL WHERE id = ?").run(id);
  audit.log(req, 'payment_method', id, 'revoke', `Revoked approval of payment method \"${cur.name}\"`);
  res.json(db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(id));
});

router.delete('/:id', canEdit, (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM payment_methods WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ error: 'Payment method not found.' });
  db.prepare('DELETE FROM payment_methods WHERE id = ?').run(id);
  audit.log(req, 'payment_method', id, 'delete', `Deleted payment method "${cur.name}"`);
  res.json({ ok: true });
});

module.exports = router;