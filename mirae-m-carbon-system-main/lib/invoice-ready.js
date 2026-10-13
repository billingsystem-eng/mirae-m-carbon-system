// Payment state of a bill, shared by the bills API, the invoice gate and online payments.
//   balanceDue    - what is still owed right now (can be <= 0)
//   fullyPaid     - bill is issued, at least one payment is recorded, and nothing is left owing
//   invoiceReady  - fullyPaid AND finance (or an admin) has confirmed the payment was received
// Confirmation is ignored again if the bill stops being fully paid (e.g. a later adjustment).
const db = require('../db');
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

function balanceDue(billId) {
  const b = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
  if (!b) return 0;
  const paid = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE bill_id = ?').get(billId).s;
  const adj = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM adjustments WHERE bill_id = ?').get(billId).s;
  return r2(b.amount_billed + b.previous_balance + b.interest_charged + adj - paid);
}

function fullyPaid(billId) {
  const b = db.prepare('SELECT status FROM bills WHERE id = ?').get(billId);
  if (!b || b.status !== 'issued') return false;
  const n = db.prepare('SELECT COUNT(*) n FROM payments WHERE bill_id = ?').get(billId).n;
  return n > 0 && balanceDue(billId) <= 0;
}

function invoiceReady(billId) {
  const b = db.prepare('SELECT payment_confirmed_at FROM bills WHERE id = ?').get(billId);
  return !!(b && b.payment_confirmed_at) && fullyPaid(billId);
}

module.exports = { balanceDue, fullyPaid, invoiceReady };
