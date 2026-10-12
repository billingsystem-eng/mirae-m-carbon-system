// Quick standalone check — run this from your project root with:
//   node debug-dashboard.js
// It prints exactly what each step of the dashboard walk returns, so we can
// see whether the problem is login, or the province/city/district calls.

require('dotenv').config();
const dashboard = require('./lib/dashboard');

(async () => {
  try {
    console.log('--- Logging in with:', process.env.MCARBON_PHONE, '---');
    const token = await dashboard.login();
    console.log('Login OK. Token starts with:', token.slice(0, 20) + '...');

    console.log('\n--- Walking province -> city -> district -> project ---');
    const projects = await dashboard.listProjects();
    console.log(`Found ${projects.length} project(s):`);
    console.log(JSON.stringify(projects, null, 2));
  } catch (e) {
    console.error('FAILED:', e.message);
  }
})();
