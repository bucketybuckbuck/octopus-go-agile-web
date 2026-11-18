/* Octopus Go Agile — web edition.
 * Port of the Android app (com.jamsim.goagile). Everything runs in the browser and
 * talks to the public Octopus Energy REST API directly; settings and cached
 * responses live in this browser's localStorage only.
 */
'use strict';

const API = 'https://api.octopus.energy/v1';
const HALF_HOUR = 30 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

const REGIONS = [
  ['A', 'Eastern England'], ['B', 'East Midlands'], ['C', 'London'],
  ['D', 'Merseyside and Northern Wales'], ['E', 'West Midlands'], ['F', 'North Eastern England'],
  ['G', 'North Western England'], ['H', 'Southern England'], ['J', 'South Eastern England'],
  ['K', 'Southern Wales'], ['L', 'South Western England'], ['M', 'Yorkshire'],
  ['N', 'Southern Scotland'], ['P', 'Northern Scotland'],
];
const ALL_HOURS = Array.from({ length: 48 }, (_, i) =>
  `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);

const DEFAULTS = {
  apiKey: '', accountNumber: '', connected: null, mpan: '', serial: '', region: '', gasTariff: '',
  exportEnabled: false, exportMpan: '', exportSerial: '', exportFixed: 15,
  agileProduct: 'AGILE-24-10-01', goProduct: 'GO-VAR-22-10-14', exportProduct: 'AGILE-OUTGOING-19-05-13',
  smartTariff: false, currentTariff: 'go', highlightBorder: false, showAverage: false, startDay: 1,
  showPriceNow: false, showDayAverage: false, avgDay: 'today',
  highlightPrices: false, highThreshold: 30, lowThreshold: 15,
  timeshift: false, timeshiftHours: ALL_HOURS.slice(), baseload: 0.1, loadThreshold: 1.0, timeshiftAll: false,
  gas: false, mprn: '', gasSerial: '', gasStanding: 30, gasUnitRate: 6, gasKwh: false,
  volumeCorrection: 1.02264, calorificValue: 39.4,
  theme: 'system',
};

/* ---------------- storage ---------------- */
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch { return false; }
  },
  clearCache() {
    try {
      Object.keys(localStorage).filter(k => k.startsWith('ga:c:')).forEach(k => localStorage.removeItem(k));
    } catch { /* ignore */ }
  },
};

let settings = Object.assign({}, DEFAULTS, store.get('ga:settings', {}));
function saveSettings() { store.set('ga:settings', settings); applyTheme(); }
function applyTheme() {
  if (settings.theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
}
applyTheme();

const isConfigured = () => !!(settings.apiKey && settings.mpan && settings.serial && settings.region);
const isGasConfigured = () => !!(settings.gas && settings.apiKey && settings.mprn && settings.gasSerial);

/* ---------------- API ---------------- */
function authHeader() {
  return { Authorization: 'Basic ' + btoa(settings.apiKey.trim().replace(/:$/, '') + ':') };
}

async function fetchJson(url, auth) {
  const res = await fetch(url, { headers: auth ? authHeader() : {} });
  if (!res.ok) {
    const err = new Error(res.status === 401 || res.status === 403
      ? 'The Octopus API rejected your API key.'
      : res.status === 404 ? 'Not found — check your MPAN / serial / product codes.'
      : `Octopus API error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function fetchAll(url, auth) {
  const out = [];
  let next = url;
  let guard = 0;
  while (next && guard++ < 50) {
    const page = await fetchJson(next, auth);
    out.push(...page.results);
    next = page.next;
  }
  return out;
}

/** Cached fetch: ranges entirely older than two days are kept indefinitely, recent ones for 30 minutes. */
async function cachedAll(kind, url, auth, rangeEnd) {
  const key = 'ga:c:' + kind + ':' + url;
  const hit = store.get(key, null);
  const settled = rangeEnd && rangeEnd < Date.now() - 2 * DAY;
  if (hit && (settled || Date.now() - hit.t < 30 * 60 * 1000)) return hit.d;
  const data = await fetchAll(url, auth);
  if (!store.set(key, { t: Date.now(), d: data })) {
    store.clearCache();
    store.set(key, { t: Date.now(), d: data });
  }
  return data;
}

const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const tariffCode = (product, region) => `E-1R-${product}-${region}`;

function ratesUrl(product, from, to) {
  return `${API}/products/${product}/electricity-tariffs/${tariffCode(product, settings.region)}` +
    `/standard-unit-rates/?period_from=${iso(from)}&period_to=${iso(to)}&page_size=1500`;
}
function standingUrl(product) {
  return `${API}/products/${product}/electricity-tariffs/${tariffCode(product, settings.region)}/standing-charges/`;
}
function consumptionUrl(kind, mpan, serial, from, to) {
  const base = kind === 'gas' ? 'gas-meter-points' : 'electricity-meter-points';
  return `${API}/${base}/${encodeURIComponent(mpan)}/meters/${encodeURIComponent(serial)}/consumption/` +
    `?period_from=${iso(from)}&period_to=${iso(to)}&page_size=25000&order_by=period`;
}

/** "E-1R-AGILE-24-10-01-C" → "AGILE-24-10-01"; "G-1R-VAR-22-11-01-C" → "VAR-22-11-01". */
function productFromCode(code) { return String(code || '').replace(/^[EG]-\d+R-/, '').replace(/-[A-P]$/, ''); }
function regionFromCode(code) { const m = /-([A-P])$/.exec(code || ''); return m ? m[1] : ''; }
function gasTariffUrl(kind, from, to) {
  const code = settings.gasTariff;
  const range = from ? `?period_from=${iso(from)}&period_to=${iso(to)}&page_size=1500` : '';
  return `${API}/products/${productFromCode(code)}/gas-tariffs/${code}/${kind}/${range}`;
}
function tariffKind(product) {
  if (/^AGILE-OUTGOING/.test(product)) return 'agile-export';
  if (/^AGILE-/.test(product)) return 'agile';
  if (/^(GO|INTELLI|IOG)/.test(product)) return 'go';
  return 'other';
}

/**
 * Look up the account and fill in meters, serials, region and tariffs.
 * Needs only the API key and account number (A-XXXXXXXX).
 */
async function connectAccount() {
  const acct = settings.accountNumber.trim().toUpperCase();
  if (!settings.apiKey || !acct) throw new Error('Enter your API key and account number first.');
  const j = await fetchJson(`${API}/accounts/${encodeURIComponent(acct)}/`, true).catch(e => {
    if (e.status === 404) throw new Error(`Account ${acct} wasn't found. Check the number (it looks like A-1B2C3D4E).`);
    throw e;
  });
  const now = Date.now();
  const props = j.properties || [];
  const prop = props.find(p => !p.moved_out_at || Date.parse(p.moved_out_at) > now) || props[props.length - 1];
  if (!prop) throw new Error('No properties found on this account.');

  const currentAgreement = ags => {
    const list = (ags || []).slice().sort((a, b) => Date.parse(b.valid_from) - Date.parse(a.valid_from));
    return list.find(a => Date.parse(a.valid_from) <= now && (!a.valid_to || Date.parse(a.valid_to) > now)) || list[0];
  };
  // A meter point can list old meters too; use the newest one that actually has readings.
  const pickSerial = async (kind, id, meters) => {
    const serials = (meters || []).map(m => m.serial_number).filter(Boolean).reverse();
    const base = kind === 'gas' ? 'gas-meter-points' : 'electricity-meter-points';
    for (const s of serials) {
      try {
        const r = await fetchJson(`${API}/${base}/${encodeURIComponent(id)}/meters/${encodeURIComponent(s)}/consumption/?page_size=1`, true);
        if (r.count > 0) return s;
      } catch { /* try the next meter */ }
    }
    return serials[0] || '';
  };

  const productName = async p => (await fetchJson(`${API}/products/${p}/`, false).catch(() => ({}))).display_name || p;
  const summary = { account: acct, address: [prop.address_line_1, prop.postcode].filter(Boolean).join(', ') };
  const elec = prop.electricity_meter_points || [];
  const imp = elec.find(p => !p.is_export);
  const exp = elec.find(p => p.is_export);

  if (imp) {
    settings.mpan = imp.mpan;
    settings.serial = await pickSerial('elec', imp.mpan, imp.meters);
    const ag = currentAgreement(imp.agreements);
    if (ag) {
      const product = productFromCode(ag.tariff_code);
      settings.region = regionFromCode(ag.tariff_code) || settings.region;
      const kind = tariffKind(product);
      if (kind === 'agile') { settings.agileProduct = product; settings.currentTariff = 'agile'; }
      if (kind === 'go') { settings.goProduct = product; settings.currentTariff = 'go'; }
      summary.elecTariff = await productName(product);
    }
    if (!settings.region) {
      const mp = await fetchJson(`${API}/electricity-meter-points/${encodeURIComponent(imp.mpan)}/`, false).catch(() => ({}));
      settings.region = (mp.gsp || '').replace('_', '');
    }
  }
  if (exp) {
    settings.exportEnabled = true;
    settings.exportMpan = exp.mpan;
    settings.exportSerial = await pickSerial('elec', exp.mpan, exp.meters);
    const ag = currentAgreement(exp.agreements);
    if (ag) {
      const product = productFromCode(ag.tariff_code);
      summary.exportTariff = await productName(product);
      if (tariffKind(product) === 'agile-export') settings.exportProduct = product;
      else {
        const r = await fetchJson(`${API}/products/${product}/electricity-tariffs/${ag.tariff_code}/standard-unit-rates/?page_size=1`, false).catch(() => null);
        if (r && r.results && r.results[0]) settings.exportFixed = r.results[0].value_inc_vat;
      }
    }
  } else {
    settings.exportEnabled = false;
  }
  const gas = (prop.gas_meter_points || [])[0];
  if (gas) {
    settings.gas = true;
    settings.mprn = gas.mprn;
    settings.gasSerial = await pickSerial('gas', gas.mprn, gas.meters);
    const ag = currentAgreement(gas.agreements);
    settings.gasTariff = ag ? ag.tariff_code : '';
    if (ag) summary.gasTariff = await productName(productFromCode(ag.tariff_code));
  } else {
    settings.gas = false;
  }
  summary.mpan = settings.mpan; summary.region = settings.region;
  summary.exportMpan = exp ? settings.exportMpan : ''; summary.mprn = gas ? settings.mprn : '';
  settings.accountNumber = acct;
  settings.connected = summary;
  store.clearCache();
  historyOffset = 0;
  saveSettings();
  return summary;
}

/** Normalise rate results into sorted bands {from, to, p}. */
function toBands(results) {
  return results.map(r => ({
    from: Date.parse(r.valid_from),
    to: r.valid_to ? Date.parse(r.valid_to) : Infinity,
    p: r.value_inc_vat,
  })).sort((a, b) => a.from - b.from);
}
function rateAt(bands, t) {
  for (let i = bands.length - 1; i >= 0; i--) {
    if (bands[i].from <= t && t < bands[i].to) return bands[i].p;
  }
  return null;
}

/* ---------------- dates ---------------- */
const fmtTime = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtDayLong = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtShort = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const fmtShortY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDate = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });

