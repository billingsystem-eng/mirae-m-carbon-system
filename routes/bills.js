const express = require('express');
const { randomUUID: uuid } = require('crypto'); // built in; the uuid package is ESM-only in v12+ and can't be require()d on Node 18
const db = require('../db');
const { canEdit, requireRole, viewerScope } = require('../middleware/auth');
const { balanceDue, fullyPaid, invoiceReady } = require('../lib/invoice-ready');
const onlinePayments = require('./online-payments');
const audit = require('../lib/audit');
const { daysOverdue } = require('../lib/notify');
const { computeBill, daysBetween, dateRange, ratioFor, round } = require('../lib/billing');
const dashboard = require('../lib/dashboard');

const router = express.Router();

const EDITABLE = ['draft', 'for_review'];
// 'approved' is no longer reached by new bills (the administrator approval step was removed); it stays so older bills can finish.
const FLOW = { draft: 'for_review', for_review: 'final', approved: 'final', final: 'issued' };
const LABELS = {
  draft: 'Draft', for_review: 'For review', approved: 'Admin approved',
  final: 'Final / locked', issued: 'Issued', void: 'Void'
};
// Who may perform each step of the flow (the key is the status the bill moves INTO).
//   for_review : billing officer or admin sends the draft for review
//   final      : finance / HR approval (locks the bill)
//   issued     : billing officer or admin releases it to the client
const STEP_ROLES = {
  for_review: ['admin', 'billing_officer'],
  final: ['finance_hr'],
  issued: ['admin', 'billing_officer', 'finance_hr']
};
const STEP_ROLE_TEXT = {
  for_review: 'a billing officer or administrator',
  final: 'finance / HR (approval)', issued: 'a billing officer, administrator or finance / HR'
};

function billContext(bill) {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(bill.client_id);
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(bill.project_id);
  const contract = db.prepare('SELECT * FROM contracts WHERE id = ?').get(bill.contract_id);
  return { client, project, contract };
}

/** Unpaid amount carried forward from earlier finalised bills. */
function outstandingBefore(clientId, periodStart, excludeId) {
  const rows = db.prepare(`
    SELECT id, amount_billed, interest_charged FROM bills
    WHERE client_id = ? AND period_start < ? AND status IN ('final','issued') AND id != ?`
  ).all(clientId, periodStart, excludeId || 0);
  let total = 0;
  for (const r of rows) {
    const paid = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE bill_id = ?').get(r.id).s;
    const adj = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM adjustments WHERE bill_id = ?').get(r.id).s;
    total += r.amount_billed + r.interest_charged + adj - paid;
  }
  return round(total, 2);
}

/** Late payment interest suggested for a new bill: for every earlier
 *  finalised/issued bill that's still owed money and whose OWN due date has
 *  already passed as of this bill's date, apply the contract's daily rate
 *  to that bill's still-unpaid amount for however many days it's been late.
 *  Simple (non-compounding) interest, summed across every overdue bill. */
function suggestedInterest(clientId, periodStart, billDate, contractId, excludeId) {
  const contract = db.prepare('SELECT late_interest_rate FROM contracts WHERE id = ?').get(contractId);
  const dailyPct = Number(contract && contract.late_interest_rate) || 0;
  if (!dailyPct || !billDate) return 0;

  const rows = db.prepare(`
    SELECT id, amount_billed, interest_charged, due_date FROM bills
    WHERE client_id = ? AND period_start < ? AND status IN ('final','issued') AND id != ?`
  ).all(clientId, periodStart, excludeId || 0);

  let total = 0;
  for (const r of rows) {
    if (!r.due_date || billDate <= r.due_date) continue; // not overdue as of this bill's date
    const paid = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE bill_id = ?').get(r.id).s;
    const adj = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM adjustments WHERE bill_id = ?').get(r.id).s;
    const outstanding = round(r.amount_billed + r.interest_charged + adj - paid, 2);
    if (outstanding <= 0) continue;
    const daysLate = daysBetween(r.due_date, billDate) - 1; // days strictly after the due date
    if (daysLate <= 0) continue;
    total += outstanding * (dailyPct / 100) * daysLate;
  }
  return round(total, 4);
}

