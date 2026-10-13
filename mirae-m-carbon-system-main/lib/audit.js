const db = require('../db');

function log(req, entity, entityId, action, detail) {
  db.prepare(
    'INSERT INTO audit_log (username, entity, entity_id, action, detail) VALUES (?,?,?,?,?)'
  ).run(req.session?.username || 'system', entity, entityId ?? null,
        action, typeof detail === 'string' ? detail : JSON.stringify(detail || {}));
}

function trail(entity, entityId) {
  return db.prepare(
    'SELECT * FROM audit_log WHERE entity = ? AND entity_id = ? ORDER BY id DESC LIMIT 200'
  ).all(entity, entityId);
}

module.exports = { log, trail };
