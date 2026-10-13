# Live monitor (Wattwise inside the billing system)

New page: **Live monitor** in the left menu (`/monitor.html`). It is your Wattwise dashboard
(map, savings, per-site meters and live load) running behind the billing login.

## What changed

| File | Change |
|---|---|
| `public/monitor.html` | New. The Wattwise page with its CSS scoped under `.ww`, so the billing pages look the same as before |
| `public/js/ph-map.js` | New. The same map file Wattwise uses |
| `public/js/app.js` | One line: "Live monitor" added to `NAV` |
| `routes/monitor.js` | New. Wattwise's REST calls and live stream, mounted at `/api/monitor` |
| `lib/monitor/mock.js` | New. Wattwise's sample data, unchanged |
| `lib/monitor/live.js` | New. Reads the M-Carbon Dashboard (partly mapped, see below) |
| `lib/dashboard.js` | One line: it now also exports `call` |
| `server.js` | Two lines: require and mount `routes/monitor.js` |
| `tools/probe-monitor.js` | New. Captures raw M-Carbon responses |
| `.env.example`, `.gitignore` | New variables, placeholders instead of a real login, `probe-output/` ignored |

No new npm packages. Wattwise's separate login is gone: the billing session covers the page and
the live stream, so no token appears in a URL.

## Data modes

`MONITOR_MODE=mock` (default) shows generated sample data with a yellow "Sample data" banner.
`MONITOR_MODE=live` reads the M-Carbon Dashboard using the `MCARBON_*` values in `.env`.

## What works in live mode today

Works, using responses the billing app already relies on: the site list, and 7-day and 30-day energy.

Not mapped yet, so the page shows a clear message instead of numbers: the overview map and totals,
meters, live kW, and today's hourly chart.

## Finishing the live mapping

1. Run `node tools/probe-monitor.js`.
2. Send back the files in `probe-output/`, or the exact request body from the browser's Network tab
   for `getMeterList`, `getMeterInfo`, `getBreakerPowerUsed` and the map page's calls.
3. Each `todo()` in `lib/monitor/live.js` is then replaced with a real mapping.
