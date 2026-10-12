const express = require('express');

const router = express.Router();

// Proxies the public PSGC (Philippine Standard Geographic Code) API — the
// official PSA classification of regions, provinces, cities/municipalities
// and barangays — so the billing address form can offer real dropdowns
// instead of free text. We proxy server-side rather than calling it from
// the browser directly to avoid CORS issues and so results can be cached
// for a while (this reference data essentially never changes day to day).
const BASE = 'https://psgc.gitlab.io/api';

const cache = new Map(); // path -> { at, data }
const TTL_MS = 24 * 60 * 60 * 1000; // 24h — this is reference data, not live data

async function fetchCached(path) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`PSGC API returned ${res.status} for ${path}`);
  // The PSGC API serves JSON with a text/html content-type header, so we
  // parse the body ourselves rather than trusting res.json()'s content-type check.
  const text = await res.text();
  const data = JSON.parse(text);
  cache.set(path, { at: Date.now(), data });
  return data;
}

router.get('/regions', async (req, res) => {
  try {
    const data = await fetchCached('/regions/');
    res.json(data.map((r) => ({ code: r.code, name: r.name })));
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'Could not reach the PSGC address service: ' + e.message });
  }
});

router.get('/regions/:code/cities-municipalities', async (req, res) => {
  try {
    const data = await fetchCached(`/regions/${encodeURIComponent(req.params.code)}/cities-municipalities/`);
    res.json(
      data
        .map((c) => ({ code: c.code, name: c.name, type: c.isCapital ? 'capital' : undefined }))
        .sort((a, b) => a.name.localeCompare(b.name))
    );
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'Could not reach the PSGC address service: ' + e.message });
  }
});

router.get('/cities-municipalities/:code/barangays', async (req, res) => {
  try {
    const data = await fetchCached(`/cities-municipalities/${encodeURIComponent(req.params.code)}/barangays/`);
    res.json(data.map((b) => ({ code: b.code, name: b.name })).sort((a, b) => a.name.localeCompare(b.name)));
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'Could not reach the PSGC address service: ' + e.message });
  }
});

module.exports = router;