function totalsFor(billId) {
  return {
    payments_total: round(db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE bill_id = ?').get(billId).s, 2),
    adjustments_total: round(db.prepare('SELECT COALESCE(SUM(amount),0) s FROM adjustments WHERE bill_id = ?').get(billId).s, 2)
  };
}

function fullBill(id) {
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(id);
  if (!bill) return null;
  const { client, project, contract } = billContext(bill);
  contract.rates = db.prepare('SELECT * FROM rates WHERE contract_id = ? ORDER BY id').all(contract.id);
  contract.sharing_ratios = db.prepare('SELECT * FROM sharing_ratios WHERE contract_id = ? ORDER BY effective_from').all(contract.id);
  return {
    ...bill,
    status_label: LABELS[bill.status],
    editable: EDITABLE.includes(bill.status),
    inputs: JSON.parse(bill.inputs_json || '{}'),
    rate_breakdown: JSON.parse(bill.rate_breakdown_json || '[]'),
    client, project, contract,
    contacts: db.prepare('SELECT * FROM contacts WHERE client_id = ? ORDER BY is_primary DESC').all(client.id),
    devices: db.prepare('SELECT * FROM devices WHERE project_id = ?').all(project.id),
    daily: db.prepare('SELECT * FROM bill_days WHERE bill_id = ? ORDER BY day_date').all(id),
    payments: db.prepare('SELECT * FROM payments WHERE bill_id = ? ORDER BY paid_on').all(id),
    adjustments: db.prepare('SELECT * FROM adjustments WHERE bill_id = ? ORDER BY adjusted_on').all(id),
    ...totalsFor(id),
    previous_bill: db.prepare(`SELECT statement_no, period_start, period_end, actual_kwh, energy_savings_kwh, amount_billed
      FROM bills WHERE client_id = ? AND project_id = ? AND period_start < ? AND status IN ('final','issued')
      ORDER BY period_start DESC LIMIT 1`).get(client.id, project.id, bill.period_start) || null,
    history: billHistory(bill),
    trail: audit.trail('bill', id)
  };
}

/** Up to 12 periods for the statement graphs: this bill plus earlier final/issued bills for the same project.
 *  A revision replaces the bill it revises, so keep only the newest bill per period. */
function billHistory(bill) {
  const rows = db.prepare(`
    SELECT id, period_start, period_end, actual_kwh, baseline_kwh, energy_savings_kwh FROM bills
    WHERE project_id = ? AND status != 'void'
      AND (id = ? OR (period_start < ? AND status IN ('final','issued')))
    ORDER BY period_start ASC, id ASC`).all(bill.project_id, bill.id, bill.period_start);
  const byPeriod = new Map();
  for (const r of rows) byPeriod.set(r.period_start, r);
  return [...byPeriod.values()].slice(-12);
}

// --- List ---

router.get('/', (req, res) => {
  let { client_id, project_id, status, from, to } = req.query;
  // A client login sees only its own bills, and only once they have been issued —
  // drafts, reviews, approved and final bills stay hidden. Enforced here, not in the page.
  const scope = viewerScope(req);
  if (scope) {
    if (!scope.clientId) return res.json({ bills: [], labels: LABELS });
    client_id = scope.clientId;
    status = 'issued';
  }
  let sql = `SELECT b.*, c.name AS client_name, c.account_no, p.name AS project_name
             FROM bills b JOIN clients c ON c.id = b.client_id JOIN projects p ON p.id = b.project_id WHERE 1=1`;
  const args = [];
  if (client_id) { sql += ' AND b.client_id = ?'; args.push(client_id); }
  if (project_id) { sql += ' AND b.project_id = ?'; args.push(project_id); }
  if (status) { sql += ' AND b.status = ?'; args.push(status); }
  if (from) { sql += ' AND b.period_end >= ?'; args.push(from); }
  if (to) { sql += ' AND b.period_start <= ?'; args.push(to); }
  sql += ' ORDER BY b.period_start DESC, b.id DESC';
  const bills = db.prepare(sql).all(...args).map((b) => ({
    ...b, status_label: LABELS[b.status],
    // issued, still owing, past the due date -> days late (0 otherwise)
    days_late: b.status === 'issued' && balanceDue(b.id) > 0 ? daysOverdue(b.due_date) : 0
  }));
  res.json({ bills, labels: LABELS });
});

// --- Create a billing period ---

router.post('/', canEdit, (req, res) => {
  const { project_id, period_start, period_end, baseline_method } = req.body || {};
  if (!project_id || !period_start || !period_end) {
    return res.status(400).json({ error: 'Choose a project and a billing period.' });
  }
  if (period_end < period_start) return res.status(400).json({ error: 'The period end must fall after the start.' });

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(project_id);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  const contract = db.prepare('SELECT * FROM contracts WHERE project_id = ?').get(project_id);
  if (!contract) return res.status(400).json({ error: 'Set up this project’s billing configuration first.' });

  const clash = db.prepare(
    `SELECT id FROM bills WHERE project_id = ? AND period_start = ? AND period_end = ? AND status != 'void'`
  ).get(project_id, period_start, period_end);
  if (clash) return res.status(400).json({ error: 'A bill already exists for this project and period.' });

  const method = baseline_method || contract.baseline_method || 'fixed';
  const days = daysBetween(period_start, period_end);
  const ratio = ratioFor(
    db.prepare('SELECT * FROM sharing_ratios WHERE contract_id = ?').all(contract.id), period_end
  );

  const billDate = new Date().toISOString().slice(0, 10);
  const due = new Date(Date.now() + (contract.payment_terms_days || 15) * 86400000).toISOString().slice(0, 10);

  const info = db.prepare(`INSERT INTO bills
    (statement_no, client_id, project_id, contract_id, period_start, period_end, days,
     bill_date, due_date, baseline_method, ines_pct, client_pct, created_by, inputs_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    uuid(), project.client_id, project.id, contract.id, period_start, period_end, days,
    billDate, due, method, ratio?.ines_pct ?? 0, ratio?.client_pct ?? 0,
    req.session.username, JSON.stringify({})
  );

  const id = info.lastInsertRowid;
  const statementNo = `MC-${period_end.slice(0, 7).replace('-', '')}-${String(id).padStart(5, '0')}`;
  db.prepare('UPDATE bills SET statement_no = ? WHERE id = ?').run(statementNo, id);

  // Seed one row per day so the operating-hours method has a grid to fill in.
  const insertDay = db.prepare('INSERT INTO bill_days (bill_id, day_date) VALUES (?,?)');
  db.transaction(() => dateRange(period_start, period_end).forEach((d) => insertDay.run(id, d)))();

  audit.log(req, 'bill', id, 'create', `Created ${statementNo} for ${period_start} to ${period_end}`);
  res.json({ id, statement_no: statementNo });
});

router.get('/:id', (req, res) => {
  const bill = fullBill(req.params.id);
  if (!bill) return res.status(404).json({ error: 'Bill not found.' });
  const scope = viewerScope(req);
  if (scope) {
    // Same 404 as a missing bill, so a viewer can't tell a hidden bill from a nonexistent one.
    if (!scope.clientId || bill.client_id !== scope.clientId || bill.status !== 'issued') {
      return res.status(404).json({ error: 'Bill not found.' });
    }
    bill.trail = []; // internal activity log is for staff
  }
  bill.fully_paid = fullyPaid(bill.id);
  bill.balance_due = balanceDue(bill.id);
  bill.online_pay_enabled = onlinePayments.enabled();
  bill.invoice_ready = invoiceReady(bill.id);
  bill.suggested_previous_balance = outstandingBefore(bill.client_id, bill.period_start, bill.id);
  bill.suggested_interest = suggestedInterest(
    bill.client_id, bill.period_start, bill.bill_date, bill.contract_id, bill.id
  );
  res.json(bill);
});

// --- Pull actual consumption (and a suggested baseline) from the dashboard ---

router.post('/:id/pull-dashboard', canEdit, async (req, res) => {
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id);
  if (!bill) return res.status(404).json({ error: 'Bill not found.' });
  if (!EDITABLE.includes(bill.status)) {
    return res.status(400).json({ error: `This bill is ${LABELS[bill.status].toLowerCase()} and can no longer be edited.` });
  }
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(bill.project_id);
  if (!project.family_id) {
    return res.status(400).json({ error: 'This project isn\u2019t linked to a dashboard project yet — link it from the project page first.' });
  }

  try {
    const stats = await dashboard.getRangeStats(project.family_id, bill.period_start, bill.period_end);
    db.prepare('UPDATE bills SET source = ?, dashboard_synced_at = datetime(\'now\') WHERE id = ?')
      .run('dashboard', bill.id);
    audit.log(req, 'bill', bill.id, 'dashboard_sync',
      `Pulled ${Object.keys(stats.dailyKwh).length} day(s) from the M-Carbon Dashboard`);
    res.json({
      actual_kwh: round(stats.actualTotalKwh, 3),
      dashboard_daily_baseline: round(stats.suggestedBaselineDailyKwh, 4),
      daily: Object.entries(stats.dailyKwh).map(([day_date, actual_kwh]) => ({ day_date, actual_kwh: round(actual_kwh, 3) }))
    });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'Could not reach the M-Carbon Dashboard: ' + e.message });
  }
});

// --- Compute without saving, so the officer can check figures first ---

router.post('/:id/preview', canEdit, (req, res) => {
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id);
  if (!bill) return res.status(404).json({ error: 'Bill not found.' });
  const t = totalsFor(bill.id);
  res.json(computeBill({
    period_start: bill.period_start,
    period_end: bill.period_end,
    ...req.body,
    payments_total: t.payments_total,
    adjustments_total: t.adjustments_total
  }));
});

// --- Save inputs and persist the computation ---

router.put('/:id', canEdit, (req, res) => {
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id);
  if (!bill) return res.status(404).json({ error: 'Bill not found.' });
  if (!EDITABLE.includes(bill.status)) {
    return res.status(400).json({ error: `This bill is ${LABELS[bill.status].toLowerCase()} and can no longer be edited. Create a revision instead.` });
  }

  const b = req.body || {};
  const t = totalsFor(bill.id);
  const result = computeBill({
    period_start: bill.period_start,
    period_end: bill.period_end,
    baseline_method: b.baseline_method || bill.baseline_method,
    dashboard_daily_baseline: b.dashboard_daily_baseline,
    agreed_savings_pct: b.agreed_savings_pct,
    actual_kwh: b.actual_kwh,
    daily: b.daily || [],
    rate_lines: b.rate_lines || [],
    ines_pct: b.ines_pct,
    client_pct: b.client_pct,
    previous_balance: b.previous_balance,
    interest_charged: b.interest_charged,
    payments_total: t.payments_total,
    adjustments_total: t.adjustments_total
  });

  db.transaction(() => {
    db.prepare(`UPDATE bills SET
      bill_date = ?, due_date = ?, baseline_method = ?, inputs_json = ?, baseline_kwh = ?, actual_kwh = ?,
      energy_savings_kwh = ?, rate_breakdown_json = ?, gross_savings = ?, ines_pct = ?, client_pct = ?,
      amount_billed = ?, client_retained = ?, previous_balance = ?, interest_charged = ?, total_due = ?, notes = ?
      WHERE id = ?`).run(
      b.bill_date || bill.bill_date, b.due_date || bill.due_date,
      result.baseline_method, JSON.stringify(b), result.baseline_kwh, result.actual_kwh,
      result.energy_savings_kwh, JSON.stringify(result.rate_lines), result.gross_savings,
      Number(b.ines_pct) || 0, Number(b.client_pct) || 0, result.amount_billed, result.client_retained,
      result.previous_balance, result.interest_charged, result.total_due, b.notes ?? bill.notes, bill.id
    );

    if (Array.isArray(b.daily) && b.daily.length) {
      const upd = db.prepare('UPDATE bill_days SET actual_kwh = ?, operating_hours = ?, baseline_kwh = ? WHERE bill_id = ? AND day_date = ?');
      const byDate = Object.fromEntries((result.baseline_daily || []).map((d) => [d.day_date, d.baseline_kwh]));
      for (const d of b.daily) {
        upd.run(Number(d.actual_kwh) || 0, d.operating_hours === '' ? null : Number(d.operating_hours),
                byDate[d.day_date] ?? 0, bill.id, d.day_date);
      }
    }
  })();

  audit.log(req, 'bill', bill.id, 'compute',
    `Recomputed: baseline ${result.baseline_kwh} kWh, savings ${result.energy_savings_kwh} kWh, billed ${result.amount_billed}`);
  res.json(result);
});

// --- Status flow: draft -> for review -> approved -> final -> issued ---

router.post('/:id/status', requireRole('admin', 'billing_officer', 'finance_hr'), (req, res) => {
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id);
  if (!bill) return res.status(404).json({ error: 'Bill not found.' });
  const target = req.body?.status;

  if (target === 'void') {
    if (req.session.role !== 'admin') return res.status(403).json({ error: 'Only an administrator can void a bill.' });
    if (['final', 'issued'].includes(bill.status)) {
      return res.status(400).json({ error: 'A final or issued bill can’t be voided — create a revision instead so the original stays on record.' });
    }
    if (bill.status === 'void') return res.status(400).json({ error: 'This bill is already void.' });
    const reason = (req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Give a reason for voiding this bill.' });
    db.prepare('UPDATE bills SET status = ? WHERE id = ?').run('void', bill.id);
    audit.log(req, 'bill', bill.id, 'void', reason);
    return res.json({ ok: true, status: 'void' });
  }

  // Send back: an approver can return a bill to draft (with a reason) instead of approving it.
  if (target === 'draft') {
    const allowed = ['for_review', 'approved'].includes(bill.status) ? ['admin', 'finance_hr'] : [];
    if (!allowed.length) return res.status(400).json({ error: 'Only a bill that is waiting for approval can be returned to draft.' });
    if (!allowed.includes(req.session.role)) return res.status(403).json({ error: 'Your role cannot return this bill to draft.' });
    const reason = (req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'Give a reason for returning this bill to draft.' });
    db.prepare('UPDATE bills SET status = ?, admin_approved_by = NULL, admin_approved_at = NULL, finance_approved_by = NULL, finance_approved_at = NULL WHERE id = ?').run('draft', bill.id);
    audit.log(req, 'bill', bill.id, 'status', `${LABELS[bill.status]} → Draft (returned): ${reason}`);
    return res.json({ ok: true, status: 'draft', status_label: LABELS.draft });
  }

  const next = FLOW[bill.status];
  if (!next) return res.status(400).json({ error: `A ${LABELS[bill.status].toLowerCase()} bill has no next step.` });
  if (target && target !== next) {
    return res.status(400).json({ error: `The next step for this bill is “${LABELS[next]}”.` });
  }
  if (!STEP_ROLES[next].includes(req.session.role)) {
    return res.status(403).json({ error: `The next step for this bill must be done by ${STEP_ROLE_TEXT[next]}.` });
  }
  if (next === 'final' && bill.amount_billed === 0 && bill.gross_savings === 0) {
    return res.status(400).json({ error: 'Run the computation before approving this bill.' });
  }

  const who = req.session.username;
  const stamps = {
    final: 'UPDATE bills SET status = ?, finance_approved_by = ?, finance_approved_at = datetime(\'now\'), finalized_at = datetime(\'now\') WHERE id = ?',
    issued: 'UPDATE bills SET status = ?, issued_at = datetime(\'now\') WHERE id = ?'
  };
  const stmt = db.prepare(stamps[next] || 'UPDATE bills SET status = ? WHERE id = ?');
  if (next === 'final') stmt.run(next, who, bill.id); else stmt.run(next, bill.id);

  if (next === 'issued') {
    db.prepare('UPDATE clients SET status = ? WHERE id = ?').run('Billed', bill.client_id);
  }
  audit.log(req, 'bill', bill.id, 'status', `${LABELS[bill.status]} → ${LABELS[next]}`);
  res.json({ ok: true, status: next, status_label: LABELS[next] });
});

// --- Revision of a finalised bill: the original is preserved ---

router.post('/:id/revise', canEdit, (req, res) => {
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id);
  if (!bill) return res.status(404).json({ error: 'Bill not found.' });
  if (!['final', 'issued'].includes(bill.status)) {
    return res.status(400).json({ error: 'Only a final or issued bill needs a revision — edit this one directly.' });
  }
  const reason = (req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Give a reason for the revision.' });

  const info = db.prepare(`INSERT INTO bills
    (statement_no, client_id, project_id, contract_id, period_start, period_end, days, bill_date, due_date,
     source, baseline_method, inputs_json, ines_pct, client_pct, previous_balance, notes, revises_bill_id, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    uuid(), bill.client_id, bill.project_id, bill.contract_id, bill.period_start, bill.period_end, bill.days,
    new Date().toISOString().slice(0, 10), bill.due_date, bill.source, bill.baseline_method, bill.inputs_json,
    bill.ines_pct, bill.client_pct, bill.previous_balance, reason, bill.id, req.session.username
  );
  const id = info.lastInsertRowid;
  const statementNo = `${bill.statement_no}-R${String(id).padStart(3, '0')}`;
  db.prepare('UPDATE bills SET statement_no = ? WHERE id = ?').run(statementNo, id);

  const insertDay = db.prepare('INSERT INTO bill_days (bill_id, day_date, actual_kwh, operating_hours) VALUES (?,?,?,?)');
  const srcDays = db.prepare('SELECT * FROM bill_days WHERE bill_id = ? ORDER BY day_date').all(bill.id);
  db.transaction(() => srcDays.forEach((d) => insertDay.run(id, d.day_date, d.actual_kwh, d.operating_hours)))();

  audit.log(req, 'bill', bill.id, 'revise', `Revised as ${statementNo}: ${reason}`);
  audit.log(req, 'bill', id, 'create', `Revision of ${bill.statement_no}: ${reason}`);
  res.json({ id, statement_no: statementNo });
});

// --- Permanently delete a voided bill (admin only) ---

router.delete('/:id', canEdit, (req, res) => {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Only an administrator can delete a bill.' });
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id);
  if (!bill) return res.status(404).json({ error: 'Bill not found.' });
  if (bill.status !== 'void') {
    return res.status(400).json({ error: 'Only a void bill can be deleted. Remove (void) it first.' });
  }
  const child = db.prepare('SELECT statement_no FROM bills WHERE revises_bill_id = ?').get(bill.id);
  if (child) {
    return res.status(400).json({ error: `Can’t delete — ${child.statement_no} is a revision of this bill.` });
  }
  const pay = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(amount),0) total FROM payments WHERE bill_id = ?').get(bill.id);
  if (pay.n && req.query.with_payments !== '1') {
    return res.status(409).json({
      error: `This bill has ${pay.n} recorded payment(s) totalling ${round(pay.total, 2)}.`,
      code: 'has_payments', payment_count: pay.n, payment_total: round(pay.total, 2)
    });
  }

  db.transaction(() => {
    db.prepare('DELETE FROM bills WHERE id = ?').run(bill.id); // bill_days, payments, adjustments cascade
    audit.log(req, 'bill', bill.id, 'delete',
      `Permanently deleted void bill ${bill.statement_no} (${bill.period_start} to ${bill.period_end})` +
      (pay.n ? ` together with ${pay.n} recorded payment(s) totalling ${round(pay.total, 2)}` : ''));
  })();
  res.json({ ok: true });
});

