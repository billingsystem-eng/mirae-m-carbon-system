require('dotenv').config();

const express = require('express');
const session = require('express-session');
const path = require('path');

const { requireAuth, viewerScope } = require('./middleware/auth');
const { invoiceReady } = require('./lib/invoice-ready');
const authRouter = require('./routes/auth');
const clientsRouter = require('./routes/clients');
const projectsRouter = require('./routes/projects');
const billsRouter = require('./routes/bills');
const reportsRouter = require('./routes/reports');
const monitorRouter = require('./routes/monitor');
const paymentMethodsRouter = require('./routes/payment-methods');
const psgcRouter = require('./routes/psgc');
const quotationsRouter = require('./routes/quotations');
const invoicesRouter = require('./routes/invoices');
const onlinePayments = require('./routes/online-payments');
const messagesRouter = require('./routes/messages');
const notificationsRouter = require('./routes/notifications');
const notify = require('./lib/notify');

const db = require('./db'); // opens the database and creates tables on first run

const app = express();
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1);
// PayMongo webhook: needs the RAW body (for the signature check), so it is mounted before express.json.
// No session here - PayMongo calls it directly; the signature is what authenticates it.
app.post('/api/online-payments/webhook', express.raw({ type: () => true, limit: '1mb' }), onlinePayments.webhook);

app.use(express.json({ limit: '2mb' }));

app.use(session({
  // In production, set SESSION_SECRET in your environment instead of using this default.
  secret: process.env.SESSION_SECRET || 'm-carbon-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: PROD,
    maxAge: 8 * 60 * 60 * 1000 // 8 hours
  }
}));

app.use('/api/auth', authRouter);
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/', (req, res) => {
  if (!req.session?.userId) return res.redirect('/login.html');
  res.redirect(req.session.role === 'viewer' ? '/bills.html' : '/dashboard.html');
});

// Viewers (client logins) get their issued bills, quotations, live monitor and payment methods — read-only.
const VIEWER_PAGES = new Set(['/bills.html', '/bill.html', '/statement.html', '/invoice.html', '/payment-methods.html', '/messages.html', '/notifications.html',
  '/quotations.html', '/quotation-print.html', '/monitor.html', '/products.html']);
app.get(/\.html$/, (req, res, next) => {
  if (req.session?.userId && req.session.role === 'viewer' &&
      req.path !== '/login.html' && !VIEWER_PAGES.has(req.path)) {
    return res.redirect('/bills.html');
  }
  // Clients only get the Sales Invoice once that bill is fully paid.
  if (req.path === '/invoice.html' && req.session?.userId && req.session.role === 'viewer') {
    const billId = Number(req.query.id);
    const scope = viewerScope(req);
    const bill = billId && db.prepare('SELECT client_id FROM bills WHERE id = ?').get(billId);
    if (!bill || !scope || !scope.clientId || bill.client_id !== scope.clientId || !invoiceReady(billId)) {
      return res.redirect(billId ? '/bill.html?id=' + billId : '/bills.html');
    }
  }
  next();
});

// Everything below requires a logged-in session
app.use('/api/clients', requireAuth, clientsRouter);
app.use('/api/projects', requireAuth, projectsRouter);
app.use('/api/bills', requireAuth, billsRouter);
app.use('/api/reports', requireAuth, reportsRouter);
app.use('/api/monitor', requireAuth, monitorRouter); // live M-Carbon monitor (map, sites, meters)
app.use('/api/payment-methods', requireAuth, paymentMethodsRouter);
app.use('/api/psgc', requireAuth, psgcRouter);
app.use('/api/quotations', requireAuth, quotationsRouter);
app.use('/api/invoices', requireAuth, invoicesRouter);
app.use('/api/notifications', requireAuth, notificationsRouter);   // payment reminders (due soon / overdue)
app.use('/api/messages', requireAuth, messagesRouter);   // payment chat: client <-> finance, per bill
app.use('/api/online-payments', requireAuth, onlinePayments.router);   // PayMongo checkout   // scanned Sales Invoice copies

app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'The server could not complete that request.' });
});

app.listen(PORT, () => {
  console.log(`M-Carbon Billing System running on http://localhost:${PORT}`);
  notify.start();
});