const express = require('express');
const db = require('../db');
const { canEdit, requireRole, viewerScope } = require('../middleware/auth');
const audit = require('../lib/audit');

const router = express.Router();
// Flow (like a billing statement):  Draft -> For review -> Accepted (Finance / HR) -> Sent to client -> Paid
//   Finance / HR can also Decline a quotation in review (with a reason); the billing officer fixes it and sends it for review again.
//   "accepted" (client accepted) is kept for older records.
const STATUSES = ['draft', 'for_review', 'approved', 'declined', 'sent', 'accepted', 'paid'];
const LABELS = {
  draft: 'Draft', for_review: 'For review', approved: 'Accepted', declined: 'Declined',
  sent: 'Sent to client', accepted: 'Client accepted', paid: 'Paid'
};
const CLIENT_VISIBLE = ['sent', 'accepted', 'paid'];   // what a client login may see
const EDITABLE = ['draft', 'declined'];                // only the billing officer's working states
const PREPARER = { roles: ['admin', 'billing_officer'], who: 'a billing officer or administrator' };
const FINANCE = { roles: ['finance_hr'], who: 'finance / HR' };
const CLOSER = { roles: ['finance_hr', 'admin'], who: 'finance / HR or an administrator' };
const MOVES = {   // current status -> { next status: who may do it }
  draft: { for_review: PREPARER },
  declined: { for_review: PREPARER },
  for_review: { approved: FINANCE, declined: FINANCE },
  approved: { sent: FINANCE, declined: FINANCE },
  sent: { accepted: CLOSER, paid: CLOSER },
  accepted: { paid: CLOSER }
};

const DEFAULT_TERMS = [
  '1) Order Confirmation: Upon the Client\u2019s acceptance of this quotation.',
  '2) Payment Terms: Due within 30 days from the date of invoice.',
  '3) Delivery: Within 3\u20135 business days from order confirmation, subject to product availability.',
  '4) Quotation Validity: This quotation is valid until the Valid Until date stated above.',
  '5) Warranty: LED lighting products are covered by a 5-year warranty against manufacturing defects and technical malfunction. Warranty coverage is limited to product replacement. Maintenance services are not included.',
  '6) Shipping: Shipping and delivery charges will be calculated based on the delivery location and will be quoted separately, unless otherwise stated in the quotation.'
].join('\n');

// Korean wording of the same terms (shown when the interface is in Korean).
const DEFAULT_TERMS_KO = [
  '1) 주문 확인: 고객이 본 견적서를 수락한 시점부터 적용됩니다.',
  '2) 결제 조건: 청구서 발행일로부터 30일 이내에 결제해야 합니다.',
  '3) 배송: 주문 확인일로부터 3~5 영업일 이내이며, 제품 재고 상황에 따라 달라질 수 있습니다.',
  '4) 견적서 유효 기간: 본 견적서는 상단에 명시된 \u2018유효 기간\u2019까지 유효합니다.',
  '5) 보증: LED 조명 제품은 제조 결함 및 기술적 오작동에 대해 5년 보증이 적용됩니다. 보증 범위는 제품 교체로 한정되며, 유지보수 서비스는 포함되지 않습니다.',
  '6) 배송: 배송비는 배송지에 따라 산정되며, 견적서에 별도로 명시되지 않는 한 별도로 견적됩니다.'
].join('\n');

const text = (v, max) => String(v ?? '').trim().slice(0, max);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');

function totals(subtotal, vatRate) {
  const sub = r2(subtotal), vat = r2(sub * (vatRate / 100));
  return { subtotal: sub, vat, total: r2(sub + vat) };
}

function load(id) {
  const q = db.prepare('SELECT * FROM quotations WHERE id = ?').get(id);
  if (!q) return null;
  const items = db.prepare('SELECT * FROM quotation_items WHERE quotation_id = ? ORDER BY position, id').all(id)
    .map((i) => ({ ...i, line_total: r2(i.quantity * i.unit_price) }));
  const sub = items.reduce((a, i) => a + i.quantity * i.unit_price, 0);
  return { ...q, status_label: LABELS[q.status] || q.status, editable: EDITABLE.includes(q.status), items, ...totals(sub, q.vat_rate) };
}

