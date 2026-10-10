// Payment reminders for issued bills that are about to be, or already are, overdue.
// Runs hourly and on demand. A bill gets one reminder per stage, so nobody is told twice for the same stage:
//   due_soon   NOTIFY_DUE_SOON_DAYS before the due date (default 3)
//   due_today  on the due date
//   overdue_N  the day after the due date, then every NOTIFY_OVERDUE_REPEAT_DAYS (default 7) while a balance remains
// Who is told: the client's logins and billing contacts, and every active Finance/HR user (administrators if there is none).
// Everyone with a login gets an in-system notification; everyone with an email address gets an email.
const db = require('../db');
const { balanceDue } = require('./invoice-ready');
const mailer = require('./mailer');

const SOON = Math.max(1, Number(process.env.NOTIFY_DUE_SOON_DAYS) || 3);
const REPEAT = Math.max(1, Number(process.env.NOTIFY_OVERDUE_REPEAT_DAYS) || 7);
const BASE = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
const TZ = process.env.APP_TIMEZONE || 'Asia/Manila';

const peso = (n) => 'PHP ' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const daysUntil = (due) => Math.round((Date.parse(due + 'T00:00:00Z') - Date.parse(today() + 'T00:00:00Z')) / 864e5);
const nice = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-PH', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e || '');

function stageFor(due) {
  const d = daysUntil(due);
  if (d > SOON) return null;
  if (d > 0) return { stage: 'due_soon', late: 0, days: d };
  if (d === 0) return { stage: 'due_today', late: 0, days: 0 };
  const late = -d;
  return { stage: 'overdue_' + (1 + REPEAT * Math.floor((late - 1) / REPEAT)), late, days: d };
}

function recipients(b) {
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  const clientUsers = all("SELECT id, email FROM users WHERE active = 1 AND role = 'viewer' AND client_id = ?", b.client_id);
  let finance = all("SELECT id, email FROM users WHERE active = 1 AND role = 'finance_hr'");
  if (!finance.length) finance = all("SELECT id, email FROM users WHERE active = 1 AND role = 'admin'");
  const contacts = all('SELECT name, phone, email, is_primary FROM contacts WHERE client_id = ? ORDER BY is_primary DESC, id', b.client_id);
  const withMail = contacts.filter((c) => validEmail(c.email));
  const primary = withMail.filter((c) => c.is_primary);
  const uniq = (list) => [...new Map(list.filter(validEmail).map((e) => [e.trim().toLowerCase(), e.trim()])).values()];
  return {
    clientUsers, finance, contact: contacts.find((c) => c.is_primary) || contacts[0],
    clientEmails: uniq([...clientUsers.map((u) => u.email), ...(primary.length ? primary : withMail).map((c) => c.email)]),
    financeEmails: uniq(finance.map((u) => u.email))
  };
}

async function deliver(id) {
  const m = db.prepare('SELECT e.*, n.bill_id FROM notice_emails e JOIN bill_notices n ON n.id = e.notice_id WHERE e.id = ?').get(id);
  if (!m) return;
  if (balanceDue(m.bill_id) <= 0) { // paid in the meantime: do not send a stale reminder
    db.prepare("UPDATE notice_emails SET status = 'cancelled' WHERE id = ?").run(id);
    return;
  }
  if (!mailer.configured()) {
    db.prepare("UPDATE notice_emails SET status = 'skipped', error = 'Email is not set up yet (SMTP_HOST and MAIL_FROM are missing).' WHERE id = ?").run(id);
    return;
  }
  try {
    await mailer.send(m.to_addr, m.subject, m.body);
    db.prepare("UPDATE notice_emails SET status = 'sent', attempts = attempts + 1, error = NULL, sent_at = datetime('now') WHERE id = ?").run(id);
  } catch (e) {
    db.prepare("UPDATE notice_emails SET status = 'failed', attempts = attempts + 1, error = ? WHERE id = ?").run(String(e.message || e).slice(0, 300), id);
  }
}

async function notifyBill(b, owed, st, noticeId) {
  const r = recipients(b);
  const link = BASE + '/bill.html?id=' + b.id;
  const due = nice(b.due_date.slice(0, 10));
  const when = st.late ? `is ${st.late} day${st.late === 1 ? '' : 's'} overdue`
    : st.days === 0 ? 'is due today' : `is due in ${st.days} day${st.days === 1 ? '' : 's'}`;
  const kind = st.late ? 'overdue' : 'due_soon';
  const clientTitle = (st.late ? 'Overdue: ' : 'Payment reminder: ') + `statement ${b.statement_no}`;
  const clientBody = `Statement ${b.statement_no} for ${b.project_name} ${when}.\nAmount still due: ${peso(owed)}\nDue date: ${due}\n\nOpen the statement: ${link}\nIf you have already paid, or have a question, send a message to Finance in the Messages section.`;
  const c = r.contact;
  const financeTitle = `${st.late ? 'Overdue' : 'Due soon'}: ${b.client_name}, statement ${b.statement_no}`;
  const financeBody = `${b.client_name}, statement ${b.statement_no} (${b.project_name}) ${when}.\nBalance: ${peso(owed)}\nDue date: ${due}\n`
    + (c ? `Client contact: ${c.name}${c.phone ? ', ' + c.phone : ''}${c.email ? ', ' + c.email : ''}\n` : '')
    + `\nOpen the statement: ${link}`;

  db.transaction(() => {
    const ins = db.prepare('INSERT INTO notifications (user_id, bill_id, kind, title, body) VALUES (?,?,?,?,?)');
    r.clientUsers.forEach((u) => ins.run(u.id, b.id, kind, clientTitle, clientBody));
    r.finance.forEach((u) => ins.run(u.id, b.id, kind, financeTitle, financeBody));
    db.prepare("INSERT INTO audit_log (username, entity, entity_id, action, detail) VALUES ('system', 'bill', ?, 'reminder', ?)")
      .run(b.id, `Statement ${b.statement_no} ${when}: ${r.clientUsers.length + r.finance.length} in-system notice(s), ${r.clientEmails.length + r.financeEmails.length} email(s) queued`);
  })();

  const out = db.prepare('INSERT INTO notice_emails (notice_id, to_addr, subject, body) VALUES (?,?,?,?)');
  const ids = [];
  r.clientEmails.forEach((a) => ids.push(out.run(noticeId, a, clientTitle, clientBody).lastInsertRowid));
  r.financeEmails.forEach((a) => ids.push(out.run(noticeId, a, financeTitle, financeBody).lastInsertRowid));
  for (const id of ids) await deliver(id);
  return ids;
}