// --- Payments and adjustments ---

router.post('/:id/payments', canEdit, (req, res) => {
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id);
  if (!bill) return res.status(404).json({ error: 'Bill not found.' });
  const { paid_on, amount, reference, method } = req.body || {};
  if (!paid_on || !amount) return res.status(400).json({ error: 'A payment date and amount are required.' });
  db.prepare('INSERT INTO payments (bill_id, paid_on, amount, reference, method, created_by) VALUES (?,?,?,?,?,?)')
    .run(bill.id, paid_on, Number(amount), reference || null, method || null, req.session.username);

  const t = totalsFor(bill.id);
  const due = round(bill.amount_billed + bill.previous_balance + bill.interest_charged + t.adjustments_total - t.payments_total, 2);
  db.prepare('UPDATE bills SET total_due = ? WHERE id = ?').run(due, bill.id);
  if (due <= 0 && bill.status === 'issued') {
    db.prepare('UPDATE clients SET status = ? WHERE id = ?').run('Paid', bill.client_id);
  }
  audit.log(req, 'bill', bill.id, 'payment', `Recorded payment of ${amount} on ${paid_on}`);
  res.json({ ok: true, total_due: due });
});

// Finance (or an admin) confirms the money was actually received. Until then clients can't see the Sales Invoice.
router.post('/:id/confirm-payment', requireRole('admin', 'finance_hr'), (req, res) => {
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id);
  if (!bill) return res.status(404).json({ error: 'Bill not found.' });
  if (!fullyPaid(bill.id)) {
    return res.status(400).json({ error: 'Record the full payment on this issued bill before confirming it.' });
  }
  db.prepare("UPDATE bills SET payment_confirmed_by = ?, payment_confirmed_at = datetime('now') WHERE id = ?")
    .run(req.session.username, bill.id);
  audit.log(req, 'bill', bill.id, 'payment-confirm', `Payment confirmed as received for ${bill.statement_no}`);
  res.json({ ok: true });
});

