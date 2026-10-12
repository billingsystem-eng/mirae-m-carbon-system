/**
 * M-Carbon Dashboard client.
 *
 * This talks to the same private JSON API the dashboard's own web app uses
 * (captured from the browser's Network tab — there is no public documentation
 * for it). Section 5 of the scope document.
 *
 * IMPORTANT — the baseline field is unverified.
 * The dashboard's UI never labels or displays a "baseline" number anywhere.
 * `statisticsBigScreen` returns a `beforeSave` field that is internally
 * consistent with the savings percentage and peso figures the UI *does*
 * show (beforeSave - afterSave = powerSave, and that ratio matches
 * powerSaveRatio exactly). That's good evidence it behaves like a baseline
 * inside the dashboard's own math, but it has not been checked against a
 * real project's known pre-retrofit baseline. Until that's confirmed,
 * treat `suggestedBaselineDailyKwh` as a suggestion for the billing
 * officer to review, not an authoritative figure — the worksheet keeps it
 * as a normal editable field for this reason.
 *
 * Requires Node 18+ (uses the global fetch). If this is deployed somewhere
 * with an older Node, add the `node-fetch` package and require it here.
 */

const BASE = process.env.MCARBON_BASE_URL;
const MOBILE = process.env.MCARBON_PHONE;
const PASSWORD = process.env.MCARBON_PASSWORD;

let cachedToken = null;
let cachedCookie = null;
let tokenExpiresAt = 0;

async function login() {
  if (!BASE || !MOBILE || !PASSWORD) {
    throw new Error('Set MCARBON_BASE_URL, MCARBON_PHONE and MCARBON_PASSWORD in .env first.');
  }
  const res = await fetch(`${BASE}/api/nrg/bigscreen/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', appType: '1002' },
    body: JSON.stringify({ mobile: MOBILE, password: PASSWORD })
  });
  const json = await res.json();
  if (json.code !== '000000') {
    throw new Error(`Dashboard login failed: ${json.message || json.code}`);
  }
  const setCookie = res.headers.get('set-cookie') || '';
  const jsessionMatch = setCookie.match(/JSESSIONID=[^;]+/);
  cachedToken = json.data.token;
  cachedCookie = jsessionMatch ? jsessionMatch[0] : null;

  // The JWT carries its own expiry — decode it (it's just base64, not
  // encrypted) so we know when to re-login instead of guessing a TTL.
  try {
    const payload = JSON.parse(Buffer.from(cachedToken.split('.')[1], 'base64').toString('utf8'));
    tokenExpiresAt = (payload.exp || 0) * 1000;
  } catch {
    tokenExpiresAt = Date.now() + 60 * 60 * 1000; // fallback: re-login hourly
  }
  return cachedToken;
}

async function ensureToken() {
  if (!cachedToken || Date.now() > tokenExpiresAt - 60000) await login();
  return cachedToken;
}

async function call(path, body) {
  const token = await ensureToken();
  const headers = { 'content-type': 'application/json; charset=utf-8', appType: '1002', token };
  if (cachedCookie) headers.cookie = `think_lang=en-us; ${cachedCookie}`;
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  const json = await res.json();
  if (json.code !== '000000') {
    throw new Error(`Dashboard error on ${path}: ${json.message || json.code}`);
  }
  return json.data;
}

/**
 * Every project visible to this account, flattened from the four-level
 * drill-down the dashboard's own overview page uses:
 *
 *   statistics (no input)            -> data.getProvinceProject: [{provinceName, projectCount}]
 *   getProvinceProject(name, count)  -> [{cityId, projectCount}]      (despite the name, returns cities)
 *   getCityProject(cityId, count)    -> [{districtId}]                (returns districts)
 *   getDistrictProject(districtId)   -> [{projectId, familyId, projectName, districtName}]
 *
 * Returns { project_id, family_id, name, district }[].
 */
async function listProjects() {
  const overview = await call('/api/iotphp/bigScreenAgent/statistics', {});
  const provinces = overview.getProvinceProject || [];
  const out = [];
  for (const prov of provinces) {
    const cities = await call('/api/iotphp/bigScreenAgent/getProvinceProject', {
      provinceName: prov.provinceName,
      projectCount: String(prov.projectCount)
    });
    for (const city of cities || []) {
      const districts = await call('/api/iotphp/bigScreenAgent/getCityProject', {
        cityId: String(city.cityId),
        projectCount: String(city.projectCount)
      });
      for (const district of districts || []) {
        const projects = await call('/api/iotphp/bigScreenAgent/getDistrictProject', {
          districtId: String(district.districtId),
          projectName: ''
        });
        for (const p of projects || []) {
          out.push({
            project_id: p.projectId,
            family_id: p.familyId,
            name: p.projectName,
            district: p.districtName
          });
        }
      }
    }
  }
  return out;
}

/**
 * Daily actual consumption + suggested baseline for one project, one
 * calendar month. `month` is 'YYYY-M' (no leading zero on the month —
 * matches what the dashboard's own frontend sends, e.g. '2026-9').
 */
async function getMonthStats(familyId, month) {
  const data = await call('/api/iotphp/conservation/statisticsBigScreen', {
    familyId, type: 2, date: month
  });
  const [year, mon] = month.split('-').map(Number);
  const daysInMonth = new Date(year, mon, 0).getDate();

  const dailyKwh = {};
  for (const row of data.powerDetail || []) {
    if (!row.key || row.key > daysInMonth) continue; // padding rows for short months
    const d = String(row.key).padStart(2, '0');
    const m = String(mon).padStart(2, '0');
    dailyKwh[`${year}-${m}-${d}`] = Number(row.value) || 0;
  }

  return {
    dailyKwh,
    actualTotalKwh: Number(data.afterSave) || 0,
    suggestedBaselineKwh: Number(data.beforeSave) || 0,
    suggestedBaselineDailyKwh: daysInMonth ? (Number(data.beforeSave) || 0) / daysInMonth : 0,
    raw: data
  };
}

/**
 * Same as getMonthStats but for an arbitrary date range, which may span
 * more than one calendar month (billing periods don't always land on
 * month boundaries). Pulls every month the range touches and merges them.
 */
async function getRangeStats(familyId, periodStart, periodEnd) {
  const months = new Set();
  const d = new Date(periodStart + 'T00:00:00Z');
  const last = new Date(periodEnd + 'T00:00:00Z');
  while (d <= last) {
    months.add(`${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`);
    d.setUTCDate(d.getUTCDate() + 1);
  }

  const dailyKwh = {};
  let baselineDailySum = 0;
  let baselineDailyCount = 0;
  for (const month of months) {
    const stats = await getMonthStats(familyId, month);
    Object.assign(dailyKwh, stats.dailyKwh);
    baselineDailySum += stats.suggestedBaselineDailyKwh;
    baselineDailyCount += 1;
  }

  const inRange = {};
  for (const [date, kwh] of Object.entries(dailyKwh)) {
    if (date >= periodStart && date <= periodEnd) inRange[date] = kwh;
  }

  return {
    dailyKwh: inRange,
    actualTotalKwh: Object.values(inRange).reduce((s, v) => s + v, 0),
    // Averaged across the months touched — a period spanning two months
    // gets the average of each month's suggested daily baseline.
    suggestedBaselineDailyKwh: baselineDailyCount ? baselineDailySum / baselineDailyCount : 0
  };
}

module.exports = { login, call, listProjects, getMonthStats, getRangeStats };