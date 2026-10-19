// Opens each payment chat with an automatic notice once a statement is issued, so the conversation is never a blank page.
// One notice per statement and client login (sender_role = 'system'). Safe to call any number of times: it only
// adds what is missing, which also covers statements issued before this existed and client logins added later.
const db = require('../db');
const { balanceDue } = require('./invoice-ready');
const { covers } = require('../middleware/auth');

const day = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const won = (n) => '\u20A9' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });   // Korean won, no decimals, like the rest of this system

function ensureNotices(billId) {
  const missing = db.prepare(`
    SELECT b.id, b.statement_no, b.period_start, b.period_end, b.due_date, b.issued_at, p.name AS project_name, u.id AS user_id
    FROM bills b
    JOIN users u ON ${covers()} AND u.role = 'viewer' AND u.active = 1
    LEFT JOIN projects p ON p.id = b.project_id
    WHERE b.status = 'issued' ${billId ? 'AND b.id = ?' : ''}
      AND NOT EXISTS (SELECT 1 FROM bill_messages m WHERE m.bill_id = b.id AND m.client_user_id = u.id AND m.sender_role = 'system')`)
    .all(...(billId ? [billId] : []));
  if (!missing.length) return;
  const add = db.prepare(`INSERT INTO bill_messages (bill_id, client_user_id, user_id, sender_name, sender_role, side, body, created_at)
                          VALUES (?, ?, NULL, 'M-Carbon System', 'system', 'staff', ?, COALESCE(?, datetime('now')))`);
  db.transaction(() => {
    for (const m of missing) {
      const due = balanceDue(m.id);
      const body = `Statement ${m.statement_no}${m.project_name ? ' for ' + m.project_name : ''} (${day(m.period_start)} to ${day(m.period_end)}) has been issued.`
        + (due > 0 ? ` Amount due: ${won(due)}${m.due_date ? ', due ' + day(m.due_date) : ''}.` : ' Nothing is due.')
        + ' Write here if you have a question or when you have paid.';
      add.run(m.id, m.user_id, body, m.issued_at);
    }
  })();
}

module.exports = { ensureNotices };
