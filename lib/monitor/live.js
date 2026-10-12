'use strict';
/*
<<<<<<< HEAD
  Live provider for the monitor page: reads real data from the M-Carbon Dashboard (Korean site:
  dashboardko.mirae.m-carbonsolutions.com, set in .env; see MONITOR.md).
=======
  Live provider for the monitor page: reads real data from the M-Carbon Dashboard.
>>>>>>> 80e301041922043c733ee859525a80c8d7d6caaf

  It reuses lib/dashboard.js for the login and requests, because that code is the part
  already proven against the real API (mobile + password login, `token` header, appType 1002).

  Mapped so far (from responses the billing app already relies on, plus tools/probe-monitor.js):
    listProjects()          <- the province > city > district > project walk
    history(id, week|month) <- statisticsBigScreen.powerDetail (kWh per day)
    listMeters(id)          <- getMeterList (keyed by projectId, not familyId — translated below)
    readNow(id)             <- getMeterInfo per meter (voltage x current; see readNow for why)
    overview()              <- bigScreenAgent/statistics (some totals still unmapped — see buildOverview)

  Not mapped yet:
    history(id, day)        <- hourly figures for today
    getBreakerPowerUsed     <- returns all zeros for every body shape tried so far except
                                breakerId, which hasn't been tried yet — worth another probe

  To finish them, run `node tools/probe-monitor.js` and send back the files it writes to
  probe-output/. Each todo() below names the call it needs.
*/

const dashboard = require('../dashboard');

const todo = (what) => { throw new Error(`Not mapped yet: ${what}. Run tools/probe-monitor.js to capture it.`); };
const r2 = (n) => Number(Number(n).toFixed(2));

<<<<<<< HEAD
// The dashboard's "today" follows the site's local time. Korea Standard Time is UTC+9 with no daylight
// saving; MONITOR_TZ_OFFSET (hours) overrides it if this ever points at a dashboard in another zone.
const TZ_HOURS = process.env.MONITOR_TZ_OFFSET === undefined || process.env.MONITOR_TZ_OFFSET === '' ? 9 : Number(process.env.MONITOR_TZ_OFFSET);
const TZ_SUFFIX = `${TZ_HOURS < 0 ? '-' : '+'}${String(Math.abs(TZ_HOURS)).padStart(2, '0')}:00`;
const localNow = () => new Date(Date.now() + TZ_HOURS * 3600e3);
const localDate = (offsetDays = 0) =>
  new Date(Date.now() + TZ_HOURS * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);
=======
// Philippine time (UTC+8, no daylight saving) so "today" matches what the site shows.
const manilaDate = (offsetDays = 0) =>
  new Date(Date.now() + 8 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);
>>>>>>> 80e301041922043c733ee859525a80c8d7d6caaf

// Walking four levels of the project tree is slow, so keep the result for a few minutes.
let projectCache = { at: 0, rows: null };
async function projects() {
  if (!projectCache.rows || Date.now() - projectCache.at > 10 * 60e3) {
    const rows = await dashboard.listProjects();
    projectCache = { at: Date.now(), rows };
  }
  return projectCache.rows;
}

// listMeters/readNow are keyed by the dashboard's numeric projectId, but this module
// (and the rest of the app) addresses a site by familyId, so translate on the way in.
async function projectIdFor(familyId) {
  const rows = await projects();
  const row = rows.find((p) => String(p.family_id) === String(familyId));
  if (!row) throw new Error(`Unknown site ${familyId}`);
  return row.project_id;
}

// getMeterList and getMeterInfo results per site, kept briefly so a poll every couple of
// seconds isn't re-fetching the meter list on every tick.
let meterCache = new Map(); // familyId -> { at, meters: [{accessoryId, name, category, on}] }

// Confirmed against two real meters: DENR's offline meter reported isOnline: 2, Marco
// Polo's online one reported isOnline: 1. So 1 = online, 2 = (presumably) offline.
const meterIsOn = (m) => Number(m.isOnline) === 1;

