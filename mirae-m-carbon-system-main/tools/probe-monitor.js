'use strict';
/*
  Captures raw responses from the M-Carbon Dashboard so lib/monitor/live.js can be finished
  against real data instead of guesses.

  Run from the project root (needs MCARBON_BASE_URL, MCARBON_PHONE, MCARBON_PASSWORD in .env):

    node tools/probe-monitor.js
        Writes probe-output/*.json: the full overview call, the project list, and for one site
        the monthly statistics plus the three meter calls.

    node tools/probe-monitor.js --family <familyId>
        Same, for a specific site instead of the first one found.

    node tools/probe-monitor.js /api/iotphp/agent/getMeterList '{"familyId":"123"}'
        Calls one endpoint with the body you give it and prints the raw response. Copy the exact
        path and body from the browser's Network tab.

  probe-output/ holds real site names and readings. It is git-ignored; send the files to whoever
  is helping you map them, but do not commit them.
*/
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const dashboard = require('../lib/dashboard');

const OUT = path.join(__dirname, '..', 'probe-output');

function save(name, data) {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, name + '.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  console.log('  wrote', path.relative(process.cwd(), file));
}

// A failed call is still useful to see: the error text says what the server did not like.
async function attempt(label, fn) {
  console.log(`- ${label}`);
  try { return await fn(); } catch (e) { console.log('  failed:', e.message); return { error: e.message }; }
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] && args[0].startsWith('/')) {
    const body = args[1] ? JSON.parse(args[1]) : {};
    const data = await dashboard.call(args[0], body);
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const famIdx = args.indexOf('--family');
  let familyId = famIdx >= 0 ? args[famIdx + 1] : null;

  console.log('Logging in as', process.env.MCARBON_PHONE);
  await dashboard.login();

  save('statistics', await attempt('overview: /api/iotphp/bigScreenAgent/statistics',
    () => dashboard.call('/api/iotphp/bigScreenAgent/statistics', {})));

  const projects = await attempt('project list (province > city > district > project)', () => dashboard.listProjects());
  save('projects', projects);
  if (!familyId && Array.isArray(projects) && projects.length) familyId = String(projects[0].family_id);
  if (!familyId) { console.log('No site to probe. Pass --family <id>.'); return; }
  console.log('Probing site', familyId);

  const now = new Date(Date.now() + 8 * 3600e3);
  const month = `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}`;
  save('month-stats', await attempt(`monthly statistics for ${month}`, () => dashboard.call(
    '/api/iotphp/conservation/statisticsBigScreen', { familyId, type: 2, date: month })));

  // The meter calls did not accept { familyId } alone, so try the other ids the project list gives us.
  // Every attempt and its outcome is written down, so a wrong guess still teaches us the right body.
  const site = Array.isArray(projects) ? projects.find((p) => String(p.family_id) === familyId) : null;
  const projectId = site ? site.project_id : undefined;
  const tryBodies = async (name, bodies) => {
    const attempts = [];
    let found = null;
    for (const body of bodies) {
      const r = await attempt(`/api/iotphp/agent/${name} ${JSON.stringify(body)}`, () => dashboard.call(`/api/iotphp/agent/${name}`, body));
      attempts.push({ body, ok: !(r && r.error && Object.keys(r).length === 1), result: r });
      if (!(r && r.error && Object.keys(r).length === 1) && !found) found = { body, data: r };
    }
    save(name, { attempts });
    return found;
  };

  const listFound = await tryBodies('getMeterList', [
    { projectId }, { projectId: String(projectId) }, { familyId, projectId }, { id: projectId }, { familyId },
  ]);

  // Take the first meter from whatever list came back and try its id fields against getMeterInfo.
  const firstList = (d) => (Array.isArray(d) ? d : d && typeof d === 'object' ? Object.values(d).find(Array.isArray) : null);
  const meters = listFound && firstList(listFound.data);
  const meter = meters && meters[0];
  const infoBodies = [];
  if (meter && typeof meter === 'object') {
    for (const [k, v] of Object.entries(meter)) {
      if (v !== null && typeof v !== 'object' && /id|no|code|sn/i.test(k)) {
        infoBodies.push({ [k]: v }, { meterId: v }, { projectId, meterId: v });
      }
    }
  }
  await tryBodies('getMeterInfo', infoBodies.length ? infoBodies.slice(0, 8) : [{ projectId }, { familyId }]);

  await tryBodies('getBreakerPowerUsed', [
    { familyId }, { projectId }, { projectId, familyId },
  ]);
  console.log('\nDone. Send the files in probe-output/ back so the missing calls can be mapped.');
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });