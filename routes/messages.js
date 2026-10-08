// Payment chat: a private conversation between ONE client login (viewer) and Mirae ESP staff
// (admin, billing officer, finance / HR), per issued bill.
//
//   GET  /api/messages/threads                 -> the conversations the signed-in user can open
//   GET  /api/messages/unread                  -> { total, threads: { "<billId>:<clientUserId>": n } }
//   GET  /api/messages/bills/:id[?user=<id>]   -> the conversation (optionally ?after=<lastId>&mark=1)
//   POST /api/messages/bills/:id               -> post a message { body, user_id? }
//
// Who sees what:
//   * A client login only ever reaches ITS OWN conversation on an issued bill of its own client. It cannot name
//     another login: any "user" it sends is ignored, so two logins of the same company never see each other's
//     messages, and a client can never reach another client at all (same 404 as a missing bill).
//   * Staff can open every conversation, but must say which client login it is with (?user= / user_id), and that
//     login has to belong to the bill's client. Staff can only post while the bill is issued.
const express = require('express');
const db = require('../db');
const audit = require('../lib/audit');
const { viewerScope } = require('../middleware/auth');
const { balanceDue } = require('../lib/invoice-ready');

const router = express.Router();

const MAX_LEN = 2000;
const MAX_PER_MINUTE = 20;
const STAFF_ROLES = ['admin', 'billing_officer', 'finance_hr'];

const isViewer = (req) => req.session.role === 'viewer';
const sideOf = (role) => (role === 'viewer' ? 'client' : 'staff');
const otherSide = (role) => (role === 'viewer' ? 'staff' : 'client');

/** Resolves { bill, threadUserId } if this session may use that conversation, otherwise null. */
function openThread(req, billId, staffUserId) {
  const bill = db.prepare('SELECT id, client_id, status, statement_no FROM bills WHERE id = ?').get(Number(billId));
  if (!bill) return null;
  if (isViewer(req)) {
    const scope = viewerScope(req);
    if (!scope || !scope.clientId || bill.client_id !== scope.clientId || bill.status !== 'issued') return null;
    return { bill, threadUserId: req.session.userId };   // always their own; anything they send is ignored
  }
  if (!STAFF_ROLES.includes(req.session.role)) return null;
  const who = Number(staffUserId);
  if (!who) return null;
  const login = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'viewer' AND client_id = ?").get(who, bill.client_id);
  return login ? { bill, threadUserId: login.id } : null;
}

function shape(row, userId) {
  return {
    id: row.id,
    side: row.side,
    sender_name: row.sender_name,
    body: row.body,
    created_at: row.created_at,
    mine: row.user_id === userId
  };
}

function markRead(billId, threadUserId, userId, lastId) {
  db.prepare(`INSERT INTO bill_thread_reads (bill_id, thread_user_id, user_id, last_id) VALUES (?,?,?,?)
              ON CONFLICT(bill_id, thread_user_id, user_id) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)`)
    .run(billId, threadUserId, userId, lastId);
}

/** Unread messages from the other side, per conversation the signed-in user may open. */
function unreadFor(req) {
  const role = req.session.role;
  const params = [req.session.userId, otherSide(role)];
  let scopeSql = '';
  if (isViewer(req)) {
    const scope = viewerScope(req);
    if (!scope || !scope.clientId) return { total: 0, threads: {} };
    scopeSql = 'AND m.client_user_id = ? AND b.client_id = ?';
    params.push(req.session.userId, scope.clientId);
  } else if (!STAFF_ROLES.includes(role)) {
    return { total: 0, threads: {} };
  }
  const rows = db.prepare(`
    SELECT m.bill_id, m.client_user_id AS tu, COUNT(*) n
    FROM bill_messages m
    JOIN bills b ON b.id = m.bill_id
    LEFT JOIN bill_thread_reads r
      ON r.bill_id = m.bill_id AND r.thread_user_id = m.client_user_id AND r.user_id = ?
    WHERE m.side = ? AND b.status = 'issued' AND m.client_user_id IS NOT NULL
      AND m.id > COALESCE(r.last_id, 0) ${scopeSql}
    GROUP BY m.bill_id, m.client_user_id`).all(...params);
  const threads = {};
  let total = 0;
  rows.forEach((r) => { threads[r.bill_id + ':' + r.tu] = r.n; total += r.n; });
  return { total, threads };
}

router.get('/unread', (req, res) => res.json(unreadFor(req)));

