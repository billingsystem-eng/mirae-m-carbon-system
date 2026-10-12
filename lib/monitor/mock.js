'use strict';
/*
  Mock provider: believable building load profiles, no hardware needed.

  Provider interface (server.js only ever calls these):
    listProjects()                  -> [{ id, name, location }]
    listMeters(projectId)           -> [{ id, name, type, online }]
    readNow(projectId)              -> [{ meterId, kw, volts, on, ts }]      (live snapshot)
    history(projectId, range)       -> [{ t, kwh }]   range: 'day' | 'week' | 'month'
    overview()                      -> the national summary shown on the map page (shape below)
    recent(projectId, n, stepMs)    -> [{ t, total }]  (optional, pre-fills the live chart)

  Savings model used here: each project has a savings rate r after its improvement work.
  What the site actually uses is "after"; what it would have used is "before" = after / (1 - r),
  so energy saved = before - after.
*/

const CO2_KG_PER_KWH = Number(process.env.CO2_KG_PER_KWH) || 0.785; // grid emission factor

const smooth = (x, a, b) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// Hour-of-day load shapes (0..1) and how much each drops or rises on weekends
const SHAPES = {
  flat:      { f: () => 1, weekend: 1 },
  office:    { f: (h) => 0.25 + 0.75 * smooth(h, 6.5, 9) * (1 - smooth(h, 17, 20)), weekend: 0.55 },
  lights:    { f: (h) => 0.15 + 0.85 * smooth(h, 6, 8) * (1 - smooth(h, 18, 21)), weekend: 0.7 },
  night:     { f: (h) => Math.max(1 - smooth(h, 5, 6), smooth(h, 17.5, 18.5)), weekend: 1 },
  retail:    { f: (h) => 0.2 + 0.8 * smooth(h, 9, 11) * (1 - smooth(h, 21, 22.5)), weekend: 1.15 },
  warehouse: { f: (h) => 0.3 + 0.7 * smooth(h, 5.5, 7) * (1 - smooth(h, 15, 17)), weekend: 0.5 },
};

// Meter sets for the generated sites: [name, type, base kW, shape]
const KINDS = {
  office: [
    ['Chillers', 'Air conditioning', 46, 'office'], ['Lighting', 'Lighting', 14, 'lights'],
    ['Elevators', 'Motors', 9, 'office'], ['Server room', 'IT', 7, 'flat'], ['Plug loads', 'Sockets', 18, 'office'],
  ],
  mall: [
    ['Central cooling', 'Air conditioning', 120, 'retail'], ['Tenant lighting', 'Lighting', 55, 'retail'],
    ['Escalators', 'Motors', 22, 'retail'], ['Food court', 'Kitchen', 38, 'retail'],
  ],
  warehouse: [
    ['Cold storage', 'Refrigeration', 64, 'flat'], ['Loading bay', 'Motors', 26, 'warehouse'],
    ['High-bay lighting', 'Lighting', 19, 'warehouse'], ['Charging area', 'EV and forklifts', 15, 'warehouse'],
  ],
  school: [
    ['Classroom cooling', 'Air conditioning', 30, 'office'], ['Lighting', 'Lighting', 11, 'lights'],
    ['Labs', 'Equipment', 8, 'office'], ['Canteen', 'Kitchen', 6, 'retail'],
  ],
  hospital: [
    ['Central cooling', 'Air conditioning', 70, 'flat'], ['Lighting', 'Lighting', 24, 'flat'],
    ['Imaging and labs', 'Equipment', 20, 'flat'], ['Elevators', 'Motors', 9, 'office'],
  ],
};
const generate = (id, kind, scale) =>
  KINDS[kind].map(([name, type, base, shape], i) => ({ id: `${id}-${i + 1}`, name, type, base: +(base * scale).toFixed(1), shape }));

