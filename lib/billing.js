const round = (n, dp = 2) => {
  if (!isFinite(n)) return 0;
  const f = Math.pow(10, dp);
  return Math.round((n + Number.EPSILON) * f) / f;
};
const num = (v) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);

/**
 * Hours between two "HH:MM" clock times, treating the range as active time
 * for a rate (e.g. a solar rate from 08:00 to 16:00 = 8 hours). Wraps past
 * midnight when the end time is not after the start time (22:00–06:00 = 8 hours),
 * matching how a rate's active window is set up on the project.
 */
function hoursFromRange(from, to) {
  if (!from || !to) return null;
  const [fh, fm] = String(from).split(':').map(Number);
  const [th, tm] = String(to).split(':').map(Number);
  if ([fh, fm, th, tm].some((n) => !isFinite(n))) return null;
  let mins = (th * 60 + tm) - (fh * 60 + fm);
  if (mins <= 0) mins += 24 * 60;
  return mins / 60;
}

/** Inclusive day count between two YYYY-MM-DD dates. */
function daysBetween(start, end) {
  const a = new Date(start + 'T00:00:00Z');
  const b = new Date(end + 'T00:00:00Z');
  return Math.round((b - a) / 86400000) + 1;
}

/** List every date in an inclusive range as YYYY-MM-DD. */
function dateRange(start, end) {
  const out = [];
  const d = new Date(start + 'T00:00:00Z');
  const last = new Date(end + 'T00:00:00Z');
  while (d <= last) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * Method 1 — Dashboard fixed baseline.
 *   average daily baseline (kWh/day) x days in billing period
 */
function baselineFixed({ dailyBaseline, days }) {
  const baseline = num(dailyBaseline) * num(days);
  return {
    baseline_kwh: round(baseline, 3),
    working: [
      { label: 'Dashboard average daily baseline', value: `${round(num(dailyBaseline), 3)} kWh/day` },
      { label: 'Days in billing period', value: String(days) },
      { label: 'Calculated baseline', value: `${round(baseline, 3)} kWh` }
    ]
  };
}

/**
 * Method 2 — Agreed savings percentage.
 *   usage rate = 1 - agreed savings %
 *   baseline   = total actual consumption / usage rate
 */
function baselineSavingsPct({ agreedSavingsPct, actualKwh }) {
  const pct = num(agreedSavingsPct) / 100;
  const usageRate = 1 - pct;
  const baseline = usageRate > 0 ? num(actualKwh) / usageRate : 0;
  return {
    baseline_kwh: round(baseline, 3),
    working: [
      { label: 'Agreed savings percentage', value: `${round(num(agreedSavingsPct), 4)} %` },
      { label: 'Usage rate (1 − agreed savings)', value: `${round(usageRate * 100, 4)} %` },
      { label: 'Total actual consumption', value: `${round(num(actualKwh), 3)} kWh` },
      { label: 'Calculated baseline', value: `${round(baseline, 3)} kWh` }
    ],
    error: usageRate <= 0 ? 'Agreed savings percentage must be below 100%.' : null
  };
}

/**
 * Method 3 — Actual operating hours per day.
 *   per day: (dashboard daily baseline / 24) x operating hours
 *   total:   sum of the daily recomputed baselines
 */
function baselineOperatingHours({ dailyBaseline, days /* [{day_date, operating_hours, actual_kwh}] */ }) {
  const hourly = num(dailyBaseline) / 24;
  const rows = (days || []).map((d) => ({
    ...d,
    baseline_kwh: round(hourly * num(d.operating_hours), 4)
  }));
  const baseline = rows.reduce((s, r) => s + r.baseline_kwh, 0);
  const totalHours = rows.reduce((s, r) => s + num(r.operating_hours), 0);
  return {
    baseline_kwh: round(baseline, 3),
    daily: rows,
    working: [
      { label: 'Dashboard daily baseline', value: `${round(num(dailyBaseline), 3)} kWh/day` },
      { label: 'Hourly baseline (÷ 24)', value: `${round(hourly, 4)} kWh/hr` },
      { label: 'Total operating hours entered', value: `${round(totalHours, 2)} hrs over ${rows.length} days` },
      { label: 'Calculated baseline (sum of days)', value: `${round(baseline, 3)} kWh` }
    ]
  };
}

/**
 * Money side: savings -> gross cost savings -> sharing split.
 * `rateLines` is [{label, rate, kwh}]. With one line, kwh should equal total savings.
 */
function computeMoney({ baselineKwh, actualKwh, rateLines, inesPct, clientPct }) {
  const savings = round(num(baselineKwh) - num(actualKwh), 3);

  const lines = (rateLines || [])
    .filter((l) => l && (l.rate !== '' || l.kwh !== '' || (l.time_from && l.time_to)))
    .map((l) => {
      // A rate with an active-hours window (e.g. solar 08:00–16:00) gets its
      // share of the total energy savings worked out automatically instead of
      // a manually typed kWh figure: hours ÷ 24 × total energy savings.
      const hours = hoursFromRange(l.time_from, l.time_to);
      const lineKwh = hours !== null ? round(savings * (hours / 24), 3) : round(num(l.kwh), 3);
      return {
        label: l.label || 'Applicable rate',
        rate: round(num(l.rate), 4),
        time_from: l.time_from || null,
        time_to: l.time_to || null,
        hours: hours !== null ? round(hours, 2) : null,
        kwh: lineKwh,
        value: round(num(l.rate) * lineKwh, 2)
      };
    });

  const gross = round(lines.reduce((s, l) => s + l.value, 0), 2);
  const allocated = round(lines.reduce((s, l) => s + l.kwh, 0), 3);

  const ines = round(gross * (num(inesPct) / 100), 2);
  const client = round(gross * (num(clientPct) / 100), 2);

  const warnings = [];
  if (savings < 0) warnings.push('Actual consumption exceeds the calculated baseline — savings are negative.');
  if (lines.length && Math.abs(allocated - savings) > 0.01) {
    warnings.push(
      `Rate lines cover ${allocated} kWh but energy savings are ${savings} kWh (difference ${round(allocated - savings, 3)} kWh).`
    );
  }
  if (round(num(inesPct) + num(clientPct), 2) !== 100) {
    warnings.push(`Mirae ESP share + client share = ${round(num(inesPct) + num(clientPct), 2)}%, not 100%.`);
  }

  return {
    energy_savings_kwh: savings,
    rate_lines: lines,
    allocated_kwh: allocated,
    gross_savings: gross,
    amount_billed: ines,
    client_retained: client,
    warnings
  };
}

/**
 * Full computation for a billing period. Returns everything that gets frozen
 * onto the bill record so a statement stays reproducible.
 */
function computeBill(input) {
  const {
    baseline_method,
    period_start,
    period_end,
    dashboard_daily_baseline,
    agreed_savings_pct,
    actual_kwh,
    daily = [],
    rate_lines = [],
    ines_pct,
    client_pct,
    previous_balance = 0,
    interest_charged = 0,
    payments_total = 0,
    adjustments_total = 0
  } = input;

  const days = daysBetween(period_start, period_end);

  // With method 3 the daily grid is the source of actual consumption.
  const actual =
    baseline_method === 'operating_hours' && daily.length
      ? round(daily.reduce((s, d) => s + num(d.actual_kwh), 0), 3)
      : round(num(actual_kwh), 3);

  let base;
  if (baseline_method === 'savings_pct') {
    base = baselineSavingsPct({ agreedSavingsPct: agreed_savings_pct, actualKwh: actual });
  } else if (baseline_method === 'operating_hours') {
    base = baselineOperatingHours({ dailyBaseline: dashboard_daily_baseline, days: daily });
  } else {
    base = baselineFixed({ dailyBaseline: dashboard_daily_baseline, days });
  }

  const money = computeMoney({
    baselineKwh: base.baseline_kwh,
    actualKwh: actual,
    rateLines: rate_lines,
    inesPct: ines_pct,
    clientPct: client_pct
  });

  const total_due = round(
    money.amount_billed +
      num(previous_balance) +
      num(interest_charged) +
      num(adjustments_total) -
      num(payments_total),
    2
  );

  return {
    days,
    baseline_method,
    baseline_kwh: base.baseline_kwh,
    baseline_working: base.working,
    baseline_daily: base.daily || null,
    actual_kwh: actual,
    ...money,
    previous_balance: round(num(previous_balance), 2),
    interest_charged: round(num(interest_charged), 4),
    payments_total: round(num(payments_total), 2),
    adjustments_total: round(num(adjustments_total), 2),
    total_due,
    warnings: [...money.warnings, ...(base.error ? [base.error] : [])]
  };
}

/** Sharing ratio that applies to a billing period, by effective date. */
function ratioFor(ratios, periodEnd) {
  const applicable = (ratios || [])
    .filter((r) => r.effective_from <= periodEnd && (!r.effective_to || r.effective_to >= periodEnd))
    .sort((a, b) => (a.effective_from < b.effective_from ? 1 : -1));
  return applicable[0] || null;
}

module.exports = {
  round,
  daysBetween,
  dateRange,
  hoursFromRange,
  baselineFixed,
  baselineSavingsPct,
  baselineOperatingHours,
  computeMoney,
  computeBill,
  ratioFor
};