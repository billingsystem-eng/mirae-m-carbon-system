'use strict';
/*
  Finds out how the M-Carbon Dashboard returns a past month, a whole year and a single day, so the
  Year / Month / Day pickers on the Live monitor can be built on facts instead of guesses.

  Run from the project root (needs MCARBON_BASE_URL, MCARBON_PHONE, MCARBON_PASSWORD in .env):

    node tools/probe-periods.js                    first site found
    node tools/probe-periods.js --family 4982      a specific site

  It writes probe-output/periods.json and prints a short summary of every attempt. Send that file back.
  The only confirmed call so far is statisticsBigScreen with type 2 and date 'YYYY-M' for the current month.
*/
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const dashboard = require('../lib/dashboard');

const P = '/api/iotphp/conservation/statisticsBigScreen';
const shape = (d) => {
  if (d == null) return d;
  const rows = (k) => (Array.isArray(d[k]) ? { length: d[k].length, first: d[k].slice(0, 2), last: d[k].slice(-1) } : undefined);
  return {
    keys: Object.keys(d),
    afterSave: d.afterSave, beforeSave: d.beforeSave, powerSave: d.powerSave, throughput: d.throughput,
    powerDetail: rows('powerDetail'), throughputInfo: rows('throughputInfo'), throughputInfoHour: rows('throughputInfoHour'),
    latest24: d.latest24 && Array.isArray(d.latest24.powerList) ? { length: d.latest24.powerList.length, first: d.latest24.powerList.slice(0, 2) } : undefined,
  };
};

async function main() {
  const args = process.argv.slice(2);
  const fi = args.indexOf('--family');
  await dashboard.login();
  let familyId = fi >= 0 ? args[fi + 1] : null;
  if (!familyId) {
    const rows = await dashboard.listProjects();
    familyId = rows[0] && rows[0].family_id;
    console.log('Using site', rows[0] && rows[0].name, 'familyId', familyId);
  }
  const t = new Date(Date.now() + 9 * 3600e3), y = t.getUTCFullYear(), m = t.getUTCMonth() + 1, d = t.getUTCDate();
  const prev = m > 1 ? [y, m - 1] : [y - 1, 12];
  const tries = [
    ['this month (confirmed)', { type: 2, date: `${y}-${m}` }],
    ['last month', { type: 2, date: `${prev[0]}-${prev[1]}` }],
    ['two months ago', { type: 2, date: `${prev[1] > 1 ? prev[0] : prev[0] - 1}-${prev[1] > 1 ? prev[1] - 1 : 12}` }],
    ['year, type 3', { type: 3, date: `${y}` }],
    ['year, type 1', { type: 1, date: `${y}` }],
    ['year, type 4', { type: 4, date: `${y}` }],
    ['day, type 1, today', { type: 1, date: `${y}-${m}-${d}` }],
    ['day, type 1, yesterday', { type: 1, date: `${y}-${m}-${d - 1}` }],
    ['day, type 1, padded', { type: 1, date: `${y}-${String(m).padStart(2, '0')}-${String(d - 1).padStart(2, '0')}` }],
    ['day, type 3, yesterday', { type: 3, date: `${y}-${m}-${d - 1}` }],
  ];
  const out = {};
  for (const [label, body] of tries) {
    try {
      const data = await dashboard.call(P, { familyId, ...body });
      out[label] = { body, ok: true, shape: shape(data) };
      const pd = out[label].shape.powerDetail;
      console.log(`OK    ${label}  ${JSON.stringify(body)}  powerDetail rows: ${pd ? pd.length : '-'}  afterSave: ${data.afterSave}`);
    } catch (e) {
      out[label] = { body, ok: false, error: e.message };
      console.log(`FAIL  ${label}  ${JSON.stringify(body)}  ${e.message}`);
    }
  }
  const dir = path.join(__dirname, '..', 'probe-output');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'periods.json'), JSON.stringify(out, null, 2));
  console.log('\nwrote probe-output/periods.json - send that file back');
}
main().catch((e) => { console.error(e.message); process.exit(1); });