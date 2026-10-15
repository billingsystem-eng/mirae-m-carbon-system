// Suggests which issued bill a bank deposit probably pays. It only ever SUGGESTS: finance confirms every match.
//
// A deposit scores against each issued bill that still owes money:
//   +50  the amount equals the balance due, or the balance plus the 10% VAT that rides on the tax invoice
//   +40  the depositor name on the bank line (적요) matches the client's name
// Anything under 40 is not shown. 90 = strong (both), 50 = likely (amount only), 40 = name only.
const db = require('../db');
const { balanceDue } = require('./invoice-ready');

// Company-form words that appear on one side but not the other ("주식회사 볼타" vs "볼타", "ACME Co., Ltd." vs "Acme").
const NOISE = /주식회사|\(주\)|㈜|유한회사|\(유\)|\bco\b|\bltd\b|\binc\b|\bcorp\b|\bcorporation\b|\bcompany\b/gi;
const norm = (s) => String(s || '').toLowerCase().replace(NOISE, '').replace(/[^0-9a-z가-힣]/g, '');

function nameMatches(description, clientName) {
  const a = norm(description), b = norm(clientName);
  if (a.length < 2 || b.length < 2) return false;
  return a.includes(b) || b.includes(a);
}

/** VAT that the client pays on top of the bill balance. The issued/requested tax invoice knows it exactly;
 *  before one exists, estimate it the same way the tax invoice will (BOLTA_VAT_MODE, default: 10% on top). */
function vatExtra(bill) {
  const ti = db.prepare("SELECT tax FROM tax_invoices WHERE bill_id = ? AND status IN ('requested','issued') ORDER BY id DESC LIMIT 1").get(bill.id);
  if (ti) return Math.round(ti.tax || 0);
  const mode = process.env.BOLTA_VAT_MODE || 'add';
  return mode === 'add' ? Math.round((Number(bill.amount_billed) || 0) * 0.1) : 0;
}

/** Issued bills that still owe something, with the balance and the VAT on top. */
function openBills() {
  const rows = db.prepare(`SELECT b.id, b.statement_no, b.client_id, b.due_date, b.amount_billed, c.name AS client_name
                           FROM bills b JOIN clients c ON c.id = b.client_id WHERE b.status = 'issued'`).all();
  const out = [];
  for (const b of rows) {
    const due = Math.round(balanceDue(b.id));
    if (due > 0) out.push({ ...b, due, vat_extra: vatExtra(b) });
  }
  return out;
}

function suggestionsFor(tx, open) {
  if (tx.type !== 'DEPOSIT' || tx.currency !== 'KRW') return [];
  const found = [];
  for (const b of open) {
    const exact = tx.amount === b.due;
    const withVat = !exact && b.vat_extra > 0 && tx.amount === b.due + b.vat_extra;
    const name = nameMatches(tx.description, b.client_name);
    const reasons = [];
    let score = 0;
    if (exact) { score += 50; reasons.push('Amount equals the balance due'); }
    else if (withVat) { score += 50; reasons.push('Amount equals the balance plus 10% VAT'); }
    if (name) { score += 40; reasons.push('Depositor name matches the client'); }
    if (score < 40) continue;
    if (!exact && !withVat && tx.amount < b.due) reasons.push('Less than the balance (part payment?)');
    found.push({
      bill_id: b.id, statement_no: b.statement_no, client_name: b.client_name, due: b.due, due_date: b.due_date,
      apply_default: Math.min(tx.amount, b.due), score,
      confidence: score >= 90 ? 'strong' : score >= 50 ? 'likely' : 'name', reasons
    });
  }
  found.sort((x, y) => y.score - x.score || String(x.due_date || '9999').localeCompare(String(y.due_date || '9999')));
  return found.slice(0, 3);
}

module.exports = { openBills, suggestionsFor, nameMatches, norm };