async function fetchMeters(familyId) {
  const projectId = await projectIdFor(familyId);
  const data = await dashboard.call('/api/iotphp/agent/getMeterList', { projectId });
  const meters = (data.lists || []).map((m) => ({
    accessoryId: m.accessoryId,
    name: m.name || `Meter ${m.accessoryId}`,
    category: m.category,
    on: meterIsOn(m),
  }));
  meterCache.set(String(familyId), { at: Date.now(), meters });
  return meters;
}

async function cachedMeters(familyId) {
  const hit = meterCache.get(String(familyId));
  if (hit && Date.now() - hit.at < 60e3) return hit.meters;
  return fetchMeters(familyId);
}

const CO2_KG_PER_KWH = Number(process.env.CO2_KG_PER_KWH) || 0.785;

<<<<<<< HEAD
// The dashboard's own overview call gives province/city/district names, not lat/lon, so sites are
// pinned by place name here rather than individually. City-centre approximations (not checked against
// the Korean dashboard's own map). Names are matched in English and Hangul, ignoring suffixes such as
// -si / -gu / -do / "Metropolitan City" / 시 / 구 / 도, and the first place that matches wins, so a
// district is tried before its city. An unknown place is logged and pinned at the centre of Korea;
// add it here.
const PLACES = [
  ['Seoul', '서울', 37.5665, 126.9780], ['Busan', '부산', 35.1796, 129.0756], ['Incheon', '인천', 37.4563, 126.7052],
  ['Daegu', '대구', 35.8714, 128.6014], ['Daejeon', '대전', 36.3504, 127.3845], ['Gwangju', '광주', 35.1595, 126.8526],
  ['Ulsan', '울산', 35.5384, 129.3114], ['Sejong', '세종', 36.4800, 127.2890], ['Suwon', '수원', 37.2636, 127.0286],
  ['Seongnam', '성남', 37.4200, 127.1265], ['Goyang', '고양', 37.6584, 126.8320], ['Yongin', '용인', 37.2411, 127.1776],
  ['Bucheon', '부천', 37.5034, 126.7660], ['Ansan', '안산', 37.3219, 126.8309], ['Anyang', '안양', 37.3943, 126.9568],
  ['Namyangju', '남양주', 37.6360, 127.2165], ['Hwaseong', '화성', 37.1996, 126.8312], ['Pyeongtaek', '평택', 36.9921, 127.1128],
  ['Uijeongbu', '의정부', 37.7381, 127.0337], ['Paju', '파주', 37.7600, 126.7800], ['Gimpo', '김포', 37.6153, 126.7156],
  ['Gwangmyeong', '광명', 37.4786, 126.8646], ['Siheung', '시흥', 37.3800, 126.8030], ['Gunpo', '군포', 37.3617, 126.9352],
  ['Hanam', '하남', 37.5392, 127.2148], ['Gyeonggi', '경기', 37.4138, 127.5183], ['Chuncheon', '춘천', 37.8813, 127.7298],
  ['Wonju', '원주', 37.3422, 127.9202], ['Gangneung', '강릉', 37.7519, 128.8761], ['Gangwon', '강원', 37.8228, 128.1555],
  ['Cheongju', '청주', 36.6424, 127.4890], ['Chungju', '충주', 36.9910, 127.9259], ['Chungbuk', '충북', 36.6357, 127.4917],
  ['Cheonan', '천안', 36.8151, 127.1139], ['Asan', '아산', 36.7898, 127.0018], ['Chungnam', '충남', 36.5184, 126.8000],
  ['Jeonju', '전주', 35.8242, 127.1480], ['Gunsan', '군산', 35.9676, 126.7369], ['Iksan', '익산', 35.9483, 126.9577],
  ['Jeonbuk', '전북', 35.7175, 127.1530], ['Mokpo', '목포', 34.8118, 126.3922], ['Yeosu', '여수', 34.7604, 127.6622],
  ['Suncheon', '순천', 34.9506, 127.4872], ['Jeonnam', '전남', 34.8679, 126.9910], ['Pohang', '포항', 36.0190, 129.3435],
  ['Gumi', '구미', 36.1195, 128.3446], ['Gyeongju', '경주', 35.8562, 129.2247], ['Andong', '안동', 36.5684, 128.7294],
  ['Gyeongbuk', '경북', 36.4919, 128.8889], ['Changwon', '창원', 35.2279, 128.6811], ['Gimhae', '김해', 35.2285, 128.8894],
  ['Jinju', '진주', 35.1800, 128.1076], ['Yangsan', '양산', 35.3350, 129.0372], ['Geoje', '거제', 34.8806, 128.6211],
  ['Gyeongnam', '경남', 35.4606, 128.2132], ['Jeju', '제주', 33.4996, 126.5312], ['Seogwipo', '서귀포', 33.2541, 126.5601],
].map(([en, ko, lat, lon]) => ({ en: en.toLowerCase(), ko, lat, lon }));

