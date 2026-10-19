const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, requireRole, viewerScope, covers } = require('../middleware/auth');
const audit = require('../lib/audit');

const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Enter your username and password.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(String(username).trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'That username and password do not match.' });
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.fullName = user.full_name;
  req.session.role = user.role;
  audit.log(req, 'user', user.id, 'login', 'Signed in');
  res.json({ username: user.username, full_name: user.full_name, role: user.role });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not signed in.' });
  const scope = viewerScope(req);
  res.json({
    id: req.session.userId,
    username: req.session.username,
    full_name: req.session.fullName,
    role: req.session.role,
    client_id: scope ? scope.clientId : null,
    site_id: scope ? scope.siteId : null,
    avatar_v: (db.prepare('SELECT avatar_v FROM users WHERE id = ?').get(req.session.userId) || {}).avatar_v || 0
  });
});

router.post('/password', requireAuth, (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!new_password || new_password.length < 8) {
    return res.status(400).json({ error: 'Use a new password of at least 8 characters.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!bcrypt.compareSync(current_password || '', user.password_hash)) {
    return res.status(400).json({ error: 'Your current password is incorrect.' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 10), user.id);
  audit.log(req, 'user', user.id, 'password_change', 'Changed own password');
  res.json({ ok: true });
});

// --- User management (administrators only) ---

// The site a client login is assigned to: one of the dashboard sites on the Live monitor (the picker on the Users
// page lists those). The statements it sees are those of the billing projects linked to that site, so linking a
// project later takes effect straight away. Older logins that only have a client keep seeing that client.
// Returns { siteId, siteName } or { error }.
async function resolveSite(site_id, site_name) {
  if (!site_id) return { siteId: null, siteName: null };
  const id = String(site_id);
  let name = String(site_name || '').trim() || null;
  try {
    const list = await require('./monitor').listSites();
    const hit = list.find((s) => String(s.id) === id);
    if (!hit) return { error: 'That site does not exist.' };
    name = hit.name;
  } catch (e) { /* the dashboard can't be reached right now: keep the id and the name the page sent */ }
  return { siteId: id, siteName: name };
}

router.get('/users', requireRole('admin'), (req, res) => {
  // statement_count: the statements this login is looking at (everything but voided; staff see every stage).
  const rows = db.prepare(`SELECT u.id, u.username, u.full_name, u.role, u.active, u.created_at, u.client_id, u.project_id, u.site_id, u.email, u.avatar_v,
      c.name AS client_name, u.site_name,
      (SELECT COUNT(*) FROM bills b WHERE b.status != 'void' AND ${covers()}) AS statement_count
    FROM users u LEFT JOIN clients c ON c.id = u.client_id
    ORDER BY u.username`).all();
  res.json(rows);
});

router.post('/users', requireRole('admin'), async (req, res) => {
  try {
    const { username, full_name, role, password, site_id, site_name, email } = req.body || {};
    const mail = String(email || '').trim();
    if (mail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (!username || !full_name || !password) {
      return res.status(400).json({ error: 'Username, full name and password are required.' });
    }
    if (password.length < 8) return res.status(400).json({ error: 'Use a password of at least 8 characters.' });
    if (!['admin', 'billing_officer', 'finance_hr', 'viewer'].includes(role)) {
      return res.status(400).json({ error: 'Pick a valid role.' });
    }
    let site = { siteId: null, siteName: null };
    if (role === 'viewer') {
      site = await resolveSite(site_id, site_name);
      if (site.error) return res.status(400).json({ error: site.error });
    }
    try {
      const info = db
        .prepare('INSERT INTO users (username, password_hash, full_name, role, site_id, site_name, email) VALUES (?,?,?,?,?,?,?)')
        .run(username.trim(), bcrypt.hashSync(password, 10), full_name.trim(), role, site.siteId, site.siteName, mail || null);
      audit.log(req, 'user', info.lastInsertRowid, 'create', `Created user ${username} (${role})` + (site.siteId ? ` for site ${site.siteName || site.siteId}` : ''));
      res.json({ id: info.lastInsertRowid });
    } catch (e) {
      res.status(400).json({ error: 'That username is already taken.' });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'The server could not complete that request.' });
  }
});

router.patch('/users/:id', requireRole('admin'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { full_name, role, active, password, site_id, site_name, email } = req.body || {};
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (id === req.session.userId && active === 0) {
      return res.status(400).json({ error: 'You cannot deactivate your own account.' });
    }
    let mail = user.email;
    if (email !== undefined) {
      mail = String(email || '').trim() || null;
      if (mail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if (role !== undefined && !['admin', 'billing_officer', 'finance_hr', 'viewer'].includes(role)) {
      return res.status(400).json({ error: 'Pick a valid role.' });
    }
    if (password && password.length < 8) return res.status(400).json({ error: 'Use a password of at least 8 characters.' });
    const newRole = role ?? user.role;
    let clientId = user.client_id, projectId = user.project_id, siteId = user.site_id, siteName = user.site_name;
    if (newRole !== 'viewer') {
      clientId = null; projectId = null; siteId = null; siteName = null;   // only client logins are tied to a site
    } else if (site_id !== undefined) {
      const site = await resolveSite(site_id, site_name);
      if (site.error) return res.status(400).json({ error: site.error });
      siteId = site.siteId; siteName = site.siteName;
      clientId = null; projectId = null;                                     // the site replaces any older client / project assignment
    }
    db.prepare('UPDATE users SET full_name = ?, role = ?, active = ?, client_id = ?, project_id = ?, site_id = ?, site_name = ?, email = ? WHERE id = ?').run(
      full_name ?? user.full_name,
      newRole,
      active === undefined ? user.active : active ? 1 : 0,
      clientId, projectId, siteId, siteName,
      mail,
      id
    );
    if (password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), id);
    audit.log(req, 'user', id, 'update', `Updated user ${user.username}` + (site_id !== undefined ? ` (site ${siteId ? (siteName || siteId) : 'cleared'})` : ''));
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'The server could not complete that request.' });
  }
});

router.delete('/users/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (id === req.session.userId) return res.status(400).json({ error: 'You cannot delete your own account.' });
  if (user.role === 'admin' && user.active &&
      db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'admin' AND active = 1 AND id != ?").get(id).c === 0) {
    return res.status(400).json({ error: 'You cannot delete the last active administrator.' });
  }
  try {
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  } catch (e) {
    return res.status(400).json({ error: 'This user can’t be deleted because other records depend on it. Deactivate the account instead.' });
  }
  audit.log(req, 'user', id, 'delete', `Deleted user ${user.username} (${user.role})`);
  res.json({ ok: true });
});

module.exports = router;
