# M-Carbon LED Billing System

Savings-based billing for Mirae ESP' M-Carbon LED retrofit projects, built to the
scope document. This build covers the **standalone / manual mode**: consumption is entered
by hand, the engine computes the baseline, savings and sharing split, and the system
produces a traceable utility-style statement.

## Running it

```bash
npm install
cp .env.example .env      # set SESSION_SECRET and ADMIN_PASSWORD
npm start                 # http://localhost:3000
```

On first run the database is created at `./data/mcarbon.db` and an `admin` account is
seeded with `ADMIN_PASSWORD` (default `changeme123`). Sign in and change it from **Users**.

Deploying to Railway: set `SESSION_SECRET`, `ADMIN_PASSWORD` and `NODE_ENV=production`.
Attach a volume mounted at `/data` and set `DATA_DIR=/data`, otherwise the SQLite file is
wiped on every deploy.

## How a month runs

1. **Clients & projects** — add the client, contacts and billing address, then a project
   site with its lighting details and devices.
2. **Project page** — set the contract dates, payment terms, default baseline method,
   dashboard daily baseline or agreed savings percentage, electricity rates, and the
   sharing ratios by effective date.
3. **Billing → Start a billing period** — pick the site and the data collection period.
4. **Worksheet** — enter consumption, allocate savings across rate lines, and watch the
   calculation record on the right rebuild itself step by step. It shows every figure that
   will be frozen onto the statement, and flags problems (negative savings, rate lines that
   don't add up to total savings, shares that don't total 100%).
5. **Save and compute**, then move the bill along: draft → for review → approved →
   final → issued. Marking final requires an administrator, and locks the calculation.
6. **View statement** to print or save as PDF. Record payments and adjustments against it.

A finalised statement can't be edited. **Create revision** copies it into a new linked
statement (`…-R001`) and leaves the original on record.

## Online payment (PayMongo)

Clients can pay an issued bill from their login: **Pay ₱… online** on the bill page opens
PayMongo's hosted checkout (GCash, cards, QR Ph — whatever you enable in PayMongo).

- The server works out the amount owed; the browser never sends it.
- The payment is recorded only when PayMongo's signed webhook arrives
  (`POST /api/online-payments/webhook`) — never from the redirect back to the site. Retried
  deliveries are de-duplicated by event id.
- It is recorded as a normal payment (method "PayMongo online") and shows in the audit trail.
  Finance still confirms it before the client sees the Sales Invoice, unless
  `PAYMONGO_AUTO_CONFIRM=true`.
- Setup is in `.env.example`. Test with `sk_test_…` keys first. The webhook URL must be public
  HTTPS (on localhost use a tunnel such as ngrok).

## Baseline methods

| Method | Formula |
|---|---|
| 1 — Dashboard fixed baseline | average daily baseline × days in period |
| 2 — Agreed savings percentage | usage rate = 1 − agreed savings %; baseline = actual ÷ usage rate |
| 3 — Actual operating hours | per day: (daily baseline ÷ 24) × hours; summed over the period |

Then: savings = baseline − actual; gross savings = Σ (savings kWh × rate); Mirae ESP charge =
gross × Mirae ESP share; client retained = gross × client share.

## Structure

```
server.js            Express app and session setup
db/index.js          SQLite schema, migrations-on-boot, admin seed
lib/billing.js       The computation engine — all formulas live here
lib/audit.js         Change logging
middleware/auth.js   requireAuth, requireRole, canEdit
routes/              auth, clients, projects, bills, reports
public/              login, dashboard, clients, client, project, bills,
                     bill (worksheet), statement, users, audit
```

## Roles

- **Administrator** — everything, including marking a bill final, voiding, and user management.
- **Billing officer** — client/project data, computations, statements, payments, approvals.
- **Viewer** — read-only.

## Still to do

- **Fill in the provider block.** `public/statement.html` has Mirae ESP address, TIN, contact and
  logo as placeholders in the `PROVIDER` constant.
- **Dashboard integration is wired up** (Section 5 of the scope). `lib/dashboard.js` logs
  into the M-Carbon Dashboard's private API and pulls per-day actual consumption plus a
  *suggested* baseline for a project and date range. To use it: open a project's page,
  **Choose dashboard project** under "M-Carbon Dashboard link" and match it to the right
  site, then on any editable bill click **Pull from dashboard**. This fills the daily grid
  and `actual_kwh`, and sets the bill's `source` to `dashboard`.
  **Unverified:** the dashboard's UI never labels a "baseline" figure anywhere. The pulled
  baseline comes from a field (`beforeSave`) that's internally consistent with the savings
  % the dashboard *does* show, but hasn't yet been checked against a real project's known
  pre-retrofit baseline. Treat the pulled baseline as a starting point to review, not a
  final number, until that's confirmed against at least one site.
- **Excel import** for consumption data, as an alternative to the daily grid.
- **Automatic late-payment interest.** The contract stores the rate; the worksheet currently
  takes the interest amount as an entry rather than computing it.
- **Client/viewer portal** — listed as a low-priority future feature in the scope.