function midnight(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function hhmm(ms) { return fmtTime.format(new Date(ms)); }

/** Billing period for `offset` months from the current one, starting on settings.startDay. */
function billingPeriod(offset) {
  const s = Math.min(28, Math.max(1, parseInt(settings.startDay, 10) || 1));
  const today = midnight(new Date());
  let y = today.getFullYear(), m = today.getMonth();
  if (today.getDate() < s) m -= 1;
  m += offset;
  const start = new Date(y, m, s);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, s);
  return { start, end };
}
function periodLabel({ start, end }) {
  const last = addDays(end, -1);
  if (start.getDate() === 1) return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(start);
  return `${fmtShort.format(start)} – ${fmtShortY.format(last)}`;
}
function daysIn(start, end) {
  const out = [];
  for (let d = new Date(start); d < end; d = addDays(d, 1)) out.push(new Date(d));
  return out;
}

/* ---------------- formatting ---------------- */
const pounds = pence => '£' + (pence / 100).toFixed(2);
const pence = p => (p == null || isNaN(p) ? '–' : p.toFixed(2) + 'p');
const kwh = v => v.toFixed(2) + ' kWh';
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, d) => { const n = parseFloat(v); return isNaN(n) ? d : n; };

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 4000);
}

function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

/* ---------------- cost model ---------------- */
/**
 * Build half-hour items for one day and total up the Agile vs Go costs.
 * Mirrors ChartWrapper.calculateCombinedData / CostSummary from the Android app,
 * but takes Go rates from the API (time-banded) instead of hard-coded windows.
 */
function computeDay(slots, agileBands, goBands, standing, opts) {
  const isExport = !!opts.isExport;
  const items = slots.map(s => ({
    t: s.t,
    kwh: s.kwh,
    agile: rateAt(agileBands, s.t),
    go: isExport ? num(settings.exportFixed, 15) : rateAt(goBands, s.t),
    goKwh: s.kwh,
    shifted: false,
    shiftSource: false,
  }));

  if (opts.shift && !isExport) applyLoadShift(items);

  let agileCost = 0, goCost = 0, total = 0, agileRateSum = 0, agileRateN = 0;
  for (const it of items) {
    total += it.kwh;
    if (it.agile != null) { agileCost += it.kwh * it.agile; agileRateSum += it.agile; agileRateN++; }
    if (it.go != null) goCost += it.goKwh * it.go;
  }
  const energyAgile = agileCost, energyGo = goCost;
  if (!isExport) { agileCost += standing.agile || 0; goCost += standing.go || 0; }
  return {
    items, total, agileCost, goCost,
    agileAvg: agileRateN ? agileRateSum / agileRateN : null,
    actualAvg: total ? energyAgile / total : null,
    goAvg: total ? energyGo / total : null,
  };
}

/**
 * Agile→Go load shift (port of CombinedGestureListener.calculateMoveable):
 * the biggest half-hours above the threshold, within the chosen hours and outside the
 * cheap Go window, are moved into free cheap Go slots, leaving the baseload behind.
 */
function applyLoadShift(items) {
  const goRates = items.map(i => i.go).filter(p => p != null);
  if (!goRates.length) return;
  const peak = Math.max(...goRates);
  const cheapIdx = items.map((it, i) => (it.go != null && it.go < peak ? i : -1)).filter(i => i >= 0);
  if (!cheapIdx.length) return;
  const threshold = num(settings.loadThreshold, 1);
  const baseload = num(settings.baseload, 0.1);
  const hours = new Set(settings.timeshiftHours || ALL_HOURS);
  const cheapSet = new Set(cheapIdx);

  const candidates = items
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => it.kwh > threshold && hours.has(hhmm(it.t)))
    .sort((a, b) => b.it.kwh - a.it.kwh)
    .slice(0, cheapIdx.length);

  const occupied = new Set(candidates.filter(c => cheapSet.has(c.i)).map(c => c.i));
  const moveable = candidates.filter(c => !cheapSet.has(c.i)).sort((a, b) => a.i - b.i);
  const free = cheapIdx.filter(i => !occupied.has(i));

  moveable.forEach((c, n) => {
    if (n >= free.length) return;
    const target = items[free[n]];
    const moved = Math.max(0, c.it.kwh - baseload);
    c.it.goKwh = c.it.kwh - moved;
    c.it.shiftSource = true;
    target.goKwh += moved;
    target.shifted = true;
  });
}

