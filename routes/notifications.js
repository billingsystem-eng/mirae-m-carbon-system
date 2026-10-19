// Payment-reminder notifications.
//   GET  /api/notifications          -> my notifications (newest first)
//   GET  /api/notifications/unread   -> { total }
//   POST /api/notifications/read     -> mark one ({ id }) or all of mine as read
//   DELETE /api/notifications/:id    -> delete one of mine
//   DELETE /api/notifications        -> delete all of mine
//   GET  /api/notifications/log      -> reminder log with email results (admin, finance / HR)
//   POST /api/notifications/run      -> check for due / overdue bills now (admin, finance / HR)
const express = require('express');
const db = require('../db');
const audit = require('../lib/audit');
const notify = require('../lib/notify');
const mailer = require('../lib/mailer');
const { requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(db.prepare(`SELECT n.id, n.kind, n.title, n.body, n.bill_id, n.quotation_id, n.read_at, n.created_at, b.statement_no, q.quote_no
    FROM notifications n LEFT JOIN bills b ON b.id = n.bill_id LEFT JOIN quotations q ON q.id = n.quotation_id
    WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 100`).all(req.session.userId));
});

router.get('/unread', (req, res) => {
  res.json({ total: db.prepare('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.session.userId).n });
});

router.post('/read', (req, res) => {
  const id = Number(req.body && req.body.id);
  if (id) db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND user_id = ? AND read_at IS NULL").run(id, req.session.userId);
  else db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL").run(req.session.userId);
  res.json({ ok: true });
});

// Each person can delete only their own notifications. The reminder log below is a separate record and is never touched.
router.delete('/:id', (req, res) => {
  const r = db.prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.session.userId);
  if (!r.changes) return res.status(404).json({ error: 'Notification not found.' });
  res.json({ ok: true });
});

router.delete('/', (req, res) => {
  const r = db.prepare('DELETE FROM notifications WHERE user_id = ?').run(req.session.userId);
  res.json({ ok: true, deleted: r.changes });
});

router.get('/log', requireRole('admin', 'finance_hr'), (req, res) => {
  const count = (s) => `(SELECT COUNT(*) FROM notice_emails e WHERE e.notice_id = bn.id AND e.status = '${s}')`;
  res.json({
    email_configured: mailer.configured(),
    rows: db.prepare(`SELECT bn.id, bn.stage, bn.created_at, b.id AS bill_id, b.statement_no, b.due_date, c.name AS client_name,
        ${count('sent')} AS sent, ${count('failed')} AS failed, ${count('skipped')} AS held
      FROM bill_notices bn JOIN bills b ON b.id = bn.bill_id JOIN clients c ON c.id = b.client_id
      ORDER BY bn.id DESC LIMIT 100`).all()
  });
});

router.post('/run', requireRole('admin', 'finance_hr'), async (req, res, next) => {
  try {
    const r = await notify.run();
    audit.log(req, 'bill', null, 'reminder-check', `Checked for due and overdue bills: ${r.created} new reminder(s)`);
    res.json(r);
  } catch (e) { next(e); }
});

module.exports = router;