router.post('/:id/unconfirm-payment', requireRole('admin', 'finance_hr'), (req, res) => {
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id);
  if (!bill) return res.status(404).json({ error: 'Bill not found.' });
  db.prepare('UPDATE bills SET payment_confirmed_by = NULL, payment_confirmed_at = NULL WHERE id = ?').run(bill.id);
  audit.log(req, 'bill', bill.id, 'payment-unconfirm', `Payment confirmation withdrawn for ${bill.statement_no}`);
  res.json({ ok: true });
});

router.post('/:id/adjustments', canEdit, (req, res) => {
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(req.params.id);
  if (!bill) return res.status(404).json({ error: 'Bill not found.' });
  const { adjusted_on, amount, reason } = req.body || {};
  if (!adjusted_on || amount === undefined || !reason) {
    return res.status(400).json({ error: 'A date, amount and reason are required for an adjustment.' });
  }
  db.prepare('INSERT INTO adjustments (bill_id, adjusted_on, amount, reason, created_by) VALUES (?,?,?,?,?)')
    .run(bill.id, adjusted_on, Number(amount), reason, req.session.username);

  const t = totalsFor(bill.id);
  const due = round(bill.amount_billed + bill.previous_balance + bill.interest_charged + t.adjustments_total - t.payments_total, 2);
  db.prepare('UPDATE bills SET total_due = ? WHERE id = ?').run(due, bill.id);
  audit.log(req, 'bill', bill.id, 'adjustment', `${amount} — ${reason}`);
  res.json({ ok: true, total_due: due });
});

module.exports = router;