/* ---------------- data loading ---------------- */
async function loadStanding() {
  const [a, g] = await Promise.all([
    cachedAll('sc', standingUrl(settings.agileProduct), false),
    cachedAll('sc', standingUrl(settings.goProduct), false),
  ]);
  return { agile: toBands(a), go: toBands(g) };
}

/** Load consumption + rates for [from, to) and split them into days. */
async function loadElectricity(from, to, isExport) {
  const now = Date.now();
  const cappedTo = Math.min(to, midnight(addDays(new Date(), 1)).getTime());
  const mpan = isExport ? settings.exportMpan : settings.mpan;
  const serial = isExport ? (settings.exportSerial || settings.serial) : settings.serial;
  const importProduct = isExport ? settings.exportProduct : settings.agileProduct;

  const [cons, agile, go, standing] = await Promise.all([
    cachedAll('cons', consumptionUrl('elec', mpan, serial, from, cappedTo), true, cappedTo),
    cachedAll('rates', ratesUrl(importProduct, from, cappedTo), false, cappedTo),
    isExport ? Promise.resolve([]) : cachedAll('rates', ratesUrl(settings.goProduct, from, cappedTo), false, cappedTo),
    isExport ? Promise.resolve({ agile: [], go: [] }) : loadStanding(),
  ]);
  return {
    slots: cons.map(c => ({ t: Date.parse(c.interval_start), kwh: c.consumption })).sort((a, b) => a.t - b.t),
    agileBands: toBands(agile),
    goBands: toBands(go),
    standing,
    fetchedUntil: Math.min(now, cappedTo),
  };
}

function splitByDay(slots, days) {
  const map = new Map(days.map(d => [d.getTime(), []]));
  for (const s of slots) {
    const key = midnight(new Date(s.t)).getTime();
    if (map.has(key)) map.get(key).push(s);
  }
  return map;
}

/* ---------------- charts ---------------- */
const charts = new Set();
function destroyCharts() { charts.forEach(c => c.destroy()); charts.clear(); }

function baseChartOptions() {
  const text = css('--muted');
  const grid = css('--grid');
  return {
    responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { color: text, boxWidth: 12 } } },
    scales: {
      x: { ticks: { color: text, maxRotation: 0, autoSkipPadding: 8 }, grid: { display: false } },
      y: { ticks: { color: text }, grid: { color: grid } },
    },
  };
}