// Keeps clients.status in step with reality: an issued bill past its due date with a balance makes the client
// "Overdue"; when nothing is overdue any more it goes back to "Billed" (or "Paid" if nothing is owed).
// Only Billed / Paid / Overdue are touched; Suspended, Project Complete and Ongoing Data Collection are left alone.
// Whole days past the due date (0 when not late or no valid due date).
function daysOverdue(due) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(due || '')) return 0;
  return Math.max(0, -daysUntil(due.slice(0, 10)));
}

function syncClientStatus() {
  const bills = db.prepare(`SELECT id, client_id, due_date FROM bills WHERE status = 'issued'`).all();
  const per = new Map(); // client_id -> { overdue, owing }
  for (const b of bills) {
    const s = per.get(b.client_id) || { overdue: false, owing: false };
    if (balanceDue(b.id) > 0) {
      s.owing = true;
      if (/^\d{4}-\d{2}-\d{2}/.test(b.due_date || '') && daysUntil(b.due_date.slice(0, 10)) < 0) s.overdue = true;
    }
    per.set(b.client_id, s);
  }
  let changed = 0;
  const upd = db.prepare('UPDATE clients SET status = ? WHERE id = ?');
  const log = db.prepare("INSERT INTO audit_log (username, entity, entity_id, action, detail) VALUES ('system', 'client', ?, 'status', ?)");
  for (const [clientId, s] of per) {
    const c = db.prepare('SELECT status FROM clients WHERE id = ?').get(clientId);
    if (!c || !['Billed', 'Paid', 'Overdue'].includes(c.status)) continue;
    const next = s.overdue ? 'Overdue' : s.owing ? 'Billed' : 'Paid';
    if (next === c.status) continue;
    upd.run(next, clientId);
    log.run(clientId, `Account status changed from ${c.status} to ${next}`);
    changed++;
  }
  return changed;
}

let running = false;
async function run() {
  if (running) return { created: 0, retried: 0, busy: true };
  running = true;
  try {
    let created = 0;
    const fresh = new Set(); // emails first tried in this run are not retried until the next one
    const bills = db.prepare(`SELECT b.*, c.name AS client_name, p.name AS project_name
      FROM bills b JOIN clients c ON c.id = b.client_id JOIN projects p ON p.id = b.project_id
      WHERE b.status = 'issued' AND b.due_date IS NOT NULL AND b.due_date <> ''`).all();
    for (const b of bills) {
      if (!/^\d{4}-\d{2}-\d{2}/.test(b.due_date)) continue;
      const owed = balanceDue(b.id);
      if (owed <= 0) continue;
      const st = stageFor(b.due_date.slice(0, 10));
      if (!st) continue;
      const ins = db.prepare('INSERT OR IGNORE INTO bill_notices (bill_id, stage) VALUES (?, ?)').run(b.id, st.stage);
      if (!ins.changes) continue;
      (await notifyBill(b, owed, st, ins.lastInsertRowid)).forEach((id) => fresh.add(id));
      created++;
    }
    syncClientStatus();
    // Emails that failed (up to 3 tries) or were held back because email was not set up are tried again.
    const again = db.prepare("SELECT id FROM notice_emails WHERE ((status = 'failed' AND attempts < 3) OR status = 'skipped') AND created_at > datetime('now', '-14 days')").all().filter((m) => !fresh.has(m.id));
    for (const m of again) await deliver(m.id);
    return { created, retried: again.length };
  } finally { running = false; }
}

function start() {
  if (process.env.NOTIFICATIONS_ENABLED === 'false') return console.log('[reminders] off (NOTIFICATIONS_ENABLED=false)');
  const tick = () => run().catch((e) => console.error('[reminders]', e));
  setTimeout(tick, 15000);
  setInterval(tick, 60 * 60 * 1000);
  console.log('[reminders] payment reminders are on, checked hourly' + (mailer.configured() ? '' : ' (email is not set up yet, so in-system notices only)'));
}

module.exports = { run, start, stageFor, syncClientStatus, daysOverdue };