function nextNo(dateStr) {
  const prefix = `MC${dateStr.slice(0, 4)}-`;
  const last = db.prepare("SELECT quote_no FROM quotations WHERE quote_no LIKE ? ORDER BY quote_no DESC LIMIT 1").get(prefix + '%');
  const n = last ? parseInt(last.quote_no.slice(prefix.length), 10) + 1 : 1;
  return prefix + String(n).padStart(3, '0');
}

// In-system notices for the next person in the flow (shown under Notifications).
function notifyUsers(userIds, q, title, body) {
  const ins = db.prepare("INSERT INTO notifications (user_id, kind, title, body, quotation_id) VALUES (?, 'quotation', ?, ?, ?)");
  [...new Set(userIds)].forEach((uid) => ins.run(uid, title, body, q.id));
}
const peso = (n) => 'PHP ' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Validates the body; returns { error } or { data, items }. */
function parse(b) {
  const data = {
    quote_date: text(b.quote_date, 10), valid_until: text(b.valid_until, 10),
    client_id: b.client_id ? Number(b.client_id) : null,
    customer_name: text(b.customer_name, 200), project_site: text(b.project_site, 200), client_ref_id: text(b.client_ref_id, 80),
    submitted_by: text(b.submitted_by, 120), contact_no: text(b.contact_no, 60),
    vat_rate: num(b.vat_rate ?? 10), terms: text(b.terms, 4000),
    prepared_by_name: text(b.prepared_by_name, 120), prepared_by_title: text(b.prepared_by_title, 120),
    approved_by_name: text(b.approved_by_name, 120), approved_by_title: text(b.approved_by_title, 120),
    contact_name: text(b.contact_name, 120), contact_phone: text(b.contact_phone, 60), contact_email: text(b.contact_email, 120)
  };
  if (!data.customer_name) return { error: 'A customer name is required.' };
  if (!isDate(data.quote_date) || !isDate(data.valid_until)) return { error: 'A quotation date and a valid-until date are required.' };
  if (data.valid_until < data.quote_date) return { error: 'The valid-until date must not be before the quotation date.' };
  if (!(data.vat_rate >= 0 && data.vat_rate <= 100)) return { error: 'The VAT rate must be between 0 and 100.' };
  if (data.client_id && !db.prepare('SELECT 1 FROM clients WHERE id = ?').get(data.client_id)) data.client_id = null;
  const items = (Array.isArray(b.items) ? b.items : []).map((i) => ({
    description: text(i.description, 1500), quantity: num(i.quantity), unit: text(i.unit, 30) || 'pieces',
    unit_material: i.unit_material === '' || i.unit_material == null ? 0 : num(i.unit_material),
    unit_labor: i.unit_labor === '' || i.unit_labor == null ? 0 : num(i.unit_labor)
  })).filter((i) => i.description);
  if (!items.length) return { error: 'Add at least one item with a description.' };
  if (items.some((i) => !(i.quantity > 0) || !(i.unit_material >= 0) || !(i.unit_labor >= 0))) return { error: 'Each item needs a quantity above zero and valid material and labor costs.' };
  items.forEach((i) => { i.unit_price = r2(i.unit_material + i.unit_labor); });
  return { data, items };
}

function saveItems(id, items) {
  db.prepare('DELETE FROM quotation_items WHERE quotation_id = ?').run(id);
  const ins = db.prepare('INSERT INTO quotation_items (quotation_id, position, description, quantity, unit, unit_price, unit_material, unit_labor) VALUES (?,?,?,?,?,?,?,?)');
  items.forEach((i, n) => ins.run(id, n, i.description, i.quantity, i.unit, i.unit_price, i.unit_material, i.unit_labor));
}

router.get('/defaults', (req, res) => res.json({ terms: DEFAULT_TERMS, terms_ko: DEFAULT_TERMS_KO, statuses: STATUSES, labels: LABELS }));