function dayChart(canvas, day, opts) {
  const isExport = opts.isExport;
  const items = day.items;
  const colors = items.map(it => {
    if (it.shifted) return css('--bar-shift');
    const neg = it.agile != null && it.agile <= 0;
    const c = neg ? css('--bar-neg') : css('--bar');
    return it.shiftSource ? c + '55' : c;
  });
  const o = baseChartOptions();
  o.scales.y.title = { display: true, text: 'kWh', color: css('--muted') };
  o.scales.y.beginAtZero = true;
  o.scales.y1 = {
    position: 'right', ticks: { color: css('--muted') }, grid: { display: false },
    title: { display: true, text: 'p/kWh', color: css('--muted') },
  };
  o.plugins.tooltip = {
    callbacks: {
      label: ctx => {
        if (ctx.dataset.yAxisID === 'y') return ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(3)} kWh`;
        return ` ${ctx.dataset.label}: ${pence(ctx.parsed.y)}`;
      },
    },
  };
  const agileLabel = (isExport ? 'Agile Outgoing ' : 'Agile ') + pounds(day.agileCost);
  const goLabel = (isExport ? 'Fixed ' : 'Go ') + pounds(day.goCost);
  const chart = new Chart(canvas, {
    data: {
      labels: items.map(it => hhmm(it.t)),
      datasets: [
        { type: 'line', label: agileLabel, data: items.map(i => i.agile), yAxisID: 'y1', stepped: 'middle',
          borderColor: css('--agile'), borderWidth: 1.5, pointRadius: 0, order: 1 },
        { type: 'line', label: goLabel, data: items.map(i => i.go), yAxisID: 'y1', stepped: 'middle',
          borderColor: css('--go'), borderWidth: 1.5, pointRadius: 0, order: 2 },
        { type: 'bar', label: day.anyShift ? 'Usage (shifted)' : 'Usage', data: items.map(i => i.goKwh),
          backgroundColor: colors, yAxisID: 'y', order: 3, barPercentage: 1, categoryPercentage: 0.9 },
      ],
    },
    options: o,
  });
  charts.add(chart);
  return chart;
}

/* ---------------- views ---------------- */
const view = () => document.getElementById('view');
let historyOffset = 0;
let exportMode = false;
let renderToken = 0;

function setPeriodNav(show, label, canNext, showExport) {
  const nav = document.getElementById('period-nav');
  nav.hidden = !show;
  if (!show) return;
  document.getElementById('period-label').textContent = label;
  document.getElementById('next').disabled = !canNext;
  document.getElementById('export-toggle').hidden = !showExport;
  document.getElementById('export-switch').checked = exportMode;
}

function needsSetup(what) {
  return `<div class="notice">
    <h2>Set up your account</h2>
    <p>${what} needs your Octopus API key and account number — the app looks up the rest.
    Both are on your <a href="https://octopus.energy/dashboard/new/accounts/personal-details/api-access" target="_blank" rel="noopener">Octopus API access page</a>.</p>
    <p><a href="#settings" class="btn" style="text-decoration:none;display:inline-block">Open settings</a></p>
  </div>`;
}

function errorBox(err) {
  return `<div class="notice"><b>Couldn't load data.</b> ${esc(err.message || err)}
    <p class="small muted">Check your details in Settings. Data normally appears a day or so after use.</p></div>`;
}

/* ---- Home ---- */
function priceShade(p) {
  if (!settings.highlightPrices) return '';
  const low = num(settings.lowThreshold, 15), high = num(settings.highThreshold, 30);
  if (p <= 0) return 'background:#0383da;color:#fff';
  if (p < low) return 'background:#03dac5;color:#000';
  if (p > high) return 'background:rgba(218,3,24,.5);color:#fff';
  const x = (p - low) / (high - low || 1);
  if (x > 0.5) return `background:rgba(255,0,0,${(1 - 0.5 / x).toFixed(2)})`;
  return `background:rgba(3,218,197,${(1 - x / 0.5).toFixed(2)})`;
}

async function renderHome(token) {
  setPeriodNav(false);
  const el = view();
  if (!settings.region) {
    el.innerHTML = `<div class="notice"><h2>Pick your region</h2>
      <p>Agile prices depend on your electricity region. Set it in Settings to see today's prices —
      no API key needed for this page.</p>
      <p><a href="#settings" class="btn" style="text-decoration:none;display:inline-block">Open settings</a></p></div>`;
    return;
  }
  el.innerHTML = `
    <section class="card" id="yesterday-card">
      <h2 id="yesterday-title">Yesterday</h2>
      <div id="yesterday-body" class="muted small">Loading…</div>
    </section>
    <section class="card">
      <h2>Agile prices</h2>
      <div class="chart-box"><canvas id="price-chart" aria-label="Agile prices today and tomorrow"></canvas></div>
    </section>
    <section class="card" style="padding:0">
      <ul class="price-list" id="price-list"><li class="muted">Loading prices…</li></ul>
    </section>`;

  const today = midnight(new Date());
  const from = today.getTime();
  const to = addDays(today, 2).getTime();
  try {
    const raw = await cachedAll('home', ratesUrl(settings.agileProduct, from, to), false);
    if (token !== renderToken) return;
    const prices = raw.map(r => ({ t: Date.parse(r.valid_from), p: r.value_inc_vat })).sort((a, b) => a.t - b.t);
    renderPriceList(prices);
    renderPriceChart(prices);
  } catch (e) {
    if (token !== renderToken) return;
    document.getElementById('price-list').innerHTML = `<li>${esc(e.message)}</li>`;
  }

  // Yesterday's usage chart (shown at the top of the Android home screen)
  const body = document.getElementById('yesterday-body');
  if (!isConfigured()) {
    body.innerHTML = 'Connect your Octopus account in <a href="#settings">Settings</a> to see yesterday\'s Agile vs Go comparison here.';
    return;
  }
  const yStart = addDays(today, -1);
  document.getElementById('yesterday-title').textContent = 'Yesterday · ' + fmtDayLong.format(yStart);
  try {
    const data = await loadElectricity(yStart.getTime(), today.getTime(), false);
    if (token !== renderToken) return;
    if (data.slots.length < 3) {
      body.textContent = "Yesterday's smart meter readings haven't arrived yet — Octopus usually publishes them within a day.";
      return;
    }
    const sc = { agile: rateAt(data.standing.agile, yStart.getTime()), go: rateAt(data.standing.go, yStart.getTime()) };
    const day = computeDay(data.slots, data.agileBands, data.goBands, sc, { shift: settings.timeshift && settings.timeshiftAll });
    body.outerHTML = dayCardInner(day, yStart, false) +
      `<div class="chart-box"><canvas id="yesterday-chart"></canvas></div>`;
    paintWarn(document.getElementById('yesterday-card'), day, false);
    dayChart(document.getElementById('yesterday-chart'), day, { isExport: false });
  } catch (e) {
    if (token !== renderToken) return;
    body.innerHTML = esc(e.message);
  }
}

function renderPriceList(prices) {
  const list = document.getElementById('price-list');
  const now = Date.now();
  let shown = prices.slice().reverse(); // newest first, like the Android list
  if (settings.showPriceNow) shown = shown.filter(x => x.t + HALF_HOUR > now);
  const rows = [];
  if (settings.showDayAverage) {
    const todayKey = midnight(new Date()).getTime();
    const wantTomorrow = settings.avgDay === 'tomorrow';
    const sel = prices.filter(x => (midnight(new Date(x.t)).getTime() === todayKey) !== wantTomorrow).map(x => x.p);
    if (sel.length) {
      const avg = sel.reduce((a, b) => a + b, 0) / sel.length;
      rows.push(`<li class="minmax"><span>Avg ${pence(avg)}</span><span>Min ${pence(Math.min(...sel))}</span><span>Max ${pence(Math.max(...sel))}</span></li>`);
    } else {
      rows.push(`<li class="minmax"><span class="muted">No ${wantTomorrow ? "tomorrow's" : "today's"} prices yet</span><span></span><span></span></li>`);
    }
  }
  for (const x of shown) {
    const isNow = x.t <= now && now < x.t + HALF_HOUR;
    rows.push(`<li class="${isNow ? 'now' : ''}" ${isNow ? 'id="now-row"' : ''}>
      <span class="date">${fmtDate.format(new Date(x.t))}</span>
      <span class="time">${hhmm(x.t)}</span>
      <span class="price" style="${isNow ? '' : priceShade(x.p)}">${pence(x.p)}</span></li>`);
  }
  list.innerHTML = rows.join('') || '<li class="muted">No prices published yet.</li>';
}

function renderPriceChart(prices) {
  const now = Date.now();
  const o = baseChartOptions();
  o.plugins.legend.display = false;
  o.scales.y.title = { display: true, text: 'p/kWh', color: css('--muted') };
  o.plugins.tooltip = { callbacks: {
    title: c => fmtDay.format(new Date(prices[c[0].dataIndex].t)) + ' ' + hhmm(prices[c[0].dataIndex].t),
    label: c => ' ' + pence(c.parsed.y),
  } };
  const colors = prices.map(x => {
    if (x.t <= now && now < x.t + HALF_HOUR) return css('--go');
    if (x.p <= 0) return css('--bar-neg');
    return x.t + HALF_HOUR <= now ? css('--primary') + '55' : css('--primary');
  });
  charts.add(new Chart(document.getElementById('price-chart'), {
    type: 'bar',
    data: {
      labels: prices.map(x => (hhmm(x.t) === '00:00' ? fmtShort.format(new Date(x.t)) : hhmm(x.t))),
      datasets: [{ data: prices.map(x => x.p), backgroundColor: colors, barPercentage: 1, categoryPercentage: 0.85 }],
    },
    options: o,
  }));
}

/* ---- History ---- */
function dayCardInner(day, date, isExport) {
  const a = isExport ? 'Agile Outgoing' : 'Agile';
  const g = isExport ? 'Fixed' : 'Go';
  let avg = '';
  if (settings.showAverage && day.total > 0) {
    avg = `<div class="small muted">Agile avg rate ${pence(day.agileAvg)} · your avg ${pence(day.actualAvg)} · ${g} avg ${pence(day.goAvg)}</div>`;
  }
  return `<div class="day-head">
      <span class="totals"><b class="agile">${a} ${pounds(day.agileCost)}</b> · <b class="go">${g} ${pounds(day.goCost)}</b> · ${kwh(day.total)}</span>
    </div>${avg}`;
}

/** "Graph warning highlight": flag days where the tariff you're not on would have been cheaper. */
function paintWarn(card, day, isExport) {
  card.classList.remove('warn', 'warn-border');
  if (!settings.smartTariff || isExport || !day.total) return;
  const onGo = settings.currentTariff === 'go';
  const bad = onGo ? day.agileCost < day.goCost : day.goCost < day.agileCost;
  if (bad) card.classList.add(settings.highlightBorder ? 'warn-border' : 'warn');
}

async function renderHistory(token) {
  const el = view();
  const period = billingPeriod(historyOffset);
  const isExport = exportMode && settings.exportEnabled;
  setPeriodNav(true, periodLabel(period), historyOffset < 0, settings.exportEnabled);
  if (!isConfigured() || (isExport && !settings.exportMpan)) {
    el.innerHTML = needsSetup(isExport ? 'Export history (with an export MPAN)' : 'History');
    return;
  }
  el.innerHTML = `<section class="card" id="summary"><h2>${isExport ? 'Export' : 'Usage'} summary</h2>
    <div class="progress"><div style="width:30%"></div></div><div class="muted small">Loading ${esc(periodLabel(period))}…</div></section>
    <div id="days"></div>`;

  const days = daysIn(period.start, period.end).filter(d => d <= new Date());
  let data;
  try {
    data = await loadElectricity(period.start.getTime(), period.end.getTime(), isExport);
  } catch (e) {
    if (token !== renderToken) return;
    el.innerHTML = errorBox(e);
    return;
  }
  if (token !== renderToken) return;

  const byDay = splitByDay(data.slots, days);
  const shiftAll = settings.timeshift && settings.timeshiftAll;
  const results = [];
  for (const d of days) {
    const slots = byDay.get(d.getTime()) || [];
    if (slots.length < 3) { results.push({ date: d, day: null }); continue; }
    const sc = isExport ? {} : { agile: rateAt(data.standing.agile, d.getTime()), go: rateAt(data.standing.go, d.getTime()) };
    const plain = computeDay(slots, data.agileBands, data.goBands, sc, { isExport });
    const shifted = settings.timeshift && !isExport
      ? computeDay(slots, data.agileBands, data.goBands, sc, { isExport, shift: true }) : null;
    if (shifted) shifted.anyShift = shifted.items.some(i => i.shifted);
    results.push({ date: d, day: plain, shifted, showShift: shiftAll });
  }

  renderSummary(results, isExport);

  const daysEl = document.getElementById('days');
  const withData = results.filter(r => r.day).reverse();
  if (!withData.length) {
    daysEl.innerHTML = `<div class="notice">No smart meter readings for this period yet.</div>`;
    return;
  }
  daysEl.innerHTML = withData.map((r, i) => `
    <section class="card" data-i="${i}">
      <div class="day-head"><h3>${fmtDayLong.format(r.date)}</h3>
        ${r.shifted && r.shifted.anyShift ? `<button class="chip-btn" aria-pressed="${r.showShift}">Load shift</button>` : ''}</div>
      <div class="day-body"></div>
      <div class="chart-box"><canvas aria-label="Usage and prices for ${esc(fmtDayLong.format(r.date))}"></canvas></div>
    </section>`).join('');

  // Draw charts lazily as cards scroll into view.
  const drawn = new Map();
  const draw = card => {
    const r = withData[+card.dataset.i];
    const day = r.showShift && r.shifted ? r.shifted : r.day;
    card.querySelector('.day-body').innerHTML = dayCardInner(day, r.date, isExport);
    paintWarn(card, day, isExport);
    if (drawn.has(card)) { const old = drawn.get(card); charts.delete(old); old.destroy(); }
    drawn.set(card, dayChart(card.querySelector('canvas'), day, { isExport }));
  };
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => { if (e.isIntersecting && !drawn.has(e.target)) draw(e.target); });
  }, { rootMargin: '400px' });
  daysEl.querySelectorAll('section.card').forEach(card => {
    io.observe(card);
    const toggle = () => {
      const r = withData[+card.dataset.i];
      if (!r.shifted || !r.shifted.anyShift) return;
      r.showShift = !r.showShift;
      const btn = card.querySelector('.chip-btn');
      if (btn) btn.setAttribute('aria-pressed', r.showShift);
      draw(card);
    };
    card.querySelector('.chip-btn')?.addEventListener('click', toggle);
    card.querySelector('canvas').addEventListener('click', toggle);
  });
  observers.push(io);
}
const observers = [];

function renderSummary(results, isExport) {
  const days = results.filter(r => r.day);
  const sum = (f) => days.reduce((a, r) => a + f(r), 0);
  const agile = sum(r => r.day.agileCost);
  const go = sum(r => r.day.goCost);
  const goShift = settings.timeshift && !isExport ? sum(r => (r.shifted || r.day).goCost) : null;
  const total = sum(r => r.day.total);
  const a = isExport ? 'Agile Outgoing' : 'Agile';
  const g = isExport ? 'Fixed export' : 'Go';
  const bestAgile = isExport ? agile > go : agile < go;
  const diff = Math.abs(agile - go);
  const winner = bestAgile ? a : g;
  const card = document.getElementById('summary');
  if (!days.length) {
    card.innerHTML = `<h2>${isExport ? 'Export' : 'Usage'} summary</h2><p class="muted">No readings in this period.</p>`;
    return;
  }
  const agileRates = days.map(r => r.day.agileAvg).filter(x => x != null);
  const energyAgile = sum(r => r.day.items.reduce((s, i) => s + (i.agile ?? 0) * i.kwh, 0));
  card.innerHTML = `
    <h2>${isExport ? 'Export' : 'Usage'} summary · ${days.length} day${days.length > 1 ? 's' : ''}</h2>
    <div class="stats">
      <div class="stat agile ${bestAgile ? 'best' : ''}"><div class="label">${a}${isExport ? ' earnings' : ' cost'}</div><div class="value">${pounds(agile)}</div></div>
      <div class="stat go ${!bestAgile ? 'best' : ''}"><div class="label">${g}${isExport ? ' earnings' : ' cost'}</div><div class="value">${pounds(go)}</div></div>
      <div class="stat"><div class="label">${isExport ? 'Exported' : 'Used'}</div><div class="value">${total.toFixed(1)} kWh</div></div>
      <div class="stat"><div class="label">Your avg rate${isExport ? '' : ' (excl. standing)'}</div><div class="value">${pence(total ? energyAgile / total : null)}</div></div>
      <div class="stat"><div class="label">Agile avg unit rate</div><div class="value">${pence(agileRates.length ? agileRates.reduce((x, y) => x + y, 0) / agileRates.length : null)}</div></div>
      ${goShift != null ? `<div class="stat go"><div class="label">Go with load shift</div><div class="value">${pounds(goShift)}</div></div>` : ''}
    </div>
    <p class="small" style="margin:10px 0 0"><b>${esc(winner)}</b> ${isExport ? 'paid' : 'was cheaper'} by <b>${pounds(diff)}</b> over this period${isExport ? '' : ' (standing charges included)'}.</p>
    <div class="chart-box" style="height:200px;margin-top:10px"><canvas id="summary-chart"></canvas></div>`;

  const o = baseChartOptions();
  o.plugins.tooltip = { callbacks: { label: c => ` ${c.dataset.label}: ${pounds(c.parsed.y * 100)}` } };
  o.scales.y.ticks.callback = v => '£' + v;
  const chrono = days.slice();
  charts.add(new Chart(document.getElementById('summary-chart'), {
    type: 'bar',
    data: {
      labels: chrono.map(r => fmtShort.format(r.date)),
      datasets: [
        { label: a, data: chrono.map(r => r.day.agileCost / 100), backgroundColor: css('--agile') },
        { label: g, data: chrono.map(r => r.day.goCost / 100), backgroundColor: css('--go') },
      ],
    },
    options: o,
  }));
}

/* ---- Gas ---- */
function gasKwh(v) {
  return settings.gasKwh ? v : (v * num(settings.volumeCorrection, 1.02264) * num(settings.calorificValue, 39.4)) / 3.6;
}

async function renderGas(token) {
  const el = view();
  const period = billingPeriod(historyOffset);
  setPeriodNav(true, periodLabel(period), historyOffset < 0, false);
  if (!isGasConfigured()) {
    el.innerHTML = `<div class="notice"><h2>Gas</h2><p>${settings.connected
      ? 'No gas meter was found on your Octopus account.'
      : 'Connect your Octopus account in <a href="#settings">Settings</a> — if you have a gas smart meter it\'s picked up automatically.'}</p></div>`;
    return;
  }
  el.innerHTML = `<section class="card" id="gas-summary"><h2>Gas summary</h2><div class="muted small">Loading…</div></section><div id="gas-days"></div>`;
  const days = daysIn(period.start, period.end).filter(d => d <= new Date());
  const to = Math.min(period.end.getTime(), midnight(addDays(new Date(), 1)).getTime());
  let cons, unitBands = [], scBands = [];
  try {
    const gasRates = settings.gasTariff ? Promise.all([
      cachedAll('rates', gasTariffUrl('standard-unit-rates', period.start.getTime(), to), false, to),
      cachedAll('sc', gasTariffUrl('standing-charges'), false),
    ]).catch(() => [[], []]) : Promise.resolve([[], []]);
    [cons, [unitBands, scBands]] = await Promise.all([
      cachedAll('gas', consumptionUrl('gas', settings.mprn, settings.gasSerial, period.start.getTime(), to), true, to),
      gasRates.then(([u, s]) => [toBands(u), toBands(s)]),
    ]);
  } catch (e) {
    if (token !== renderToken) return;
    el.innerHTML = errorBox(e);
    return;
  }
  if (token !== renderToken) return;
  const useTariff = unitBands.length > 0;
  const manualUnit = num(settings.gasUnitRate, 6), manualSc = num(settings.gasStanding, 30);
  const unitAt = t => (useTariff ? rateAt(unitBands, t) ?? manualUnit : manualUnit);
  const scAt = t => (useTariff ? rateAt(scBands, t) ?? manualSc : manualSc);
  const slots = cons.map(c => {
    const t = Date.parse(c.interval_start);
    return { t, kwh: gasKwh(c.consumption), p: unitAt(t) };
  }).sort((a, b) => a.t - b.t);
  const byDay = splitByDay(slots, days);
  const results = days.map(d => {
    const s = byDay.get(d.getTime()) || [];
    const total = s.reduce((a, x) => a + x.kwh, 0);
    const energy = s.reduce((a, x) => a + x.kwh * x.p, 0);
    return { date: d, slots: s, total, cost: s.length ? energy + scAt(d.getTime()) : 0 };
  }).filter(r => r.slots.length);
  const lastDay = results.length ? results[results.length - 1].date.getTime() : Date.now();
  const unit = unitAt(lastDay), sc = scAt(lastDay);

  const sumEl = document.getElementById('gas-summary');
  if (!results.length) { sumEl.innerHTML = '<h2>Gas summary</h2><p class="muted">No gas readings in this period yet.</p>'; return; }
  const total = results.reduce((a, r) => a + r.total, 0);
  const cost = results.reduce((a, r) => a + r.cost, 0);
  sumEl.innerHTML = `<h2>Gas summary · ${results.length} day${results.length > 1 ? 's' : ''}</h2>
    <div class="stats">
      <div class="stat go"><div class="label">Cost (incl. standing)</div><div class="value">${pounds(cost)}</div></div>
      <div class="stat"><div class="label">Used</div><div class="value">${total.toFixed(1)} kWh</div></div>
      <div class="stat"><div class="label">Daily average</div><div class="value">${pounds(cost / results.length)}</div></div>
    </div>
    <p class="small muted" style="margin:8px 0 0">${useTariff ? `Your tariff (${esc(productFromCode(settings.gasTariff))}): currently` : 'At'} ${pence(unit)}/kWh and ${pence(sc)}/day standing charge${settings.gasKwh ? '' : `; m³ converted with volume correction ${settings.volumeCorrection} and calorific value ${settings.calorificValue}`}.</p>`;

  const gasEl = document.getElementById('gas-days');
  const list = results.slice().reverse();
  gasEl.innerHTML = list.map((r, i) => `<section class="card" data-i="${i}">
      <div class="day-head"><h3>${fmtDayLong.format(r.date)}</h3>
      <span class="totals"><b class="go">${pounds(r.cost)}</b> · ${kwh(r.total)}</span></div>
      <div class="chart-box" style="height:200px"><canvas></canvas></div></section>`).join('');
  const io = new IntersectionObserver(entries => entries.forEach(e => {
    if (!e.isIntersecting || e.target.dataset.drawn) return;
    e.target.dataset.drawn = '1';
    const r = list[+e.target.dataset.i];
    const o = baseChartOptions();
    o.plugins.legend.display = false;
    o.scales.y.title = { display: true, text: 'kWh', color: css('--muted') };
    o.plugins.tooltip = { callbacks: { label: c => ` ${c.parsed.y.toFixed(3)} kWh · ${pence(c.parsed.y * r.slots[c.dataIndex].p)}` } };
    charts.add(new Chart(e.target.querySelector('canvas'), {
      type: 'bar',
      data: { labels: r.slots.map(s => hhmm(s.t)),
        datasets: [{ data: r.slots.map(s => s.kwh), backgroundColor: css('--go'), barPercentage: 1, categoryPercentage: 0.9 }] },
      options: o,
    }));
  }), { rootMargin: '400px' });
  gasEl.querySelectorAll('section').forEach(s => io.observe(s));
  observers.push(io);
}

/* ---- Settings ---- */
function field(key, label, type = 'text', extra = {}) {
  const v = settings[key];
  const hint = extra.hint ? `<small>${extra.hint}</small>` : '';
  const dep = extra.dep ? ` data-dep="${extra.dep}"` : '';
  let input;
  if (type === 'checkbox') input = `<input type="checkbox" name="${key}" ${v ? 'checked' : ''}>`;
  else if (type === 'select') {
    input = `<select name="${key}">${extra.options.map(([val, text]) =>
      `<option value="${esc(val)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select>`;
  } else {
    input = `<input type="${type}" name="${key}" value="${esc(v ?? '')}" ${type === 'number' ? 'step="any"' : ''}
      ${extra.placeholder ? `placeholder="${esc(extra.placeholder)}"` : ''} autocomplete="off" spellcheck="false">`;
  }
  return `<label class="field"${dep}><span>${label}${hint}</span>${input}</label>`;
}

function section(id, title, summary, body, open) {
  return `<details class="group" data-group="${id}" ${open ? 'open' : ''}>
    <summary><span class="g-title">${title}</span><span class="g-sub">${summary}</span></summary>
    <div class="g-body">${body}</div></details>`;
}

function regionName(code) { const r = REGIONS.find(([c]) => c === code); return r ? `${r[1]} (${code})` : '—'; }

function connectedSummary() {
  const c = settings.connected;
  if (!c) return '';
  const row = (k, v) => (v ? `<div class="kv"><span>${k}</span><b>${esc(v)}</b></div>` : '');
  return `<div class="connected">
    <div class="ok">✓ Connected to ${esc(c.account)}${c.address ? ` · ${esc(c.address)}` : ''}</div>
    ${row('Electricity', `${c.mpan}${c.elecTariff ? ' · ' + c.elecTariff : ''}`)}
    ${row('Region', regionName(c.region))}
    ${row('Export', c.exportMpan ? `${c.exportMpan}${c.exportTariff ? ' · ' + c.exportTariff : ''}` : '')}
    ${row('Gas', c.mprn ? `${c.mprn}${c.gasTariff ? ' · ' + c.gasTariff : ''}` : '')}
  </div>`;
}

function renderSettings() {
  setPeriodNav(false);
  const hours = new Set(settings.timeshiftHours || ALL_HOURS);
  const openGroups = new Set(store.get('ga:openGroups', []));
  const ready = isConfigured();
  const status = ready
    ? `MPAN ${esc(settings.mpan)} · ${esc(regionName(settings.region))}`
    : 'Not set up yet';

  view().innerHTML = `<form class="settings" id="settings-form" autocomplete="off">
    <section class="card setup">
      <h2>Your Octopus account</h2>
      <p class="small muted" style="margin:0 0 10px">Just two things — everything else (meters, region, tariffs, export and gas) is looked up for you.
        Both are on your <a href="https://octopus.energy/dashboard/new/accounts/personal-details/api-access" target="_blank" rel="noopener">Octopus API access page</a>.</p>
      ${field('apiKey', 'API key', 'password', { placeholder: 'sk_live_…' })}
      ${field('accountNumber', 'Account number', 'text', { placeholder: 'A-1B2C3D4E' })}
      <div class="row" style="padding:6px 0 0">
        <button type="button" class="btn" id="connect">${settings.connected ? 'Refresh from account' : 'Connect'}</button>
        <span id="connect-status" class="small muted" role="status"></span>
      </div>
      <div id="connected">${connectedSummary()}</div>
      <p class="small muted" style="margin:10px 0 0">Stored only in this browser and sent only to api.octopus.energy.</p>
    </section>

    ${section('manual', 'Meter details', esc(status), `
      <p class="small muted" style="margin:0 0 6px">Filled in automatically when you connect. Edit only if something's wrong.</p>
      ${field('mpan', 'Import MPAN', 'text', { placeholder: '13-digit number' })}
      ${field('serial', 'Meter serial')}
      ${field('region', 'Region', 'select', { options: [['', 'Select…'], ...REGIONS.map(([c, n]) => [c, `${n} (${c})`])] })}
      <div class="row" style="padding:4px 0 8px"><button type="button" class="btn secondary" id="detect-region">Detect region from MPAN</button></div>
      ${field('exportEnabled', 'Export meter', 'checkbox', { hint: 'Adds an Export switch to History' })}
      ${field('exportMpan', 'Export MPAN', 'text', { dep: 'exportEnabled' })}
      ${field('exportSerial', 'Export meter serial', 'text', { dep: 'exportEnabled', hint: 'Blank = same as import' })}
      ${field('gas', 'Gas meter', 'checkbox')}
      ${field('mprn', 'MPRN', 'text', { dep: 'gas' })}
      ${field('gasSerial', 'Gas meter serial', 'text', { dep: 'gas' })}
    `, openGroups.has('manual'))}

    ${section('compare', 'Comparison', `Billing starts day ${esc(settings.startDay)}${settings.smartTariff ? ' · warnings on' : ''}`, `
      ${field('startDay', 'Billing start day', 'number', { hint: 'Day of the month your bill starts (1–28)' })}
      ${field('smartTariff', 'Warn on dearer days', 'checkbox', { hint: 'Highlight days where the other tariff would have been cheaper' })}
      ${field('currentTariff', "Tariff you're on", 'select', { dep: 'smartTariff', options: [['go', 'Go'], ['agile', 'Agile']] })}
      ${field('highlightBorder', 'Highlight with border', 'checkbox', { dep: 'smartTariff', hint: 'Off = shaded background' })}
      ${field('showAverage', 'Show average unit rates', 'checkbox', { hint: "Agile's average price vs the average you actually paid" })}
      ${field('exportFixed', 'Fixed export price (p/kWh)', 'number', { dep: 'exportEnabled', hint: 'Compared against Agile Outgoing' })}
    `, openGroups.has('compare'))}

    ${section('home', 'Price list', [settings.showPriceNow && 'from now', settings.showDayAverage && 'avg/min/max', settings.highlightPrices && 'shaded'].filter(Boolean).join(' · ') || 'all prices', `
      ${field('showPriceNow', 'Only current & future prices', 'checkbox')}
      ${field('showDayAverage', 'Show avg / min / max', 'checkbox')}
      ${field('avgDay', 'For', 'select', { dep: 'showDayAverage', options: [['today', 'Today'], ['tomorrow', 'Tomorrow']] })}
      ${field('highlightPrices', 'Colour prices', 'checkbox', { hint: 'Green below the low threshold, red above the high one' })}
      ${field('lowThreshold', 'Low threshold (p)', 'number', { dep: 'highlightPrices' })}
      ${field('highThreshold', 'High threshold (p)', 'number', { dep: 'highlightPrices' })}
    `, openGroups.has('home'))}

    ${section('shift', 'Load shift', settings.timeshift ? 'on' : 'off', `
      <p class="small muted" style="margin:0 0 6px">Estimates your Go cost if big loads (like a car or immersion heater) had run in the cheap window. Tap a day's graph to toggle.</p>
      ${field('timeshift', 'Enable load shift', 'checkbox')}
      ${field('loadThreshold', 'Shift half-hours above (kWh)', 'number', { dep: 'timeshift' })}
      ${field('baseload', 'Baseload left behind (kWh)', 'number', { dep: 'timeshift' })}
      ${field('timeshiftAll', 'Show shifted on all days', 'checkbox', { dep: 'timeshift' })}
      <div class="field" data-dep="timeshift"><span>Hours that can be shifted<small><a href="#" id="hours-all">All</a> · <a href="#" id="hours-none">None</a></small></span>
        <div class="hours-grid">${ALL_HOURS.map(h => `<label><input type="checkbox" name="hour" value="${h}" ${hours.has(h) ? 'checked' : ''}>${h}</label>`).join('')}</div></div>
    `, openGroups.has('shift'))}

    ${section('gasopts', 'Gas', settings.gas ? (settings.gasTariff ? 'rates from your tariff' : 'manual rates') : 'off', `
      <p class="small muted" data-dep-off="gas" style="margin:0">No gas meter set up. Connect your account, or turn on "Gas meter" under Meter details.</p>
      ${field('gasKwh', 'Meter reports kWh', 'checkbox', { dep: 'gas', hint: 'Usually on for SMETS1 meters, off for SMETS2 (m³). If gas use looks ~11× too low or high, flip this.' })}
      ${settings.gasTariff ? `<p class="small muted">Unit rate and standing charge come from your tariff (${esc(productFromCode(settings.gasTariff))}). The values below are only used if that lookup fails.</p>` : ''}
      ${field('gasUnitRate', 'Unit rate (p/kWh)', 'number', { dep: 'gas' })}
      ${field('gasStanding', 'Standing charge (p/day)', 'number', { dep: 'gas' })}
      ${field('volumeCorrection', 'Volume correction', 'number', { dep: 'gas' })}
      ${field('calorificValue', 'Calorific value', 'number', { dep: 'gas' })}
    `, openGroups.has('gasopts'))}

    ${section('advanced', 'Advanced', esc(`${settings.agileProduct} vs ${settings.goProduct}`), `
      <p class="small muted" style="margin:0 0 6px">The Octopus products being compared. Your own tariff is picked up when you connect.</p>
      ${field('agileProduct', 'Agile product')}
      ${field('goProduct', 'Go product')}
      ${field('exportProduct', 'Agile Outgoing product', 'text', { dep: 'exportEnabled' })}
      <div class="row" style="padding:4px 0"><button type="button" class="btn secondary" id="detect-products">Use latest Octopus products</button></div>
      ${field('theme', 'Theme', 'select', { options: [['system', 'Match system'], ['light', 'Light'], ['dark', 'Dark']] })}
      <div class="row" style="padding:6px 0">
        <button type="button" class="btn secondary" id="clear-cache">Clear cached data</button>
        <button type="button" class="btn secondary" id="forget">Forget my details</button>
      </div>
    `, openGroups.has('advanced'))}
    <p class="small muted">Changes save automatically.</p>
  </form>`;

  const form = document.getElementById('settings-form');
  const syncDeps = () => form.querySelectorAll('[data-dep]').forEach(f => {
    const on = !!settings[f.dataset.dep];
    f.classList.toggle('disabled', !on);
    f.querySelectorAll('input,select').forEach(i => { i.disabled = !on; });
  }) || form.querySelectorAll('[data-dep-off]').forEach(p => { p.hidden = !!settings[p.dataset.depOff]; });
  syncDeps();

  form.querySelectorAll('details.group').forEach(d => d.addEventListener('toggle', () => {
    const open = [...form.querySelectorAll('details.group[open]')].map(x => x.dataset.group);
    store.set('ga:openGroups', open);
  }));

  form.addEventListener('input', e => {
    const t = e.target;
    if (t.name === 'hour') {
      settings.timeshiftHours = [...form.querySelectorAll('input[name=hour]:checked')].map(i => i.value);
    } else if (t.name) {
      const v = t.type === 'checkbox' ? t.checked : t.value.trim();
      settings[t.name] = t.type === 'number' ? (v === '' ? DEFAULTS[t.name] : num(v, DEFAULTS[t.name])) : v;
      if (t.name === 'startDay') settings.startDay = Math.min(28, Math.max(1, Math.round(settings.startDay)));
      if (['region', 'agileProduct', 'goProduct', 'exportProduct', 'mpan', 'serial'].includes(t.name)) historyOffset = 0;
    }
    saveSettings();
    syncDeps();
  });
  form.addEventListener('submit', e => e.preventDefault());

  const setHours = all => {
    form.querySelectorAll('input[name=hour]').forEach(i => { i.checked = all; });
    settings.timeshiftHours = all ? ALL_HOURS.slice() : [];
    saveSettings();
  };
  document.getElementById('hours-all').onclick = e => { e.preventDefault(); setHours(true); };
  document.getElementById('hours-none').onclick = e => { e.preventDefault(); setHours(false); };

  document.getElementById('connect').onclick = async () => {
    const btn = document.getElementById('connect');
    const st = document.getElementById('connect-status');
    btn.disabled = true;
    st.textContent = 'Looking up your account…';
    try {
      await connectAccount();
      renderSettings();
      document.getElementById('connect-status').textContent = 'Done — your meters and tariffs are set up.';
    } catch (e) {
      st.textContent = e.message;
      btn.disabled = false;
    }
  };

  document.getElementById('clear-cache').onclick = () => { store.clearCache(); toast('Cached data cleared.'); };
  document.getElementById('forget').onclick = () => {
    settings = Object.assign({}, DEFAULTS, { theme: settings.theme });
    store.clearCache();
    saveSettings();
    renderSettings();
    toast('Your details have been removed from this browser.');
  };

  document.getElementById('detect-region').onclick = async () => {
    if (!settings.mpan) { toast('Enter your MPAN first.'); return; }
    try {
      const j = await fetchJson(`${API}/electricity-meter-points/${encodeURIComponent(settings.mpan)}/`, false);
      const r = (j.gsp || '').replace('_', '');
      if (!REGIONS.some(([c]) => c === r)) throw new Error('No region returned for that MPAN.');
      settings.region = r;
      saveSettings();
      form.querySelector('select[name=region]').value = r;
      toast(`Region set to ${regionName(r)}.`);
    } catch (e) { toast(e.message); }
  };

  document.getElementById('detect-products').onclick = async () => {
    try {
      const all = await fetchAll(`${API}/products/?brand=OCTOPUS_ENERGY&is_variable=true&page_size=100`, false);
      const pick = re => all.filter(p => re.test(p.code)).sort((a, b) => b.available_from.localeCompare(a.available_from))[0];
      const agile = pick(/^AGILE-\d/), go = pick(/^GO-VAR-/) || pick(/^GO-/), out = pick(/^AGILE-OUTGOING-/);
      if (agile) settings.agileProduct = agile.code;
      if (go) settings.goProduct = go.code;
      if (out) settings.exportProduct = out.code;
      saveSettings();
      ['agileProduct', 'goProduct', 'exportProduct'].forEach(k => { form.querySelector(`[name=${k}]`).value = settings[k]; });
      toast(`Using ${settings.agileProduct} and ${settings.goProduct}.`);
    } catch (e) { toast(e.message); }
  };
}

/* ---- About ---- */
function renderAbout() {
  setPeriodNav(false);
  view().innerHTML = `<section class="card">
    <h2>About Octopus Go Agile</h2>
    <p>Compare what your electricity would cost on Octopus <b>Agile</b> (half-hourly prices) versus Octopus <b>Go</b>
      (a cheap overnight window), using your real smart meter readings.</p>
    <h3>Pages</h3>
    <ul>
      <li><b>Home</b> — today's and tomorrow's Agile prices, with the current half-hour highlighted, plus yesterday's Agile vs Go comparison.</li>
      <li><b>History</b> — each day in your billing period: usage bars, the Agile price (purple) and Go price (orange), with the cost of each.
        The summary at the top totals the whole period, standing charges included. Turn on Export in Settings to compare Agile Outgoing with a fixed export price.</li>
      <li><b>Gas</b> — half-hourly gas usage and cost from your gas smart meter.</li>
    </ul>
    <h3>Reading the graphs</h3>
    <div class="legend">
      <span><i style="background:var(--bar)"></i>Usage</span>
      <span><i style="background:var(--bar-neg)"></i>Usage at a negative Agile price</span>
      <span><i style="background:var(--bar-shift)"></i>Load-shifted usage</span>
      <span><i style="background:var(--agile)"></i>Agile price</span>
      <span><i style="background:var(--go)"></i>Go price</span>
    </div>
    <p><b>Load shift</b> estimates your Go cost if your biggest loads (above the threshold, in the hours you pick) had been moved
      into the cheap Go window, leaving the baseload behind. Tap a day's graph to switch between actual and shifted.</p>
    <p><b>Daily average unit rates</b> compare Agile's plain average price for the day with the average you actually paid — if yours is lower,
      you're using more power in cheaper half-hours.</p>
    <h3>Privacy</h3>
    <p>Your API key and meter details are stored only in this browser (localStorage) and sent only to
      <code>api.octopus.energy</code>. Readings are cached locally to keep things fast; clear them from Settings.</p>
    <p class="small muted">Web version of the Android app
      <a href="https://github.com/bucketybuckbuck/android" target="_blank" rel="noopener">bucketybuckbuck/android</a>.
      Not affiliated with Octopus Energy.</p>
  </section>`;
}

/* ---------------- router ---------------- */
const VIEWS = { home: renderHome, history: renderHistory, gas: renderGas, settings: renderSettings, about: renderAbout };

function route() {
  const name = (location.hash.slice(1) || 'home').split('?')[0];
  const fn = VIEWS[name] || renderHome;
  destroyCharts();
  observers.splice(0).forEach(o => o.disconnect());
  document.querySelectorAll('.bottom-nav a').forEach(a => a.classList.toggle('active', a.dataset.view === (VIEWS[name] ? name : 'home')));
  const token = ++renderToken;
  window.scrollTo(0, 0);
  Promise.resolve(fn(token)).catch(e => { console.error(e); view().innerHTML = errorBox(e); });
}

document.getElementById('prev').onclick = () => { historyOffset--; route(); };
document.getElementById('next').onclick = () => { if (historyOffset < 0) { historyOffset++; route(); } };
document.getElementById('export-switch').onchange = e => { exportMode = e.target.checked; route(); };
window.addEventListener('hashchange', route);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (settings.theme === 'system') route(); });
route();