const normPlace = (s) => String(s || '').toLowerCase()
  .replace(/(special|metropolitan|autonomous)?\s*(self-governing)?\s*(city|province)/g, '')
  .replace(/[-\s]*(si|gu|gun|do)\b/g, '').replace(/(특별시|광역시|특별자치시|특별자치도|시|구|군|도)$/g, '').trim();

function coordsFor(...names) {
  for (const raw of names) {
    const n = normPlace(raw);
    if (!n) continue;
    const hit = PLACES.find((p) => n === p.en || n === p.ko || n.startsWith(p.en) || n.includes(p.ko));
    if (hit) return { coord: [hit.lat, hit.lon], town: raw };
  }
  return null;
}
const KOREA_CENTRE = [36.35, 127.85];
=======
// The dashboard's own overview call gives district/city, not lat/lon, so sites are pinned
// by city here rather than individually. Coordinates for Quezon City, Pasig and Makati are
// copied from lib/monitor/mock.js (already used elsewhere in this app); Cainta is a
// town-centre approximation and hasn't been checked against the dashboard's own map.
const CITY_COORDS = {
  'Quezon City': [14.6760, 121.0437],
  'Pasig': [14.5764, 121.0851],
  'Makati': [14.5547, 121.0244],
  'Cainta': [14.5787, 121.1223],
};
>>>>>>> 80e301041922043c733ee859525a80c8d7d6caaf

// Two reads, matching what the dashboard's own big screen does:
//   statistics        -> loaded once by the dashboard: site ranking, 24 h chart, 7-day before/after, regions
//   statisticsUpdate  -> polled by the dashboard: totals, today's figures, equipment count, power by type
let baseCache = { at: 0, data: null }, updCache = { at: 0, data: null };