// The conversation list for the Messages page. A client login gets one row per issued bill of its own client
// (its own conversation). Staff get one row per issued bill x client login, so they can write to a specific
// login. Conversations with messages come first, newest activity on top.
router.get('/threads', (req, res) => {
  const params = [];
  let joinUser;
  let where = "b.status = 'issued'";
  if (isViewer(req)) {
    const scope = viewerScope(req);
    if (!scope || !scope.clientId) return res.json({ threads: [], total_unread: 0 });
    joinUser = 'JOIN users u ON u.id = ?';
    params.push(req.session.userId, scope.clientId);
    where += ' AND b.client_id = ?';
  } else if (STAFF_ROLES.includes(req.session.role)) {
    joinUser = "JOIN users u ON u.client_id = b.client_id AND u.role = 'viewer'";
    where += ' AND (u.active = 1 OR lm.id IS NOT NULL)';   // a deactivated login stays reachable if it has history
  } else {
    return res.json({ threads: [], total_unread: 0 });
  }
  const rows = db.prepare(`
    SELECT b.id AS bill_id, b.statement_no, b.period_start, b.period_end, b.due_date,
           c.name AS client_name, p.name AS project_name,
           u.id AS client_user_id, u.full_name AS client_user_name,
           lm.body AS last_body, lm.created_at AS last_at, lm.side AS last_side
    FROM bills b
    JOIN clients c ON c.id = b.client_id
    LEFT JOIN projects p ON p.id = b.project_id
    ${joinUser}
    LEFT JOIN bill_messages lm ON lm.id = (
      SELECT MAX(id) FROM bill_messages WHERE bill_id = b.id AND client_user_id = u.id)
    WHERE ${where}
    ORDER BY (lm.id IS NULL), lm.id DESC, b.bill_date DESC, b.id DESC, u.full_name
    LIMIT 300`).all(...params);

  const unread = unreadFor(req);
  res.json({
    total_unread: unread.total,
    threads: rows.map((r) => ({
      bill_id: r.bill_id,
      client_user_id: r.client_user_id,
      client_user_name: r.client_user_name,
      statement_no: r.statement_no,
      client_name: r.client_name,
      project_name: r.project_name,
      period_start: r.period_start,
      period_end: r.period_end,
      due_date: r.due_date,
      balance_due: balanceDue(r.bill_id),
      unread: unread.threads[r.bill_id + ':' + r.client_user_id] || 0,
      last_at: r.last_at || null,
      last_side: r.last_side || null,
      last_snippet: r.last_body ? (r.last_body.length > 90 ? r.last_body.slice(0, 90) + '…' : r.last_body) : null
    }))
  });
});

router.get('/bills/:id', (req, res) => {
  const t = openThread(req, req.params.id, req.query.user);
  if (!t) return res.status(404).json({ error: 'Conversation not found.' });

  const after = Math.max(0, Number(req.query.after) || 0);
  const rows = db.prepare(`SELECT * FROM bill_messages WHERE bill_id = ? AND client_user_id = ? AND id > ?
                           ORDER BY id ASC LIMIT 500`).all(t.bill.id, t.threadUserId, after);

  // Only mark as read when the person is actually looking at the conversation (the page passes mark=1 while visible).
  if (req.query.mark === '1') {
    const newest = db.prepare('SELECT COALESCE(MAX(id),0) m FROM bill_messages WHERE bill_id = ? AND client_user_id = ?')
      .get(t.bill.id, t.threadUserId).m;
    markRead(t.bill.id, t.threadUserId, req.session.userId, newest);
  }

  res.json({
    messages: rows.map((r) => shape(r, req.session.userId)),
    can_post: t.bill.status === 'issued'
  });
});

router.post('/bills/:id', (req, res) => {
  const t = openThread(req, req.params.id, req.body && req.body.user_id);
  if (!t) return res.status(404).json({ error: 'Conversation not found.' });
  if (t.bill.status !== 'issued') {
    return res.status(400).json({ error: 'Messages can only be sent on an issued bill.' });
  }

  const body = String((req.body && req.body.body) || '').replace(/\r\n/g, '\n').trim();
  if (!body) return res.status(400).json({ error: 'Type a message first.' });
  if (body.length > MAX_LEN) return res.status(400).json({ error: `Messages are limited to ${MAX_LEN} characters.` });

  const recent = db.prepare(`SELECT COUNT(*) c FROM bill_messages
                             WHERE user_id = ? AND created_at >= datetime('now', '-1 minute')`).get(req.session.userId).c;
  if (recent >= MAX_PER_MINUTE) {
    return res.status(429).json({ error: 'You are sending messages too quickly. Wait a moment and try again.' });
  }

  const user = db.prepare('SELECT full_name, username FROM users WHERE id = ?').get(req.session.userId);
  const name = (user && (user.full_name || user.username)) || req.session.username || 'User';
  const info = db.prepare(`INSERT INTO bill_messages (bill_id, client_user_id, user_id, sender_name, sender_role, side, body)
                           VALUES (?,?,?,?,?,?,?)`)
    .run(t.bill.id, t.threadUserId, req.session.userId, name, req.session.role, sideOf(req.session.role), body);

  // The message text itself stays out of the activity log; only the fact that one was sent is recorded.
  audit.log(req, 'bill', t.bill.id, 'message', `Sent a message in the payment chat of ${t.bill.statement_no}`);

  // Whoever sends has, by definition, seen everything in that conversation up to their own message.
  markRead(t.bill.id, t.threadUserId, req.session.userId, info.lastInsertRowid);

  const row = db.prepare('SELECT * FROM bill_messages WHERE id = ?').get(info.lastInsertRowid);
  res.json(shape(row, req.session.userId));
});

module.exports = router;
