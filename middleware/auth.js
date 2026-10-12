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

/** For a viewer (client login) returns { clientId } — null if no client is assigned yet.
 *  Returns null for every other role. Read from the database each time so a change
 *  of assignment by an admin applies immediately, without the viewer signing in again. */
function viewerScope(req) {
  if (!req.session || req.session.role !== 'viewer') return null;
  const db = require('../db');
  const row = db.prepare('SELECT client_id FROM users WHERE id = ? AND active = 1').get(req.session.userId);
  return { clientId: row ? row.client_id : null };
}

/** Blocks viewers from routes that expose other clients' or internal data. */
function notViewer(req, res, next) {
  if (req.session && req.session.role === 'viewer') {
    return res.status(403).json({ error: 'Your role does not allow this.' });
  }
  next();
}

/** Anyone who may change billing data. Viewers are read-only. */
const canEdit = requireRole('admin', 'billing_officer');

module.exports = { requireAuth, requireRole, canEdit, viewerScope, notViewer };
