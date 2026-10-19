/* Korean text inside the graphs.
   Chart.js draws its legend, tooltip, axis and category text on a canvas, so the page translator in i18n.js
   (which walks the DOM) never sees it. This plugin runs the same translator (window.T) over the chart's own
   text before every update: dataset names (legend + tooltip), category labels (x axis, donut and pie slices)
   and axis / chart titles. Strings without a Korean entry are left as they are. Load it after Chart.js. */
(function () {
  if (!window.Chart || !Chart.register) return;
  const tx = (s) => (typeof s === 'string' && typeof window.T === 'function' ? window.T(s) : s);
  const title = (t) => { if (t && typeof t.text === 'string') { const k = tx(t.text); if (k !== t.text) t.text = k; } };

  Chart.register({
    id: 'koText',
    beforeUpdate(chart) {
      if (window.LANG !== 'ko') return;
      const data = chart.config.data || {}, opts = chart.config.options || {};

      (data.datasets || []).forEach((ds) => {
        if (typeof ds.label === 'string') { const k = tx(ds.label); if (k !== ds.label) ds.label = k; }
      });

      if (Array.isArray(data.labels)) {
        const out = data.labels.map(tx);
        if (out.some((v, i) => v !== data.labels[i])) data.labels = out;
      }

      const sc = opts.scales || {};
      Object.keys(sc).forEach((k) => sc[k] && title(sc[k].title));
      const pl = opts.plugins || {};
      title(pl.title);
      if (pl.legend) title(pl.legend.title);
    },
  });
})();