// lat/lon place each site on the map; rate = savings rate after improvement; since = days since go-live
const PROJECTS = [
  { id: 'p1', name: 'Central Office', city: 'Manila', area: 'Metro Manila', region: 'NCR', lat: 14.5995, lon: 120.9842, rate: 0.70, since: 240, meters: [
    { id: 'm11', name: 'Chillers', type: 'Air conditioning', base: 46, shape: 'office' },
    { id: 'm12', name: 'Lighting, floors 1 to 6', type: 'Lighting', base: 14, shape: 'lights' },
    { id: 'm13', name: 'Elevators', type: 'Motors', base: 9, shape: 'office' },
    { id: 'm14', name: 'Server room', type: 'IT', base: 7, shape: 'flat' },
    { id: 'm15', name: 'Plug loads', type: 'Sockets', base: 18, shape: 'office' },
    { id: 'm16', name: 'Parking lights', type: 'Lighting', base: 3, shape: 'night', offline: true },
  ] },
  { id: 'p2', name: 'Riverside Mall', city: 'Cebu City', area: 'Cebu', region: 'Region VII', lat: 10.3157, lon: 123.8854, rate: 0.64, since: 170, meters: [
    { id: 'm21', name: 'Central cooling', type: 'Air conditioning', base: 120, shape: 'retail' },
    { id: 'm22', name: 'Tenant lighting', type: 'Lighting', base: 55, shape: 'retail' },
    { id: 'm23', name: 'Escalators', type: 'Motors', base: 22, shape: 'retail' },
    { id: 'm24', name: 'Food court', type: 'Kitchen', base: 38, shape: 'retail' },
    { id: 'm25', name: 'Signage', type: 'Lighting', base: 9, shape: 'night' },
  ] },
  { id: 'p3', name: 'North Warehouse', city: 'Dasmarinas', area: 'Cavite', region: 'Region IV-A', lat: 14.3294, lon: 120.9367, rate: 0.60, since: 130, meters: [
    { id: 'm31', name: 'Cold storage', type: 'Refrigeration', base: 64, shape: 'flat' },
    { id: 'm32', name: 'Loading bay', type: 'Motors', base: 26, shape: 'warehouse' },
    { id: 'm33', name: 'High-bay lighting', type: 'Lighting', base: 19, shape: 'warehouse' },
    { id: 'm34', name: 'Charging area', type: 'EV and forklifts', base: 15, shape: 'warehouse' },
  ] },
  { id: 'p4', name: 'City Hall Annex', city: 'Quezon City', area: 'Metro Manila', region: 'NCR', lat: 14.6760, lon: 121.0437, rate: 0.72, since: 210, meters: generate('p4', 'office', 0.9) },
  { id: 'p5', name: 'Pasig Business Tower', city: 'Pasig', area: 'Metro Manila', region: 'NCR', lat: 14.5764, lon: 121.0851, rate: 0.68, since: 150, meters: generate('p5', 'office', 1.4) },
  { id: 'p6', name: 'Makati Corporate Center', city: 'Makati', area: 'Metro Manila', region: 'NCR', lat: 14.5547, lon: 121.0244, rate: 0.75, since: 120, meters: generate('p6', 'office', 1.2) },
  { id: 'p7', name: 'Davao Logistics Hub', city: 'Davao City', area: 'Davao', region: 'Region XI', lat: 7.1907, lon: 125.4553, rate: 0.62, since: 180, meters: generate('p7', 'warehouse', 1.3) },
  { id: 'p8', name: 'Baguio Campus', city: 'Baguio', area: 'Benguet', region: 'CAR', lat: 16.4023, lon: 120.5960, rate: 0.70, since: 140, meters: generate('p8', 'school', 1.0) },
  { id: 'p9', name: 'Iloilo Retail Center', city: 'Iloilo City', area: 'Iloilo', region: 'Region VI', lat: 10.7202, lon: 122.5621, rate: 0.66, since: 90, meters: generate('p9', 'mall', 0.6) },
  { id: 'p10', name: 'Calamba Medical Center', city: 'Calamba', area: 'Laguna', region: 'Region IV-A', lat: 14.2117, lon: 121.1653, rate: 0.58, since: 200, meters: generate('p10', 'hospital', 1.0) },
];

