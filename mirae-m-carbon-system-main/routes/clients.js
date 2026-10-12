const express = require('express');
const db = require('../db');
// Clients and projects are set up by administrators only. Billing officers
// can view them (and bill against them) but cannot create, edit or delete.
const { requireRole, viewerScope, notViewer } = require('../middleware/auth');
const canEdit = requireRole('admin');
const audit = require('../lib/audit');
const notify = require('../lib/notify');

const router = express.Router();

const CLIENT_FIELDS = [
  'account_no', 'name', 'tin', 'status',
  'addr_unit', 'addr_building', 'addr_street', 'addr_barangay',
  'addr_city', 'addr_region', 'addr_country', 'addr_zip', 'notes'
];

const STATUSES = [
  'Ongoing Data Collection', 'Billed', 'Paid', 'Overdue', 'Suspended', 'Project Complete'
];

router.get('/', (req, res) => {
  try { notify.syncClientStatus(); } catch (e) { console.error('[status]', e); } // never show a stale Billed/Overdue
  const q = (req.query.q || '').trim();
  const status = (req.query.status || '').trim();
  let sql = `SELECT c.*,
      (SELECT COUNT(*) FROM projects p WHERE p.client_id = c.id) AS project_count,
      (SELECT COUNT(*) FROM bills b WHERE b.client_id = c.id) AS bill_count
    FROM clients c WHERE 1=1`;
  const args = [];
  const scope = viewerScope(req);
  if (scope) { sql += ' AND c.id = ?'; args.push(scope.clientId || 0); }
  if (q) { sql += ' AND (c.name LIKE ? OR c.account_no LIKE ?)'; args.push(`%${q}%`, `%${q}%`); }
  if (status) { sql += ' AND c.status = ?'; args.push(status); }
  sql += ' ORDER BY c.name';
  res.json({ statuses: STATUSES, clients: db.prepare(sql).all(...args) });
});

router.get('/:id', notViewer, (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found.' });
  client.contacts = db.prepare('SELECT * FROM contacts WHERE client_id = ? ORDER BY is_primary DESC, name').all(client.id);
  client.projects = db.prepare('SELECT * FROM projects WHERE client_id = ? ORDER BY name').all(client.id);
  for (const p of client.projects) {
    p.contract = db.prepare('SELECT * FROM contracts WHERE project_id = ?').get(p.id) || null;
    p.devices = db.prepare('SELECT * FROM devices WHERE project_id = ?').all(p.id);
  }
  res.json(client);
});

router.post('/', canEdit, (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.account_no) {
    return res.status(400).json({ error: 'A client name and account number are required.' });
  }
  const defaults = { status: STATUSES[0], addr_country: 'South Korea' };
  const cols = CLIENT_FIELDS.join(',');
  const marks = CLIENT_FIELDS.map(() => '?').join(',');
  try {
    const info = db.prepare(`INSERT INTO clients (${cols}) VALUES (${marks})`)
      .run(...CLIENT_FIELDS.map((f) => b[f] || defaults[f] || null));
    audit.log(req, 'client', info.lastInsertRowid, 'create', `Created client ${b.name}`);
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(400).json({ error: 'That account number is already in use.' });
    }
    console.error(e);
    res.status(400).json({ error: 'The client could not be saved. Check the details and try again.' });
  }
});

router.patch('/:id', canEdit, (req, res) => {
  const existing = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Client not found.' });
  const b = req.body || {};
  const set = CLIENT_FIELDS.map((f) => `${f} = ?`).join(', ');
  db.prepare(`UPDATE clients SET ${set} WHERE id = ?`)
    .run(...CLIENT_FIELDS.map((f) => (b[f] === undefined ? existing[f] : b[f])), existing.id);
  audit.log(req, 'client', existing.id, 'update', `Updated client ${existing.name}`);
  res.json({ ok: true });
});

router.delete('/:id', canEdit, (req, res) => {
  const bills = db.prepare('SELECT COUNT(*) c FROM bills WHERE client_id = ?').get(req.params.id).c;
  if (bills) return res.status(400).json({ error: 'This client has billing records and cannot be deleted.' });
  db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
  audit.log(req, 'client', Number(req.params.id), 'delete', 'Deleted client');
  res.json({ ok: true });
});

// --- Contacts ---

router.post('/:id/contacts', canEdit, (req, res) => {
  const { name, position, phone, email, is_primary } = req.body || {};
  if (!name) return res.status(400).json({ error: 'A contact name is required.' });
  if (is_primary) db.prepare('UPDATE contacts SET is_primary = 0 WHERE client_id = ?').run(req.params.id);
  const info = db.prepare(
    'INSERT INTO contacts (client_id, name, position, phone, email, is_primary) VALUES (?,?,?,?,?,?)'
  ).run(req.params.id, name, position || null, phone || null, email || null, is_primary ? 1 : 0);
  audit.log(req, 'client', Number(req.params.id), 'contact_add', `Added contact ${name}`);
  res.json({ id: info.lastInsertRowid });
});

router.delete('/:id/contacts/:contactId', canEdit, (req, res) => {
  db.prepare('DELETE FROM contacts WHERE id = ? AND client_id = ?').run(req.params.contactId, req.params.id);
  audit.log(req, 'client', Number(req.params.id), 'contact_remove', `Removed contact ${req.params.contactId}`);
  res.json({ ok: true });
});

module.exports = router;
module.exports.STATUSES = STATUSES; // reused by the dashboard's account-status chart