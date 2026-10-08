const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'mcarbon.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'billing_officer',   -- admin | billing_officer | finance_hr | viewer
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY,
  account_no TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  tin TEXT,
  status TEXT NOT NULL DEFAULT 'Ongoing Data Collection',
  addr_unit TEXT, addr_building TEXT, addr_street TEXT, addr_barangay TEXT,
  addr_city TEXT, addr_region TEXT, addr_country TEXT DEFAULT 'Philippines', addr_zip TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL, position TEXT, phone TEXT, email TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address TEXT,
  lighting_type TEXT,
  lighting_qty INTEGER,
  operating_brightness TEXT,
  saving_brightness TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  device_type TEXT, device_no TEXT
);

-- One active contract / billing configuration per project.
CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  start_date TEXT, end_date TEXT,
  late_interest_rate REAL DEFAULT 0,          -- % per day on overdue balance, applied automatically per bill
  settlement_day INTEGER DEFAULT 25,          -- cut-off day of month
  bill_day INTEGER DEFAULT 1,
  payment_terms_days INTEGER DEFAULT 15,
  baseline_method TEXT DEFAULT 'fixed',       -- fixed | savings_pct | operating_hours
  dashboard_daily_baseline REAL,              -- kWh/day
  agreed_savings_pct REAL,                    -- e.g. 67.5 (percent)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sharing_ratios (
  id INTEGER PRIMARY KEY,
  contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  label TEXT,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  ines_pct REAL NOT NULL,
  client_pct REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS rates (
  id INTEGER PRIMARY KEY,
  contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  label TEXT NOT NULL,                        -- e.g. "Solar 07:00-15:00"
  rate REAL NOT NULL,                         -- PHP per kWh
  time_from TEXT, time_to TEXT,
  effective_from TEXT, effective_to TEXT
);

CREATE TABLE IF NOT EXISTS bills (
  id INTEGER PRIMARY KEY,
  statement_no TEXT UNIQUE NOT NULL,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  contract_id INTEGER NOT NULL REFERENCES contracts(id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  days INTEGER NOT NULL,
  bill_date TEXT, due_date TEXT,
  source TEXT NOT NULL DEFAULT 'manual',      -- manual | dashboard
  baseline_method TEXT NOT NULL,
  inputs_json TEXT NOT NULL DEFAULT '{}',     -- frozen calculation inputs
  baseline_kwh REAL DEFAULT 0,
  actual_kwh REAL DEFAULT 0,
  energy_savings_kwh REAL DEFAULT 0,
  rate_breakdown_json TEXT NOT NULL DEFAULT '[]',
  gross_savings REAL DEFAULT 0,
  ines_pct REAL DEFAULT 0,
  client_pct REAL DEFAULT 0,
  amount_billed REAL DEFAULT 0,
  client_retained REAL DEFAULT 0,
  previous_balance REAL DEFAULT 0,
  interest_charged REAL DEFAULT 0,
  total_due REAL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',       -- draft|for_review|approved|final|issued|void
  notes TEXT,
  revises_bill_id INTEGER REFERENCES bills(id),
  created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finalized_at TEXT, issued_at TEXT
);

CREATE TABLE IF NOT EXISTS bill_days (
  id INTEGER PRIMARY KEY,
  bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  day_date TEXT NOT NULL,
  actual_kwh REAL DEFAULT 0,
  operating_hours REAL,
  baseline_kwh REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  paid_on TEXT NOT NULL,
  amount REAL NOT NULL,
  reference TEXT, method TEXT,
  created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS adjustments (
  id INTEGER PRIMARY KEY,
  bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  adjusted_on TEXT NOT NULL,
  amount REAL NOT NULL,                       -- negative = credit
  reason TEXT NOT NULL,
  created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  username TEXT,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT
);

-- Ways a client can pay Mirae ESP. Active ones print on every billing statement.
CREATE TABLE IF NOT EXISTS payment_methods (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,                         -- e.g. "Bank transfer — BDO"
  details TEXT,                               -- account name / number / instructions
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Outright-purchase quotations (no contract / monthly billing)
CREATE TABLE IF NOT EXISTS quotations (
  id INTEGER PRIMARY KEY,
  quote_no TEXT NOT NULL UNIQUE,              -- e.g. MC2026-001
  quote_date TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  client_id INTEGER REFERENCES clients(id),   -- optional link to an existing client
  customer_name TEXT NOT NULL,
  client_ref_id TEXT,                         -- the client's own PR / reference number
  submitted_by TEXT,
  contact_no TEXT,
  vat_rate REAL NOT NULL DEFAULT 12,
  terms TEXT,
  prepared_by_name TEXT, prepared_by_title TEXT,
  approved_by_name TEXT, approved_by_title TEXT,
  contact_name TEXT, contact_phone TEXT, contact_email TEXT,
  status TEXT NOT NULL DEFAULT 'draft',       -- draft | sent | accepted | paid | declined
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS quotation_items (
  id INTEGER PRIMARY KEY,
  quotation_id INTEGER NOT NULL REFERENCES quotations(id),
  position INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT 'pieces',
  unit_price REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_quotation_items ON quotation_items(quotation_id, position);

CREATE INDEX IF NOT EXISTS idx_bills_client ON bills(client_id, period_start);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);
`);

// --- Migrations: columns added after the initial schema, applied on boot ---
// SQLite has no "ADD COLUMN IF NOT EXISTS", so these are wrapped in try/catch
// and simply no-op once the column already exists.
function addColumn(table, def) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${def}`); } catch (e) { /* already exists */ }
}
addColumn('projects', 'family_id TEXT');
addColumn('projects', 'family_id_name TEXT');       // snapshot of the dashboard site's name at link time
addColumn('projects', 'family_id_district TEXT');   // snapshot of its district at link time, for display + drift checks
addColumn('bills', 'dashboard_synced_at TEXT');
// A viewer is a client login: they only ever see data belonging to this client.
addColumn('users', 'client_id INTEGER REFERENCES clients(id)');
// Payment-method approval: only an admin can approve. Existing rows default to
// 'approved' so statements keep printing them; new rows are inserted explicitly.
addColumn('payment_methods', "approval_status TEXT NOT NULL DEFAULT 'approved'"); // pending | approved
addColumn('payment_methods', 'approved_by TEXT');
addColumn('payment_methods', 'approved_at TEXT');
addColumn('payment_methods', 'created_by TEXT');
addColumn('quotations', 'project_site TEXT');          // optional "Project Site" shown under the customer name
addColumn('quotation_items', 'unit_material REAL NOT NULL DEFAULT 0');
addColumn('quotation_items', 'unit_labor REAL NOT NULL DEFAULT 0');
// Older quotations only had one unit price: treat it as the material cost.
// unit_price is kept as material + labor so existing totals/list queries keep working.
db.exec("UPDATE quotation_items SET unit_material = unit_price WHERE unit_material = 0 AND unit_labor = 0 AND unit_price > 0");     

// Two-step approval record: 1) administrator, 2) finance / HR. Both are needed before a bill is final and can be issued.
addColumn('bills', 'admin_approved_by TEXT');
addColumn('bills', 'admin_approved_at TEXT');
addColumn('bills', 'finance_approved_by TEXT');
addColumn('bills', 'finance_approved_at TEXT');
addColumn('bills', 'payment_confirmed_by TEXT');   // finance confirms the payment was actually received
addColumn('bills', 'payment_confirmed_at TEXT');

// Bills approved/finalised/issued before two-step approval existed: mark the steps as already satisfied.
db.exec(`UPDATE bills SET admin_approved_by = 'Recorded before two-step approval' WHERE admin_approved_by IS NULL AND status IN ('approved','final','issued');
UPDATE bills SET finance_approved_by = 'Recorded before two-step approval' WHERE finance_approved_by IS NULL AND status IN ('final','issued');`);

// Scanned copies of the Sales Invoice, attached once a bill or quotation has been paid.
db.exec(`CREATE TABLE IF NOT EXISTS invoice_files (
  id INTEGER PRIMARY KEY,
  entity TEXT NOT NULL,                       -- bill | quotation
  entity_id INTEGER NOT NULL,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invoice_files ON invoice_files(entity, entity_id);`);

// Online payments through the PayMongo hosted checkout. One row per checkout session we create;
// the webhook marks it paid and records the payment on the bill. webhook_events de-duplicates
// PayMongo's retried deliveries so a payment can never be recorded twice.
db.exec(`CREATE TABLE IF NOT EXISTS online_payments (
  id INTEGER PRIMARY KEY,
  bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  reference TEXT NOT NULL UNIQUE,             -- reference_number we send to PayMongo
  session_id TEXT,                            -- PayMongo checkout session id (cs_...)
  amount REAL NOT NULL,                       -- pesos requested
  status TEXT NOT NULL DEFAULT 'pending',     -- pending | paid
  checkout_url TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT,
  provider_payment_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_online_payments_bill ON online_payments(bill_id);
CREATE INDEX IF NOT EXISTS idx_online_payments_session ON online_payments(session_id);
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);

// Payment chat between ONE client login and Mirae ESP staff. A conversation is identified by
// (bill, client login): client_user_id is the viewer who owns it. Two logins of the same client
// never see each other's messages; staff see every conversation.
//   side = 'client' (the viewer wrote it) or 'staff' (admin / billing officer / finance-HR wrote it).
// bill_thread_reads remembers, per conversation and reader, the last message seen (for unread badges).
const threadReadsExisted = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bill_thread_reads'").get();
db.exec(`CREATE TABLE IF NOT EXISTS bill_messages (
  id INTEGER PRIMARY KEY,
  bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  user_id INTEGER,
  sender_name TEXT NOT NULL,
  sender_role TEXT NOT NULL,
  side TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bill_messages_bill ON bill_messages(bill_id, id);
CREATE TABLE IF NOT EXISTS bill_thread_reads (
  bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  thread_user_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  last_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bill_id, thread_user_id, user_id)
);`);
addColumn('bill_messages', 'client_user_id INTEGER');   // the client login the conversation belongs to
db.exec('CREATE INDEX IF NOT EXISTS idx_bill_messages_thread ON bill_messages(bill_id, client_user_id, id)');

// Messages written while every login of a client shared one thread get an owner here (idempotent: only
// rows without one are touched). Client messages belong to their author. A staff message belongs to the
// client login who wrote most recently before it on that bill, else to the client's only login.
db.exec(`UPDATE bill_messages SET client_user_id = user_id WHERE client_user_id IS NULL AND side = 'client';
UPDATE bill_messages SET client_user_id = (
  SELECT c.client_user_id FROM bill_messages c
  WHERE c.bill_id = bill_messages.bill_id AND c.side = 'client' AND c.id < bill_messages.id AND c.client_user_id IS NOT NULL
  ORDER BY c.id DESC LIMIT 1)
WHERE client_user_id IS NULL AND side = 'staff';
UPDATE bill_messages SET client_user_id = (
  SELECT u.id FROM users u JOIN bills b ON b.client_id = u.client_id
  WHERE b.id = bill_messages.bill_id AND u.role = 'viewer' AND u.active = 1)
WHERE client_user_id IS NULL AND side = 'staff' AND (
  SELECT COUNT(*) FROM users u JOIN bills b ON b.client_id = u.client_id
  WHERE b.id = bill_messages.bill_id AND u.role = 'viewer' AND u.active = 1) = 1;`);

// One time: carry the old per-bill "last seen" pointers over to each conversation of that bill, so nothing
// that was already read shows as unread again.
if (!threadReadsExisted && db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bill_message_reads'").get()) {
  db.exec(`INSERT OR IGNORE INTO bill_thread_reads (bill_id, thread_user_id, user_id, last_id)
    SELECT r.bill_id, t.client_user_id, r.user_id, r.last_id
    FROM bill_message_reads r
    JOIN (SELECT DISTINCT bill_id, client_user_id FROM bill_messages WHERE client_user_id IS NOT NULL) t ON t.bill_id = r.bill_id`);
}

// Seed a first administrator so the app is usable on first run.
const count = db.prepare('SELECT COUNT(*) c FROM users').get().c;
if (count === 0) {
  const pw = process.env.ADMIN_PASSWORD || 'changeme123';
  db.prepare(
    'INSERT INTO users (username, password_hash, full_name, role) VALUES (?,?,?,?)'
  ).run('admin', bcrypt.hashSync(pw, 10), 'System Administrator', 'admin');
  console.log(`[db] Seeded administrator "admin" with password "${pw}" — change it after first login.`);
}

module.exports = db;