function hash(s) {
  let h = 2166136261;
  for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rnd(seed) {
  let x = (seed >>> 0) || 1;
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;  x >>>= 0;
  return x / 4294967296;
}

// Smooth-ish deterministic load: same timestamp always gives the same kW
function kwAt(m, ts) {
  if (m.offline) return 0;
  const d = new Date(ts);
  const h = d.getHours() + d.getMinutes() / 60;
  const shape = SHAPES[m.shape];
  const weekend = d.getDay() === 0 || d.getDay() === 6 ? shape.weekend : 1;
  const dayVar = 0.9 + 0.2 * rnd(hash(m.id + 'd') + Math.floor(ts / 86400e3));
  const noise = 0.94 + 0.12 * rnd(hash(m.id) + Math.floor(ts / 900e3));
  return m.base * shape.f(h) * weekend * dayVar * noise;
}

const project = (id) => {
  const p = PROJECTS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown project ${id}`);
  return p;
};

const categoryOf = (m) => (m.type === 'Lighting' ? 'lighting' : m.type === 'Air conditioning' ? 'ac' : 'other');

// Integrate kW into kWh between two timestamps in 15-minute steps, split by meter category
function energyCat(p, from, to) {
  const STEP = 900e3;
  const out = { lighting: 0, ac: 0, other: 0 };
  for (let t = from; t < to; t += STEP) {
    const dt = Math.min(STEP, to - t) / 3600e3;
    for (const m of p.meters) out[categoryOf(m)] += kwAt(m, t) * dt;
  }
  return out;
}
const sumCat = (c) => c.lighting + c.ac + c.other;
const energy = (p, from, to) => sumCat(energyCat(p, from, to));

const startOfDay = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
const r2 = (n) => Number(n.toFixed(2));

// Finished days never change, so remember them
const dayMemo = new Map();
function fullDay(p, dayStart) {
  const key = `${p.id}:${dayStart}`;
  if (!dayMemo.has(key)) dayMemo.set(key, energyCat(p, dayStart, dayStart + 86400e3));
  return dayMemo.get(key);
}
// Energy per category for one calendar day (today is partial)
function dayEnergy(p, dayStart, now) {
  return dayStart >= startOfDay(now) ? energyCat(p, dayStart, now) : fullDay(p, dayStart);
}
const before = (p, kwh) => kwh / (1 - p.rate);

let overviewCache = { at: 0, data: null };

function buildOverview() {
  const now = Date.now();
  const today = startOfDay(now);
  const add = (a, b, k = 1) => ({ lighting: a.lighting + k * b.lighting, ac: a.ac + k * b.ac, other: a.other + k * b.other });

  let savedAll = 0, beforeAll = 0, savedToday = 0, beforeToday = 0;
  const cats = { lighting: 0, ac: 0, other: 0 };
  const projects = [];
  const prePost = Array.from({ length: 7 }, (_, i) => ({ t: today - (6 - i) * 86400e3, before: 0, after: 0 }));

  for (const p of PROJECTS) {
    let pSaved = 0;
    for (let d = today - p.since * 86400e3; d <= today; d += 86400e3) {
      const day = dayEnergy(p, startOfDay(d + 12 * 3600e3), now);
      const after = sumCat(day);
      const bef = before(p, after);
      beforeAll += bef; pSaved += bef - after; savedAll += bef - after;
      // category savings scale the same way as the site total
      const scale = p.rate / (1 - p.rate);
      Object.assign(cats, add(cats, day, scale));
      if (d === today) { savedToday += bef - after; beforeToday += bef; }
    }
    prePost.forEach((row) => {
      const after = sumCat(dayEnergy(p, row.t, now));
      row.after += after; row.before += before(p, after);
    });
    const todaySaved = (() => { const a = sumCat(dayEnergy(p, today, now)); return before(p, a) - a; })();
    projects.push({
      id: p.id, name: p.name, city: p.city, area: p.area, region: p.region, lat: p.lat, lon: p.lon,
      meters: p.meters.length, savedKwh: r2(pSaved), todaySavedKwh: r2(todaySaved),
    });
  }

  // Savings grouped by area, like the "project distribution" table
  const byArea = new Map();
  for (const pr of projects) {
    const a = byArea.get(pr.area) || { area: pr.area, savedKwh: 0, projects: 0 };
    a.savedKwh += pr.savedKwh; a.projects += 1;
    byArea.set(pr.area, a);
  }
  const areas = [...byArea.values()].map((a) => ({ ...a, savedKwh: r2(a.savedKwh) })).sort((a, b) => b.savedKwh - a.savedKwh);

  // Last 24 hours of actual consumption across all sites, hour by hour
  const hourStart = Math.floor(now / 3600e3) * 3600e3;
  const hourly = [];
  for (let i = 23; i >= 0; i--) {
    const t = hourStart - i * 3600e3;
    hourly.push({ t, kwh: r2(PROJECTS.reduce((s, p) => s + energy(p, t, Math.min(t + 3600e3, now)), 0)) });
  }

  return {
    generatedAt: now,
    totals: {
      savedKwh: r2(savedAll), savingRate: r2(savedAll / beforeAll * 100),
      todaySavedKwh: r2(savedToday), todaySavingRate: r2(savedToday / beforeToday * 100),
      co2Kg: r2(savedAll * CO2_KG_PER_KWH), todayCo2Kg: r2(savedToday * CO2_KG_PER_KWH),
      projects: PROJECTS.length, meters: PROJECTS.reduce((s, p) => s + p.meters.length, 0),
    },
    projects,
    areas,
    hourly,
    prePost: prePost.map((r) => ({ t: r.t, before: r2(r.before), after: r2(r.after) })),
    categories: { lighting: r2(cats.lighting), ac: r2(cats.ac), other: r2(cats.other) },
  };
}

module.exports = {
  async listProjects() {
    return PROJECTS.map(({ id, name, city }) => ({ id, name, location: city }));
  },

  async listMeters(pid) {
    return project(pid).meters.map((m) => ({ id: m.id, name: m.name, type: m.type, online: !m.offline }));
  },

  async readNow(pid, at = Date.now()) {
    return project(pid).meters.map((m) => {
      const on = !m.offline;
      return {
        meterId: m.id,
        on,
        kw: on ? r2(kwAt(m, at) * (1 + (Math.random() - 0.5) * 0.05)) : 0,
        volts: on ? r2(229 + Math.random() * 3) : 0,
        ts: at,
      };
    });
  },

  async recent(pid, n, stepMs) {
    const p = project(pid);
    const now = Date.now();
    const out = [];
    for (let i = n; i >= 1; i--) {
      const t = now - i * stepMs;
      const total = p.meters.reduce((s, m) => s + kwAt(m, t) * (1 + (Math.random() - 0.5) * 0.05), 0);
      out.push({ t, total: r2(total) });
    }
    return out;
  },

  async history(pid, range) {
    const p = project(pid);
    const now = Date.now();
    const midnight = startOfDay(now);
    const out = [];
    if (range === 'day') {
      for (let t = midnight; t < now; t += 3600e3) out.push({ t, kwh: r2(energy(p, t, Math.min(t + 3600e3, now))) });
    } else {
      const days = range === 'week' ? 7 : 30;
      for (let i = days - 1; i >= 0; i--) {
        const t = startOfDay(midnight - i * 86400e3 + 12 * 3600e3);
        out.push({ t, kwh: r2(energy(p, t, Math.min(t + 86400e3, now))) });
      }
    }
    return out;
  },

  async overview() {
    if (!overviewCache.data || Date.now() - overviewCache.at > 20e3) {
      overviewCache = { at: Date.now(), data: buildOverview() };
    }
    return overviewCache.data;
  },
};