async function buildBase() {
  const s = await dashboard.call('/api/iotphp/bigScreenAgent/statistics', {});
  const rank = s.projectRank || [];
  const areas = rank.map((r) => ({ area: `${r.district}, ${r.city}`, savedKwh: r2(Number(r.powerSave) || 0), projects: r.projectCount || 0 }));
  const projects = rank.map((r, i) => {
<<<<<<< HEAD
    // The dashboard may put a province in `city` and the real town in `district` (or the other way
    // round), so try the district first, then the city.
    const found = coordsFor(r.district, r.city, r.provice);
    const coord = found ? found.coord : null, town = found ? found.town : (r.district || r.city);
    if (!coord) console.warn(`[monitor] no map coordinates for city="${r.city}" district="${r.district}"; add it to PLACES in lib/monitor/live.js`);
=======
    // The dashboard sometimes puts the province in `city` (e.g. 'Lalawigan ng Rizal') and the
    // real town in `district` (e.g. 'Cainta'), so try the city first, then the district.
    let coord = CITY_COORDS[r.city] || null, town = r.city;
    if (!coord && CITY_COORDS[r.district]) { coord = CITY_COORDS[r.district]; town = r.district; }
    if (!coord) console.warn(`[monitor] no map coordinates for city="${r.city}" district="${r.district}"; add it to CITY_COORDS`);
>>>>>>> 80e301041922043c733ee859525a80c8d7d6caaf
    return {
      id: `district-${r.districtId ?? i}`,
      name: `${r.district}${r.projectCount > 1 ? ` (${r.projectCount} sites)` : ''}`,
      city: town, area: r.provice || r.city, region: r.provice || '',
<<<<<<< HEAD
      lat: coord ? coord[0] : KOREA_CENTRE[0], lon: coord ? coord[1] : KOREA_CENTRE[1],
=======
      lat: coord ? coord[0] : 12.8797, lon: coord ? coord[1] : 121.7740,
>>>>>>> 80e301041922043c733ee859525a80c8d7d6caaf
      savedKwh: r2(Number(r.powerSave) || 0), todaySavedKwh: 0,
    };
  });
  const now = Date.now();
  const hourly = (s.latest24?.powerList || []).map((h, i, arr) =>
    ({ t: now - (arr.length - 1 - i) * 3600e3, hour: h.hour, kwh: Number(h.powerUsed) || 0 }));
  const prePost = (s.weekPowerSave || []).map((r) => ({
<<<<<<< HEAD
    t: new Date(r.record_date + `T00:00:00${TZ_SUFFIX}`).getTime(),
=======
    t: new Date(r.record_date + 'T00:00:00+08:00').getTime(),
>>>>>>> 80e301041922043c733ee859525a80c8d7d6caaf
    before: Number(r.beforePower) || 0, after: Number(r.afterPower) || 0,
  }));
  return {
    areas, projects, hourly, prePost,
    regions: (s.getProvinceProject || []).map((r) => ({ name: r.provinceName, count: r.projectCount })),
    maxHourly: Number(s.latest24?.maxUsed) || 0,
    projectCount: s.projectStatus?.totalProject || rank.reduce((n, r) => n + (r.projectCount || 0), 0),
    rankSaved: r2(rank.reduce((n, r) => n + (Number(r.powerSave) || 0), 0)),
  };
}

async function buildOverview() {
  if (!baseCache.data || Date.now() - baseCache.at > 10e3) baseCache = { at: Date.now(), data: await buildBase() };
  if (!updCache.data || Date.now() - updCache.at > 1.5e3) {
    try { updCache = { at: Date.now(), data: await dashboard.call('/api/iotphp/bigScreenAgent/statisticsUpdate', {}) }; }
    catch (e) { if (!updCache.data) throw e; /* keep showing the last good reading */ }
  }
  const b = baseCache.data, u = updCache.data || {};
  const tot = u.totalPowerStatistics || {}, td = u.todaySaveStatistics || {}, dv = u.deviceStatistics || {}, c = u.powerSaveRation || {};
  const saved = Number(tot.totalPowerSave) || b.rankSaved;
  const lamp = Number(c.lamp) || 0, ac = Number(c.airCondition) || 0, other = Number(c.others) || 0;
  const used = lamp + ac + other;
  return {
    generatedAt: Date.now(),
    totals: {
      savedKwh: r2(saved),
      // saved / (saved + used); the dashboard's own totalSaveRatio only carries whole percents
      savingRate: used + saved > 0 ? r2(saved / (saved + used) * 100) : r2((Number(tot.totalSaveRatio) || 0) * 100),
      todaySavedKwh: r2(Number(td.powerSave) || 0),
      todaySavingRate: r2((Number(td.powerSaveRatio) || 0) * 100),
      co2Kg: r2(Number(tot.totalCarbonSaveKg ?? tot.totalCarbonSave) || saved * CO2_KG_PER_KWH),
      todayCo2Kg: r2(Number(td.carbonSave) || 0),
      projects: b.projectCount,
      meters: Number(dv.installedDevices) || 0,
      equipments: Number(dv.installedDevices) || 0,
    },
    projects: b.projects, areas: b.areas, hourly: b.hourly, prePost: b.prePost, regions: b.regions, maxHourly: b.maxHourly,
    categories: { lighting: r2(lamp), ac: r2(ac), other: r2(other) }, // power used after improvement, by type
  };
}

