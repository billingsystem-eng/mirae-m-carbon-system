const express = require('express');
const db = require('../db');
// Clients and projects are set up by administrators only. Billing officers
// can view them (and bill against them) but cannot create, edit or delete.
const { requireRole, viewerScope, notViewer } = require('../middleware/auth');
const canEdit = requireRole('admin');
const audit = require('../lib/audit');
const dashboard = require('../lib/dashboard');

const router = express.Router();

const PROJECT_FIELDS = [
  'name', 'address', 'lighting_type', 'lighting_qty', 'operating_brightness', 'saving_brightness'
];
const CONTRACT_FIELDS = [
  'start_date', 'end_date', 'late_interest_rate', 'settlement_day', 'bill_day',
  'payment_terms_days', 'baseline_method', 'dashboard_daily_baseline', 'agreed_savings_pct'
];

const LIGHTING_TYPES = ['T8 with IoT', 'T8 Always On', 'T5 Always On', 'Bulb Always On'];

function loadProject(id) {
  const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!p) return null;
  p.client = db.prepare('SELECT * FROM clients WHERE id = ?').get(p.client_id);
  p.devices = db.prepare('SELECT * FROM devices WHERE project_id = ?').all(p.id);
  p.contract = db.prepare('SELECT * FROM contracts WHERE project_id = ?').get(p.id) || null;
  if (p.contract) {
    p.contract.rates = db.prepare('SELECT * FROM rates WHERE contract_id = ? ORDER BY id').all(p.contract.id);
    p.contract.sharing_ratios = db
      .prepare('SELECT * FROM sharing_ratios WHERE contract_id = ? ORDER BY effective_from')
      .all(p.contract.id);
  }
  return p;
}

router.get('/', (req, res) => {
  const scope = viewerScope(req);
  const rows = db.prepare(`
    SELECT p.*, c.name AS client_name, c.account_no
    FROM projects p JOIN clients c ON c.id = p.client_id
    ${scope ? 'WHERE p.client_id = ' + Number(scope.clientId || 0) : ''}
    ORDER BY c.name, p.name`).all();
  res.json({ lighting_types: LIGHTING_TYPES, projects: rows });
});

// --- M-Carbon Dashboard link (Section 5 of the scope) ---

// Every project visible on the dashboard, for the "link this project" picker.
router.get('/dashboard/list', canEdit, async (req, res) => {
  try {
    const projects = await dashboard.listProjects();
    res.json({ projects });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'Could not reach the M-Carbon Dashboard: ' + e.message });
  }
});

router.get('/:id', notViewer, (req, res) => {
  const p = loadProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  res.json(p);
});

router.patch('/:id/link-dashboard', canEdit, async (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  const familyId = req.body?.family_id ? String(req.body.family_id) : null;

  if (!familyId) {
    db.prepare('UPDATE projects SET family_id = NULL, family_id_name = NULL, family_id_district = NULL WHERE id = ?')
      .run(project.id);
    audit.log(req, 'project', project.id, 'dashboard_link', 'Unlinked from the dashboard');
    return res.json({ ok: true });
  }

  // Resolve the family_id against the dashboard's own project list rather than
  // trusting whatever the client sent — this is what stops a project ever being
  // linked to a family_id that doesn't exist, or a name that doesn't match what
  // the dashboard actually calls that site.
  let match;
  try {
    const all = await dashboard.listProjects();
    match = all.find((p) => String(p.family_id) === familyId);
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: 'Could not reach the M-Carbon Dashboard to verify that project: ' + e.message });
  }
  if (!match) {
    return res.status(400).json({ error: `Dashboard project ${familyId} was not found. It may have been renamed or removed — try "Choose dashboard project" again.` });
  }

  db.prepare('UPDATE projects SET family_id = ?, family_id_name = ?, family_id_district = ? WHERE id = ?')
    .run(familyId, match.name, match.district || null, project.id);
  audit.log(req, 'project', project.id, 'dashboard_link',
    `Linked to dashboard project ${familyId} (${match.name}, ${match.district || 'no district'})`);
  res.json({ ok: true, name: match.name, district: match.district || null });
});

router.post('/', canEdit, (req, res) => {
  const b = req.body || {};
  if (!b.client_id || !b.name) return res.status(400).json({ error: 'A client and project name are required.' });
  const info = db.prepare(
    `INSERT INTO projects (client_id, ${PROJECT_FIELDS.join(',')}) VALUES (?, ${PROJECT_FIELDS.map(() => '?').join(',')})`
  ).run(b.client_id, ...PROJECT_FIELDS.map((f) => b[f] ?? null));
  // Every project gets a billing configuration straight away.
  db.prepare('INSERT INTO contracts (project_id) VALUES (?)').run(info.lastInsertRowid);
  audit.log(req, 'project', info.lastInsertRowid, 'create', `Created project ${b.name}`);
  res.json({ id: info.lastInsertRowid });
});

router.patch('/:id', canEdit, (req, res) => {
  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Project not found.' });
  const b = req.body || {};
  db.prepare(`UPDATE projects SET ${PROJECT_FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`)
    .run(...PROJECT_FIELDS.map((f) => (b[f] === undefined ? existing[f] : b[f])), existing.id);
  audit.log(req, 'project', existing.id, 'update', `Updated project ${existing.name}`);
  res.json({ ok: true });
});

