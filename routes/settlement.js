'use strict';
/*
  Settlement details API (mounted at /api/settlement, behind the login).

  Monthly energy usage and savings for each site, read straight from the M-Carbon Dashboard's own
  month statistics. It does NOT read the bills table: a month shows up as soon as the dashboard has data
  for it, with no draft / review / approval / issue steps in between.

    baseline  = the dashboard's "before" figure for the month (beforeSave)
    actual    = the dashboard's "after" figure for the month (afterSave)
    savings   = baseline - actual
    amount    = the dashboard's savings in won (saveFee); falls back to savings x the dashboard's unit price
    retained  = amount x the client's share (%) from the site's sharing ratio, when one is set up
    company   = amount x the company's (Mirae ESP) share (%) from the same sharing ratio

  A client login only sees its own sites (same scoping as the bills and the live monitor).
*/
const express = require('express');
const db = require('../db');
const dashboard = require('../lib/dashboard');
const { viewerScope } = require('../middleware/auth');
const { ratioFor } = require('../lib/billing');

const router = express.Router();
const RATE = Number(process.env.RATE_KRW_PER_KWH) || 150;   // only used if the dashboard sends no unit price
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

// The dashboard answers each month with one request; keep results so reopening the page is quick.
// Finished months hardly ever change, the running month is refreshed every few minutes.
const cache = new Map();
async function monthData(familyId, year, month, isCurrent) {
  const key = `${familyId}|${year}-${month}`, hit = cache.get(key);
  const ttl = isCurrent ? 5 * 60 * 1000 : 6 * 60 * 60 * 1000;
  if (hit && Date.now() - hit.at < ttl) return hit.v;
  const st = await dashboard.getMonthStats(familyId, `${year}-${month}`);
  const raw = st.raw || {};
  const baseline = Number(raw.beforeSave) || 0, actual = Number(raw.afterSave) || 0;
  const v = (baseline || actual) ? { baseline, actual, fee: Number(raw.saveFee) || 0, unit: Number(raw.fee) || 0 } : null;
  cache.set(key, { at: Date.now(), v });
  return v;
}

// Company share in won. When the two percentages add up to 100 it is the remainder of the client's
// rounded share, so the two columns always add up exactly to the savings amount.
function companyShare(amount, ratio) {
  if (Math.abs(Number(ratio.client_pct) + Number(ratio.ines_pct) - 100) < 0.005) {
    return Math.round(amount) - Math.round(amount * (ratio.client_pct / 100));
  }
  return Math.round(amount * (ratio.ines_pct / 100));
}

// Contract year (1-based) that a date falls in, counting from the contract start.
function contractYear(start, dateStr) {
  const s = new Date(start + 'T00:00:00'), d = new Date(dateStr + 'T00:00:00');
  let n = d.getFullYear() - s.getFullYear();
  const anniversary = new Date(s); anniversary.setFullYear(s.getFullYear() + n);
  if (d < anniversary) n -= 1;
  return Math.max(1, n + 1);
}

// The sharing ratios of one project as a "Year 1-3: client 20% / Mirae 80%" table.
// Years count from the contract start (or, with no start date, from the earliest ratio).
function sharingTable(projectId) {
  const contract = db.prepare('SELECT id, start_date, end_date FROM contracts WHERE project_id = ?').get(projectId);
  if (!contract) return [];
  const ratios = db.prepare('SELECT * FROM sharing_ratios WHERE contract_id = ? ORDER BY effective_from').all(contract.id);
  if (!ratios.length) return [];
  const start = contract.start_date || ratios[0].effective_from;
  const today = new Date().toISOString().slice(0, 10);
  const now = ratioFor(ratios, today);
  return ratios.map((r) => {
    const end = r.effective_to || contract.end_date || null;
    const from = contractYear(start, r.effective_from);
    const to = end ? Math.max(from, contractYear(start, end)) : null;     // null = continues until the contract ends
    return { id: r.id, label: r.label || null, from_year: from, to_year: to, client_pct: r.client_pct, mirae_pct: r.ines_pct, current: !!now && now.id === r.id };
  });
}

function projectsFor(req) {
  const scope = viewerScope(req);
  const cols = 'SELECT id, name, client_id, family_id FROM projects WHERE family_id IS NOT NULL';
  if (!scope) return db.prepare(cols + ' ORDER BY id').all();
  if (scope.projectIds) {
    if (!scope.projectIds.length) return [];
    return db.prepare(`${cols} AND id IN (${scope.projectIds.map(Number).join(',')}) ORDER BY id`).all();
  }
  return scope.clientId ? db.prepare(cols + ' AND client_id = ? ORDER BY id').all(scope.clientId) : [];
}

router.get('/', async (req, res) => {
  const now = new Date();
  const year = Number(req.query.year) || now.getFullYear();
  const lastMonth = year < now.getFullYear() ? 12 : year === now.getFullYear() ? now.getMonth() + 1 : 0;

  const projects = projectsFor(req);
  const out = [], errors = [];
  for (const p of projects) {
    const ratios = db.prepare(`SELECT sr.* FROM sharing_ratios sr JOIN contracts c ON c.id = sr.contract_id WHERE c.project_id = ?`).all(p.id);
    const months = Array.from({ length: 12 }, () => null);
    const todo = Array.from({ length: lastMonth }, (_, i) => i + 1);
    for (let i = 0; i < todo.length; i += 6) {                       // a few requests at a time
      await Promise.all(todo.slice(i, i + 6).map(async (m) => {
        try {
          const d = await monthData(p.family_id, year, m, year === now.getFullYear() && m === now.getMonth() + 1);
          if (!d) return;
          const savings = d.baseline - d.actual;
          const amount = d.fee || (savings > 0 ? savings * (d.unit || RATE) : 0);
          const end = `${year}-${String(m).padStart(2, '0')}-${String(new Date(year, m, 0).getDate()).padStart(2, '0')}`;
          const ratio = ratioFor(ratios, end);
          months[m - 1] = {
            baseline_kwh: r2(d.baseline), actual_kwh: r2(d.actual), energy_savings_kwh: r2(savings),
            gross_savings: Math.round(amount),
            client_retained: ratio ? Math.round(amount * (ratio.client_pct / 100)) : null,
            company_retained: ratio ? companyShare(amount, ratio) : null,
            client_pct: ratio ? ratio.client_pct : null,
            company_pct: ratio ? ratio.ines_pct : null
          };
        } catch (e) {
          errors.push(`${p.name}: ${e.message}`);
        }
      }));
    }
    out.push({ id: p.id, name: p.name, months, sharing: sharingTable(p.id) });
  }
  res.json({ year, projects: out, errors: [...new Set(errors)].slice(0, 3) });
});

module.exports = router;
