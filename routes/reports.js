const express = require('express');
const db = require('../db');
const { round } = require('../lib/billing');
const { STATUSES } = require('./clients');

const { notViewer } = require('../middleware/auth');

const router = express.Router();
router.use(notViewer);

router.get('/overview', (req, res) => {
  try { require('../lib/notify').syncClientStatus(); } catch (e) { console.error('[status]', e); }
  const one = (sql, ...a) => db.prepare(sql).get(...a);

  const clients = one('SELECT COUNT(*) c FROM clients').c;
  const projects = one('SELECT COUNT(*) c FROM projects').c;
  const issued = db.prepare(
    `SELECT COALESCE(SUM(amount_billed),0) billed, COALESCE(SUM(client_retained),0) retained,
            COALESCE(SUM(energy_savings_kwh),0) kwh, COUNT(*) n
     FROM bills WHERE status IN ('final','issued')`).get();
  const collected = one(`SELECT COALESCE(SUM(p.amount),0) s FROM payments p
     JOIN bills b ON b.id = p.bill_id WHERE b.status IN ('final','issued')`).s;
  const outstanding = round(issued.billed - collected, 2);

  const byStatus = db.prepare('SELECT status, COUNT(*) n FROM bills GROUP BY status').all();
  const byMethod = db.prepare(
    `SELECT baseline_method, COUNT(*) n FROM bills WHERE status != 'void' GROUP BY baseline_method`).all();

  const pending = db.prepare(`
    SELECT b.id, b.statement_no, b.status, b.period_start, b.period_end, b.amount_billed,
           c.name AS client_name, p.name AS project_name
    FROM bills b JOIN clients c ON c.id = b.client_id JOIN projects p ON p.id = b.project_id
    WHERE b.status IN ('draft','for_review','approved')
    ORDER BY b.period_end DESC LIMIT 12`).all();

  // Quotations that need someone: Finance to review / send, or the billing officer to fix.
  const quotes_pending = db.prepare(`
    SELECT q.id, q.quote_no, q.status, q.customer_name, q.quote_date,
           ROUND(COALESCE((SELECT SUM(quantity * unit_price) FROM quotation_items WHERE quotation_id = q.id), 0) * (1 + q.vat_rate / 100.0), 2) AS total
    FROM quotations q WHERE q.status IN ('for_review','approved','declined')
    ORDER BY q.updated_at DESC, q.id DESC LIMIT 12`).all();

  const overdue = db.prepare(`
    SELECT b.id, b.statement_no, b.due_date, b.total_due, c.name AS client_name
    FROM bills b JOIN clients c ON c.id = b.client_id
    WHERE b.status = 'issued' AND b.total_due > 0 AND b.due_date < date('now')
    ORDER BY b.due_date LIMIT 12`).all();

  // Oldest first. Cumulative savings are totalled across every month on record,
  // then only the latest 12 are sent, so the running total never restarts.
  const monthlyAll = db.prepare(`
    SELECT substr(period_end,1,7) AS month,
           COALESCE(SUM(energy_savings_kwh),0) kwh,
           COALESCE(SUM(gross_savings),0) gross,
           COALESCE(SUM(amount_billed),0) billed
    FROM bills WHERE status IN ('final','issued')
    GROUP BY month ORDER BY month`).all();
  let running = 0;
  monthlyAll.forEach((m) => { running += m.kwh; m.cum_kwh = round(running, 3); });
  const monthly = monthlyAll.slice(-12);

  // Account status of every client, always listing the six standard statuses
  // (even at zero) in their usual order, then any legacy status found in the data.
  const statusRows = db.prepare('SELECT status, COUNT(*) n FROM clients GROUP BY status').all();
  const clientsByStatus = STATUSES.map((s) => ({ status: s, n: (statusRows.find((r) => r.status === s) || { n: 0 }).n }))
    .concat(statusRows.filter((r) => !STATUSES.includes(r.status)));

  res.json({
    clients, projects,
    statements: issued.n,
    total_billed: round(issued.billed, 2),
    total_retained: round(issued.retained, 2),
    total_kwh_saved: round(issued.kwh, 3),
    total_collected: round(collected, 2),
    outstanding,
    by_status: byStatus,
    by_method: byMethod,
    pending, quotes_pending, overdue,
    monthly,
    clients_by_status: clientsByStatus
  });
});

router.get('/audit', (req, res) => {
  const { entity, q, before } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 300, 1), 500);
  let sql = 'SELECT * FROM audit_log WHERE 1=1';
  const args = [];
  if (entity) { sql += ' AND entity = ?'; args.push(entity); }
  if (before) { sql += ' AND id < ?'; args.push(Number(before) || 0); } // "show older": rows before this id
  if (q) { sql += ' AND (detail LIKE ? OR username LIKE ? OR action LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY id DESC LIMIT ?';
  args.push(limit);
  res.json(db.prepare(sql).all(...args));
});

module.exports = router;