router.get('/', (req, res) => {
  const q = text(req.query.q, 100), status = text(req.query.status, 20);
  let sql = `SELECT q.*, COALESCE((SELECT SUM(quantity * unit_price) FROM quotation_items WHERE quotation_id = q.id), 0) AS sub
             FROM quotations q WHERE 1=1`;
  const args = [];
  // A client login sees only quotations linked to its own client, and only once Finance has sent them.
  const scope = viewerScope(req);
  if (scope) {
    if (!scope.clientId) return res.json({ statuses: CLIENT_VISIBLE, labels: LABELS, quotations: [] });
    sql += ` AND q.client_id = ? AND q.status IN (${CLIENT_VISIBLE.map(() => '?').join(',')})`; args.push(scope.clientId, ...CLIENT_VISIBLE);
  }
  if (q) { sql += ' AND (q.quote_no LIKE ? OR q.customer_name LIKE ? OR q.client_ref_id LIKE ?)'; args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (status) { sql += ' AND q.status = ?'; args.push(status); }
  sql += ' ORDER BY q.quote_date DESC, q.id DESC';
  const rows = db.prepare(sql).all(...args).map(({ sub, ...r }) => ({ ...r, ...totals(sub, r.vat_rate) }));
  res.json({ statuses: scope ? CLIENT_VISIBLE : STATUSES, labels: LABELS, quotations: rows.map((r) => ({ ...r, status_label: LABELS[r.status] || r.status })) });
});

router.get('/:id', (req, res) => {
  const q = load(Number(req.params.id));
  if (!q) return res.status(404).json({ error: 'Quotation not found.' });
  const scope = viewerScope(req);
  if (scope && (!scope.clientId || q.client_id !== scope.clientId || !CLIENT_VISIBLE.includes(q.status))) {
    return res.status(404).json({ error: 'Quotation not found.' });
  }
  res.json(q);
});

router.post('/', canEdit, (req, res) => {
  const { error, data, items } = parse(req.body || {});
  if (error) return res.status(400).json({ error });
  const id = db.transaction(() => {
    const info = db.prepare(`INSERT INTO quotations (quote_no, quote_date, valid_until, client_id, customer_name, project_site, client_ref_id,
        submitted_by, contact_no, vat_rate, terms, prepared_by_name, prepared_by_title, approved_by_name, approved_by_title,
        contact_name, contact_phone, contact_email, created_by)
      VALUES (@quote_no, @quote_date, @valid_until, @client_id, @customer_name, @project_site, @client_ref_id, @submitted_by, @contact_no,
        @vat_rate, @terms, @prepared_by_name, @prepared_by_title, @approved_by_name, @approved_by_title,
        @contact_name, @contact_phone, @contact_email, @created_by)`)
      .run({ ...data, quote_no: nextNo(data.quote_date), created_by: req.session.username || null });
    saveItems(info.lastInsertRowid, items);
    return info.lastInsertRowid;
  })();
  const q = load(id);
  audit.log(req, 'quotation', id, 'create', `Created quotation ${q.quote_no} for ${q.customer_name}`);
  res.status(201).json(q);
});

router.put('/:id', canEdit, (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM quotations WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ error: 'Quotation not found.' });
  if (!EDITABLE.includes(cur.status)) {
    return res.status(400).json({ error: `This quotation is “${LABELS[cur.status]}” and is locked. It can be edited only while it is a draft or after Finance declines it.` });
  }
  const { error, data, items } = parse(req.body || {});
  if (error) return res.status(400).json({ error });
  db.transaction(() => {
    db.prepare(`UPDATE quotations SET quote_date=@quote_date, valid_until=@valid_until, client_id=@client_id,
        customer_name=@customer_name, project_site=@project_site, client_ref_id=@client_ref_id, submitted_by=@submitted_by, contact_no=@contact_no,
        vat_rate=@vat_rate, terms=@terms, prepared_by_name=@prepared_by_name, prepared_by_title=@prepared_by_title,
        approved_by_name=@approved_by_name, approved_by_title=@approved_by_title, contact_name=@contact_name,
        contact_phone=@contact_phone, contact_email=@contact_email, updated_at=datetime('now') WHERE id=@id`).run({ ...data, id });
    saveItems(id, items);
  })();
  const q = load(id);
  audit.log(req, 'quotation', id, 'update', `Updated quotation ${q.quote_no} (total ${q.total})`);
  res.json(q);
});

