function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ error: 'Sign in to continue.' });
}

/** requireRole('admin') or requireRole('admin', 'billing_officer') */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Sign in to continue.' });
    }
    if (!roles.includes(req.session.role)) {
      return res.status(403).json({ error: 'Your role does not allow this action.' });
    }
    next();
  };
}

/** For a viewer (client login) returns { siteId, projectIds, clientId }.
 *  siteId     the dashboard site (live monitor site) the login is assigned to, or null.
 *  projectIds the billing projects whose statements it may see: those linked to that site (projects.family_id).
 *             null means "no site, use the whole client" (logins made before sites existed).
 *  clientId   the client those projects belong to (used for quotations); null if there is none.
 *  Returns null for every other role. Read from the database each time so a change of assignment by an
 *  admin applies immediately, without the viewer signing in again. */
function viewerScope(req) {
  if (!req.session || req.session.role !== 'viewer') return null;
  const db = require('../db');
  const row = db.prepare('SELECT client_id, project_id, site_id FROM users WHERE id = ? AND active = 1').get(req.session.userId);
  if (!row) return { siteId: null, projectIds: [], clientId: null };
  if (row.site_id) {
    const ps = db.prepare('SELECT id, client_id FROM projects WHERE family_id = ? ORDER BY id').all(row.site_id);
    return { siteId: row.site_id, projectIds: ps.map((p) => p.id), clientId: ps.length ? ps[0].client_id : null };
  }
  if (row.project_id) {
    const p = db.prepare('SELECT id, client_id FROM projects WHERE id = ?').get(row.project_id);
    return { siteId: null, projectIds: p ? [p.id] : [], clientId: p ? p.client_id : null };
  }
  return { siteId: null, projectIds: null, clientId: row.client_id };
}

/** True when a viewer's scope covers this bill (needs bill.client_id and bill.project_id). */
function ownsBill(scope, bill) {
  if (!scope || !bill) return false;
  if (scope.projectIds) return scope.projectIds.includes(bill.project_id);
  return !!scope.clientId && bill.client_id === scope.clientId;
}

/** SQL fragment (starts with AND) limiting `alias` (a bills table alias) to what this viewer may see. */
function billScopeSql(scope, alias = 'b') {
  if (scope.projectIds) return scope.projectIds.length ? ` AND ${alias}.project_id IN (${scope.projectIds.map(Number).join(',')})` : ' AND 0';
  return scope.clientId ? ` AND ${alias}.client_id = ${Number(scope.clientId)}` : ' AND 0';
}

/** SQL condition: client login `u` is entitled to bill `b` (both are table aliases). Used to find who to notify. */
const covers = (u = 'u', b = 'b') => `((${u}.site_id IS NOT NULL AND ${u}.site_id = (SELECT family_id FROM projects WHERE id = ${b}.project_id))
  OR (${u}.site_id IS NULL AND ${u}.project_id IS NOT NULL AND ${u}.project_id = ${b}.project_id)
  OR (${u}.site_id IS NULL AND ${u}.project_id IS NULL AND ${u}.client_id = ${b}.client_id))`;

/** Blocks viewers from routes that expose other clients' or internal data. */
function notViewer(req, res, next) {
  if (req.session && req.session.role === 'viewer') {
    return res.status(403).json({ error: 'Your role does not allow this.' });
  }
  next();
}

/** Anyone who may change billing data. Viewers are read-only. */
const canEdit = requireRole('admin', 'billing_officer');

module.exports = { requireAuth, requireRole, canEdit, viewerScope, ownsBill, billScopeSql, covers, notViewer };