module.exports = {
  async listProjects() {
    const rows = await projects();
    // The dashboard identifies a site by its familyId; that is what every later call needs.
    return rows
      .filter((p) => p.family_id)
      .map((p) => ({ id: String(p.family_id), name: p.name, location: p.district || "" }));
  },

  async listMeters(pid) {
    const meters = await fetchMeters(pid);
    return meters.map((m) => ({
      id: String(m.accessoryId),
      name: m.name,
      type: m.category === 2 ? 'Lighting' : 'Other', // category codes beyond 2 (lighting) aren't confirmed yet
      online: m.on,
    }));
  },

  async readNow(pid, at = Date.now()) {
    const meters = await cachedMeters(pid);
    const out = [];
    for (const m of meters) {
      if (!m.on) {
        out.push({ meterId: String(m.accessoryId), on: false, kw: 0, volts: 0, ts: at });
        continue;
      }
      // getMeterInfo returns three power-shaped fields — `power`, `powerReal`, and the
      // measured `voltage`/`electricCurrent`. On Marco Polo's online meter, voltage (237V) x
      // current (2.078A) = ~492W, but powerReal reported 719W — real power cannot exceed
      // volts x amps, so powerReal (and by extension `power`) is reporting something other
      // than a live reading, most likely a rated/reference figure. voltage x current is the
      // only field pair here that's a direct instrument reading rather than a computed or
      // labelled one, so that's what's used for the live kW. It may still look flat between
      // polls if the meter itself only reports every few minutes — that would be a hardware
      // reporting-interval fact, not a bug here.
      const info = await dashboard.call('/api/iotphp/agent/getMeterInfo', { accessoryId: m.accessoryId });
      const volts = Number(info.voltage) || 0;
      const amps = Number(info.electricCurrent) || 0;
      out.push({
        meterId: String(m.accessoryId),
        on: meterIsOn(info),
        kw: r2((volts * amps) / 1000),
        volts,
        ts: at,
      });
    }
    return out;
  },

  async history(pid, range) {
    if (range === "day") {
      // The site's own statistics call carries its last 24 hours, one reading per hour (latest24.powerList).
<<<<<<< HEAD
      const d = localNow();
=======
      const d = new Date(Date.now() + 8 * 3600e3);
>>>>>>> 80e301041922043c733ee859525a80c8d7d6caaf
      const m = await dashboard.getMonthStats(pid, `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`);
      const list = m.raw.latest24?.powerList || [];
      const now = Date.now();
      return list.map((h, i) => ({ t: now - (list.length - 1 - i) * 3600e3, kwh: r2(Number(h.powerUsed) || 0) }));
    }
    const days = range === "week" ? 7 : 30;
<<<<<<< HEAD
    const start = localDate(-(days - 1));
    const end = localDate(0);
    const stats = await dashboard.getRangeStats(pid, start, end);
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = localDate(-i);
      out.push({ t: new Date(date + `T12:00:00${TZ_SUFFIX}`).getTime(), kwh: r2(stats.dailyKwh[date] || 0) });
=======
    const start = manilaDate(-(days - 1));
    const end = manilaDate(0);
    const stats = await dashboard.getRangeStats(pid, start, end);
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = manilaDate(-i);
      out.push({ t: new Date(date + "T12:00:00+08:00").getTime(), kwh: r2(stats.dailyKwh[date] || 0) });
>>>>>>> 80e301041922043c733ee859525a80c8d7d6caaf
    }
    return out;
  },

  // Everything the dashboard's own site screen shows, in one object. Sources: statisticsBigScreen (month stats),
  // getMeterList (fixtures, before/after) and getMeterInfo (live meter values). Field meanings were matched
  // against the dashboard screenshots; the ones marked "assumed" have not been confirmed against a live reading.
  async details(pid) {
    const projectId = await projectIdFor(pid);
<<<<<<< HEAD
    const d = localNow();
=======
    const d = new Date(Date.now() + 8 * 3600e3);
>>>>>>> 80e301041922043c733ee859525a80c8d7d6caaf
    const [m, list] = await Promise.all([
      dashboard.getMonthStats(pid, `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`),
      dashboard.call('/api/iotphp/agent/getMeterList', { projectId }),
    ]);
    const s = m.raw, c = s.contrastInfo || {}, t = s.totalData || {};
    const first = (list.lists || [])[0];
    let info = null;
    if (first) { try { info = await dashboard.call('/api/iotphp/agent/getMeterInfo', { accessoryId: first.accessoryId }); } catch (e) { /* meter figures stay empty */ } }
    const n = (v) => Number(v) || 0;
    const vs = (a, b) => (n(b) > 0 ? r2((n(a) - n(b)) / n(b) * 100) : null);
    return {
      today: {
        usedKwh: r2(n(c.todayUsePower)), usedVs: vs(c.todayUsePower, c.yesterdayUsePower),
        traffic: n(c.todayThroughput), trafficVs: vs(c.todayThroughput, c.yesterdayThroughput),
        parked: n(c.todayCar), parkedVs: vs(c.todayCar, c.yesterdayCar),
        savedKwh: r2(n(c.todaySavePower)), savedVs: vs(c.todaySavePower, c.yesterdaySavePower),
      },
      trafficHourly: (s.throughputInfoHour || []).map((h) => ({ hour: h.key, value: n(h.value) })),
      powerShare: (s.usePowerRatio || []).map((r) => ({ month: r.month, lamp: n(r.lampPower), ac: n(r.airConditionPower), other: n(r.otherPower) })),
      cumulative: {
        saveRate: r2(n(t.powerSaveRatio) * 100), usedRatio: r2(n(t.powerUsedRatio) * 100),
        savedKwh: r2(n(t.powerSave)), usedKwh: r2(n(t.powerUsed)), otherKwh: r2(n(t.powerOther)),
        durationDays: r2(n(t.powerLong) / 24), // assumed: powerLong is hours of saving
        billSavings: r2(n(t.totalSaveFee)), carbonKg: r2(n(t.powerCarbon)), trees: n(t.trees),
      },
      now: { lightingPct: r2(n(s.currentPowerRatio) * 100), traffic: n(s.currentThroughput), parkingPct: s.currentParkingRatio == null ? null : r2(n(s.currentParkingRatio) * 100) }, // lighting/parking ratio assumed to be a fraction
      month: {
        saveRate: n(s.powerSaveRatio), usedRatio: n(s.powerActualRatio), usedKwh: r2(n(s.powerActual)), savedKwh: r2(n(s.powerSave)),
        lampKwh: r2(n(s.lamp)), lampPct: n(s.lampRatio), acKwh: r2(n(s.airCondition)), acPct: n(s.airConditionRatio), otherKwh: r2(n(s.others)), otherPct: n(s.othersRation),
        carbonKg: r2(n(s.saveCarbon) / 1000), costSaved: r2(n(s.saveFee)), tariff: n(s.fee),
        usageKwh: r2(n(s.currentMonthPower)), usageVsLast: vs(s.currentMonthPower, s.lastMonthPower),
      },
      daily: {
        power: (s.powerDetail || []).map((r) => ({ day: r.key, used: n(r.value), saved: n(r.powerSave) })),
        traffic: (s.throughputInfo || []).map((r) => ({ day: r.key, value: n(r.value) })),
      },
      fixtures: n(list.lampCount), beforeKwh: r2(n(s.beforeSave)), afterKwh: r2(n(s.afterSave)),
      meter: {
        count: n(list.meterCount), online: info ? Number(info.isOnline) === 1 : (first ? Number(first.isOnline) === 1 : null),
        watts: info ? n(info.power) : null, volts: info ? n(info.voltage) : null, amps: info ? n(info.electricCurrent) : null,
        totalReadingKwh: info ? r2(n(info.forwardEnergyTotal) / 100) : null, // assumed: stored in units of 0.01 kWh
      },
    };
  },

  async overview() { return buildOverview(); },
};