router.patch('/:id/status', requireRole('admin', 'billing_officer', 'finance_hr'), (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM quotations WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ error: 'Quotation not found.' });
  const target = text(req.body?.status, 20);
  if (!STATUSES.includes(target)) return res.status(400).json({ error: 'Pick a valid quotation status.' });

  const move = (MOVES[cur.status] || {})[target];
  if (!move) return res.status(400).json({ error: `A quotation that is “${LABELS[cur.status]}” can’t be moved to “${LABELS[target]}”.` });
  if (!move.roles.includes(req.session.role)) {
    return res.status(403).json({ error: `Moving a quotation to “${LABELS[target]}” must be done by ${move.who}.` });
  }
  const reason = text(req.body?.reason, 500);
  if (target === 'declined' && !reason) {
    return res.status(400).json({ error: 'Give a reason for declining, so the billing officer knows what to fix.' });
  }
  if ((target === 'for_review' || target === 'sent') && !cur.client_id) {
    return res.status(400).json({ error: 'Link this quotation to an existing client (Customer section) first. Finance sends it to the client through the client’s login.' });
  }

  const who = req.session.username;
  const person = db.prepare('SELECT full_name FROM users WHERE id = ?').get(req.session.userId);
  const set = {
    for_review: "submitted_at = datetime('now'), decline_reason = NULL, reviewed_by = NULL, reviewed_at = NULL",
    approved: "reviewed_by = @who, reviewed_at = datetime('now'), decline_reason = NULL, " +
      "approved_by_name = COALESCE(NULLIF(approved_by_name, ''), @name), approved_by_title = COALESCE(NULLIF(approved_by_title, ''), 'Finance / HR')",
    declined: "reviewed_by = @who, reviewed_at = datetime('now'), decline_reason = @reason",
    sent: "sent_by = @who, sent_at = datetime('now')"
  }[target];
  db.prepare(`UPDATE quotations SET status = @target, ${set ? set + ',' : ''} updated_at = datetime('now') WHERE id = @id`)
    .run({ target, id, who, name: person ? person.full_name : who, reason });

  const q = load(id);
  const ids = (sql, ...a) => db.prepare(sql).all(...a).map((u) => u.id);
  const label = `${q.quote_no} — ${q.customer_name}`;
  if (target === 'for_review') {
    notifyUsers(ids("SELECT id FROM users WHERE active = 1 AND role = 'finance_hr'"), q, `Quotation to review: ${label}`,
      `${q.quote_no} for ${q.customer_name} (${peso(q.total)}) is waiting for your review. Accept it to send it to the client, or decline it with a reason.`);
  } else if (target === 'approved' || target === 'declined') {
    const mine = ids('SELECT id FROM users WHERE active = 1 AND username = ?', q.created_by || '');
    const staff = mine.length ? mine : ids("SELECT id FROM users WHERE active = 1 AND role = 'billing_officer'");
    notifyUsers(staff, q, target === 'approved' ? `Quotation accepted: ${label}` : `Quotation declined: ${label}`,
      target === 'approved' ? `Finance accepted ${q.quote_no}. Finance will send it to the client.`
        : `Finance declined ${q.quote_no}.\nReason: ${reason}\nFix it and send it for review again.`);
  } else if (target === 'sent') {
    notifyUsers(ids("SELECT id FROM users WHERE active = 1 AND role = 'viewer' AND client_id = ?", q.client_id), q, `New quotation: ${q.quote_no}`,
      `Mirae ESP has sent you quotation ${q.quote_no} (${peso(q.total)}), valid until ${q.valid_until}. Open the Quotations page to view or print it.`);
  }
  audit.log(req, 'quotation', id, 'status', `Quotation ${cur.quote_no}: ${LABELS[cur.status]} \u2192 ${LABELS[target]}${reason ? ` (${reason})` : ''}`);
  res.json(q);
});

router.delete('/:id', canEdit, (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM quotations WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ error: 'Quotation not found.' });
  if (!EDITABLE.includes(cur.status) && req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Only an administrator can delete a quotation that has gone for review or been sent.' });
  }
  db.transaction(() => {
    db.prepare('DELETE FROM quotation_items WHERE quotation_id = ?').run(id);
    db.prepare('DELETE FROM quotations WHERE id = ?').run(id);
  })();
  audit.log(req, 'quotation', id, 'delete', `Deleted quotation ${cur.quote_no}`);
  res.json({ ok: true });
});

module.exports = router;
