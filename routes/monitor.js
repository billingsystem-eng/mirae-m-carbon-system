'use strict';
/*
  Live monitor API (mounted at /api/monitor, behind the billing app's login).

  browser  <--REST + Server-Sent Events-->  this router  <--provider-->  lib/monitor/*.js

  A provider is the only place that knows where readings come from. The interface is
  documented at the top of lib/monitor/mock.js. MONITOR_MODE picks one:
    mock  generated sample data (default, safe for trying the page out)
    live  the M-Carbon Dashboard, through lib/monitor/live.js
*/
const express = require('express');
const db = require('../db');
const { viewerScope } = require('../middleware/auth');

const MODE = process.env.MONITOR_MODE === 'live' ? 'live' : 'mock';
const RATE = Number(process.env.RATE_PHP_PER_KWH) || 11.5; // PHP per kWh, for the cost estimate
const POLL_MS = Number(process.env.POLL_MS) || 2000;
const RING = 90; // live points kept per site (90 x 2 s = 3 minutes)

const provider = require(MODE === 'live' ? '../lib/monitor/live' : '../lib/monitor/mock');

const router = express.Router();

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error('[monitor]', e.message);
    res.status(502).json({ error: e.message || 'Data source error' });
  });
const round = (n, d = 1) => Number(Number(n).toFixed(d));
const sum = (rows) => rows.reduce((s, p) => s + p.kwh, 0);

/* A client login (viewer) only sees the dashboard sites linked to its own client's projects
   (projects.family_id). Anything else answers 404, whatever the page asks for. */
router.use((req, res, next) => {
  const scope = viewerScope(req);
  if (!scope) return next();
  req.allowedSites = new Set(scope.clientId
    ? db.prepare('SELECT family_id FROM projects WHERE client_id = ? AND family_id IS NOT NULL').all(scope.clientId)
        .map((r) => String(r.family_id))
    : []);
  next();
});
router.param('id', (req, res, next, id) => {
  if (req.allowedSites && !req.allowedSites.has(String(id))) return res.status(404).json({ error: 'Site not found.' });
  next();
});

router.get('/config', (req, res) => res.json({ mode: MODE, rate: RATE, pollMs: POLL_MS }));

router.get('/projects', wrap(async (req, res) => {
  const list = await provider.listProjects();
  res.json(req.allowedSites ? list.filter((p) => req.allowedSites.has(String(p.id))) : list);
}));

// The national overview mixes every client's sites, so it is staff-only.
router.get('/overview', wrap(async (req, res) => {
  if (req.allowedSites) return res.status(403).json({ error: 'Your role does not allow this.' });
  res.json(await provider.overview());
}));

// Everything the dashboard's own site screen shows. Null when the provider (sample data) has no such figures.
router.get('/projects/:id/details', wrap(async (req, res) => res.json(provider.details ? await provider.details(req.params.id) : null)));

router.get('/projects/:id/meters', wrap(async (req, res) => res.json(await provider.listMeters(req.params.id))));

router.get('/projects/:id/history', wrap(async (req, res) => {
  const range = ['day', 'week', 'month'].includes(req.query.range) ? req.query.range : 'day';
  res.json(await provider.history(req.params.id, range));
}));

// "Used today" and "last 30 days". If the source has no hourly data, today's figure falls back
// to the last daily value, and a figure that cannot be worked out at all comes back as null.
router.get('/projects/:id/summary', wrap(async (req, res) => {
  const [day, month] = await Promise.allSettled([
    provider.history(req.params.id, 'day'),
    provider.history(req.params.id, 'month'),
  ]);
  if (day.status === 'rejected' && month.status === 'rejected') throw month.reason;
  const m = month.status === 'fulfilled' ? month.value : null;
  const todayKwh = day.status === 'fulfilled' ? sum(day.value) : m && m.length ? m[m.length - 1].kwh : null;
  const last30Kwh = m ? sum(m) : null;
  res.json({
    todayKwh: todayKwh == null ? null : round(todayKwh),
    last30Kwh: last30Kwh == null ? null : round(last30Kwh),
    rate: RATE,
    last30Cost: last30Kwh == null ? null : round(last30Kwh * RATE, 0),
  });
}));

/* ---------- live stream (Server-Sent Events) ----------
   One shared poller per site, no matter how many browsers are watching.
   The poller only runs while at least one browser is connected. The browser's session cookie
   authenticates the stream, so no token ever appears in a URL. */
const hubs = new Map();
const hubFor = (pid) => {
  if (!hubs.has(pid)) hubs.set(pid, { clients: new Set(), ring: [], timer: null });
  return hubs.get(pid);
};
const send = (hub, event, data) => {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of hub.clients) c.write(msg);
};

async function tick(pid, hub) {
  try {
    const readings = await provider.readNow(pid);
    const total = readings.reduce((s, r) => s + (r.on ? r.kw : 0), 0);
    const point = { t: Date.now(), total: round(total, 2), readings };
    hub.ring.push({ t: point.t, total: point.total });
    if (hub.ring.length > RING) hub.ring.shift();
    send(hub, 'reading', point);
  } catch (e) {
    send(hub, 'fault', { message: e.message });
  }
}

router.get('/projects/:id/stream', async (req, res) => {
  const pid = req.params.id;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const hub = hubFor(pid);
  if (!hub.ring.length && provider.recent) {
    try { hub.ring = await provider.recent(pid, RING, POLL_MS); } catch (_) { /* start empty */ }
  }
  res.write(`event: backlog\ndata: ${JSON.stringify(hub.ring)}\n\n`);
  hub.clients.add(res);

  if (!hub.timer) {
    tick(pid, hub);
    hub.timer = setInterval(() => tick(pid, hub), POLL_MS);
  }
  req.on('close', () => {
    hub.clients.delete(res);
    if (!hub.clients.size) { clearInterval(hub.timer); hub.timer = null; }
  });
});

router.use((req, res) => res.status(404).json({ error: 'Not found' }));

module.exports = router;