router.delete('/:id', canEdit, (req, res) => {
  const bills = db.prepare('SELECT COUNT(*) c FROM bills WHERE project_id = ?').get(req.params.id).c;
  if (bills) return res.status(400).json({ error: 'This project has billing records and cannot be deleted.' });
  db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  audit.log(req, 'project', Number(req.params.id), 'delete', 'Deleted project');
  res.json({ ok: true });
});

// --- Devices ---

router.post('/:id/devices', canEdit, (req, res) => {
  const { device_type, device_no } = req.body || {};
  if (!device_no) return res.status(400).json({ error: 'A device ID or number is required.' });
  const info = db.prepare('INSERT INTO devices (project_id, device_type, device_no) VALUES (?,?,?)')
    .run(req.params.id, device_type || null, device_no);
  audit.log(req, 'project', Number(req.params.id), 'device_add', `Added device ${device_no}`);
  res.json({ id: info.lastInsertRowid });
});

router.delete('/:id/devices/:deviceId', canEdit, (req, res) => {
  db.prepare('DELETE FROM devices WHERE id = ? AND project_id = ?').run(req.params.deviceId, req.params.id);
  audit.log(req, 'project', Number(req.params.id), 'device_remove', `Removed device ${req.params.deviceId}`);
  res.json({ ok: true });
});

// --- Contract / billing configuration ---

router.put('/:id/contract', canEdit, (req, res) => {
  let contract = db.prepare('SELECT * FROM contracts WHERE project_id = ?').get(req.params.id);
  if (!contract) {
    const info = db.prepare('INSERT INTO contracts (project_id) VALUES (?)').run(req.params.id);
    contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(info.lastInsertRowid);
  }
  const b = req.body || {};
  db.prepare(`UPDATE contracts SET ${CONTRACT_FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`)
    .run(...CONTRACT_FIELDS.map((f) => (b[f] === undefined || b[f] === '' ? contract[f] : b[f])), contract.id);
  audit.log(req, 'contract', contract.id, 'update', b);
  res.json({ ok: true });
});

// --- Electricity rates ---

router.post('/:id/rates', canEdit, (req, res) => {
  const contract = db.prepare('SELECT * FROM contracts WHERE project_id = ?').get(req.params.id);
  if (!contract) return res.status(400).json({ error: 'Set up the billing configuration first.' });
  const { label, rate, time_from, time_to, effective_from, effective_to } = req.body || {};
  if (!label || rate === undefined || rate === '') {
    return res.status(400).json({ error: 'A rate label and amount are required.' });
  }
  const info = db.prepare(
    'INSERT INTO rates (contract_id, label, rate, time_from, time_to, effective_from, effective_to) VALUES (?,?,?,?,?,?,?)'
  ).run(contract.id, label, Number(rate), time_from || null, time_to || null, effective_from || null, effective_to || null);
  audit.log(req, 'contract', contract.id, 'rate_add', `Added rate ${label} at ${rate}`);
  res.json({ id: info.lastInsertRowid });
});

router.delete('/:id/rates/:rateId', canEdit, (req, res) => {
  const contract = db.prepare('SELECT * FROM contracts WHERE project_id = ?').get(req.params.id);
  db.prepare('DELETE FROM rates WHERE id = ? AND contract_id = ?').run(req.params.rateId, contract?.id ?? 0);
  audit.log(req, 'contract', contract?.id, 'rate_remove', `Removed rate ${req.params.rateId}`);
  res.json({ ok: true });
});

// --- Sharing ratios ---

router.post('/:id/sharing', canEdit, (req, res) => {
  const contract = db.prepare('SELECT * FROM contracts WHERE project_id = ?').get(req.params.id);
  if (!contract) return res.status(400).json({ error: 'Set up the billing configuration first.' });
  const { label, effective_from, effective_to, ines_pct, client_pct } = req.body || {};
  if (!effective_from || ines_pct === undefined || client_pct === undefined) {
    return res.status(400).json({ error: 'An effective date and both share percentages are required.' });
  }
  const info = db.prepare(
    'INSERT INTO sharing_ratios (contract_id, label, effective_from, effective_to, ines_pct, client_pct) VALUES (?,?,?,?,?,?)'
  ).run(contract.id, label || null, effective_from, effective_to || null, Number(ines_pct), Number(client_pct));
  audit.log(req, 'contract', contract.id, 'sharing_add', `Added ratio ${ines_pct}/${client_pct} from ${effective_from}`);
  res.json({ id: info.lastInsertRowid });
});

router.delete('/:id/sharing/:ratioId', canEdit, (req, res) => {
  const contract = db.prepare('SELECT * FROM contracts WHERE project_id = ?').get(req.params.id);
  db.prepare('DELETE FROM sharing_ratios WHERE id = ? AND contract_id = ?').run(req.params.ratioId, contract?.id ?? 0);
  audit.log(req, 'contract', contract?.id, 'sharing_remove', `Removed ratio ${req.params.ratioId}`);
  res.json({ ok: true });
});

module.exports = router;