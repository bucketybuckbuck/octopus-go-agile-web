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
  apiKey: '', accountNumber: '', connected: null, mpan: '', serial: '', region: '',
  elecTariff: '', exportTariff: '', gasTariff: '',
  elecAgreements: [], exportAgreements: [], gasAgreements: [],
  exportEnabled: false, exportMpan: '', exportSerial: '', exportFixed: 15,
  agileProduct: 'AGILE-24-10-01', goProduct: 'GO-VAR-22-10-14', exportProduct: 'AGILE-OUTGOING-19-05-13',
  smartTariff: false, currentTariff: 'go', highlightBorder: false, showAverage: false, startDay: 1,
  showPriceNow: true, showDayAverage: true, avgDay: 'today',
  highlightPrices: true, autoThresholds: true, highThreshold: 30, lowThreshold: 15,
  timeshift: false, timeshiftHours: ALL_HOURS.slice(), baseload: 0.1, loadThreshold: 1.0, timeshiftAll: false,
  gas: false, mprn: '', gasSerial: '', gasStanding: 30, gasUnitRate: 6, gasUnit: 'auto', gasDetectedUnit: '',
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
// v2: price list options on by default, with automatic thresholds.
if ((settings.version || 1) < 2) {
  Object.assign(settings, { version: 2, showPriceNow: true, showDayAverage: true, highlightPrices: true, autoThresholds: true });
  store.set('ga:settings', settings);
}
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
function agreementList(ags) {
  return (ags || []).filter(a => a.tariff_code).map(a => ({
    code: a.tariff_code,
    from: Date.parse(a.valid_from),
    to: a.valid_to ? Date.parse(a.valid_to) : Infinity,
  })).sort((a, b) => a.from - b.from);
}
/** The tariff you were on at time t (from your account's agreement history). */
function agreementAt(list, t) {
  for (let i = (list || []).length - 1; i >= 0; i--) if (list[i].from <= t && t < list[i].to) return list[i].code;
  return null;
}

/**
 * Work out whether the gas meter reports m³ or kWh: compare a year of readings with Octopus's
 * own annual estimate for the meter (in kWh). kWh meters come out near 1×, m³ meters near 1/11×.
 */
async function detectGasUnit(mprn, serial, annualKwh) {
  const eac = parseFloat(annualKwh);
  if (!mprn || !serial || !(eac > 0)) return '';
  const from = Date.now() - 365 * DAY;
  try {
    const j = await fetchJson(`${API}/gas-meter-points/${encodeURIComponent(mprn)}/meters/${encodeURIComponent(serial)}/consumption/` +
      `?period_from=${iso(from)}&group_by=day&page_size=400`, true);
    const rows = j.results || [];
    if (rows.length < 14) return '';
    const total = rows.reduce((a, r) => a + r.consumption, 0);
    const ratio = (total * 365 / rows.length) / eac;
    return ratio > 0.3 ? 'kwh' : 'm3';
  } catch { return ''; }
}

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
    settings.elecTariff = ag ? ag.tariff_code : '';
    settings.elecAgreements = agreementList(imp.agreements);
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
    settings.exportTariff = ag ? ag.tariff_code : '';
    settings.exportAgreements = agreementList(exp.agreements);
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
    settings.exportTariff = '';
    settings.exportAgreements = [];
  }
  const gas = (prop.gas_meter_points || [])[0];
  if (gas) {
    settings.gas = true;
    settings.mprn = gas.mprn;
    settings.gasSerial = await pickSerial('gas', gas.mprn, gas.meters);
    const ag = currentAgreement(gas.agreements);
    settings.gasTariff = ag ? ag.tariff_code : '';
    settings.gasAgreements = agreementList(gas.agreements);
    if (ag) summary.gasTariff = await productName(productFromCode(ag.tariff_code));
    settings.gasDetectedUnit = await detectGasUnit(gas.mprn, settings.gasSerial, gas.consumption_standard);
  } else {
    settings.gas = false;
    settings.gasTariff = '';
    settings.gasAgreements = [];
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
  const hasDD = results.some(r => r.payment_method === 'DIRECT_DEBIT');
  return results.filter(r => !hasDD || r.payment_method === 'DIRECT_DEBIT' || r.payment_method == null).map(r => ({
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
 * Build half-hour items for one day and total up the costs on Agile, Go and the tariff you
 * were actually on. `tb` holds per-tariff rate bands (see tariffBands) for that day.
 * Mirrors ChartWrapper.calculateCombinedData / CostSummary from the Android app,
 * but takes every rate from the API instead of hard-coded windows.
 */
function computeDay(slots, tb, opts) {
  const isExport = !!opts.isExport;
  const dayStart = midnight(new Date(slots[0] ? slots[0].t : Date.now())).getTime();
  const fixedExport = num(settings.exportFixed, 15);
  const items = slots.map(s => ({
    t: s.t,
    kwh: s.kwh,
    agile: rateFor(tb.agile, s.t),
    go: isExport ? fixedExport : rateFor(tb.go, s.t),
    mine: tb.actual ? rateFor(tb.actual, s.t) : null,
    goKwh: s.kwh,
    shifted: false,
    shiftSource: false,
  }));

  if (opts.shift && !isExport) applyLoadShift(items);

  let agileCost = 0, goCost = 0, mineCost = 0, total = 0, agileRateSum = 0, agileRateN = 0;
  for (const it of items) {
    total += it.kwh;
    if (it.agile != null) { agileCost += it.kwh * it.agile; agileRateSum += it.agile; agileRateN++; }
    if (it.go != null) goCost += it.goKwh * it.go;
    if (it.mine != null) mineCost += it.kwh * it.mine;
  }
  const energyAgile = agileCost, energyGo = goCost, energyMine = mineCost;
  if (!isExport) {
    agileCost += standingFor(tb.agile, dayStart);
    goCost += standingFor(tb.go, dayStart);
    if (tb.actual) mineCost += standingFor(tb.actual, dayStart);
  }
  return {
    items, total, agileCost, goCost,
    mineCost: tb.actual ? mineCost : null,
    mineName: tb.actualName || null,
    mineKind: tb.actualKind || null,
    mineCode: tb.actual ? tb.actual.code : null,
    agileCode: tb.agile ? tb.agile.code : null,
    goCode: tb.go ? tb.go.code : null,
    mineApprox: !!(tb.actual && tb.actual.twoRate),
    agileAvg: agileRateN ? agileRateSum / agileRateN : null,
    actualAvg: total ? (tb.actual ? energyMine : energyAgile) / total : null,
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
/** Cached single-object fetch (product details, product lists). Past lookups are kept. */
async function cachedJson(url, keep) {
  const key = 'ga:c:json:' + url;
  const hit = store.get(key, null);
  if (hit && (keep || Date.now() - hit.t < DAY)) return hit.d;
  const d = await fetchJson(url, false);
  store.set(key, { t: Date.now(), d });
  return d;
}

const nameCache = new Map();
async function productDisplayName(code) {
  const p = productFromCode(code);
  if (!nameCache.has(p)) {
    nameCache.set(p, cachedJson(`${API}/products/${p}/`, true).then(j => j.display_name || p).catch(() => p));
  }
  let name = await nameCache.get(p);
  if (/^E-2R-/.test(code)) name += ' (Economy 7)';
  return name;
}

/** Which Agile / Go product versions were on sale around these dates. */
const VERSION_RE = { agile: /^AGILE-(FLEX-)?\d/, go: /^GO-(VAR-)?\d/ };
async function productsAt(t) {
  const noon = midnight(new Date(t)).getTime() + 12 * 3600e3;
  const url = `${API}/products/?brand=OCTOPUS_ENERGY&available_at=${iso(noon)}&page_size=200`;
  const j = await cachedJson(url, noon < Date.now() - 2 * DAY).catch(() => ({ results: [] }));
  return j.results || [];
}
async function versionsFor(kind, days) {
  const found = new Map();
  const samples = [days[0], days[days.length - 1]].filter(Boolean).map(d => d.getTime());
  for (const s of samples) {
    // Between versions there can be a gap with nothing on sale — step back until one turns up.
    for (let back = 0, t = s; back < 12; back++, t -= 30 * DAY) {
      const hits = (await productsAt(t)).filter(p => VERSION_RE[kind].test(p.code));
      hits.forEach(p => found.set(p.code, Date.parse(p.available_from)));
      if (hits.length) break;
    }
  }
  return [...found].map(([code, from]) => ({ code, from })).sort((a, b) => a.from - b.from);
}
function versionAt(list, t) {
  if (!list || !list.length) return null;
  let pick = list[0].code;
  for (const v of list) if (v.from <= t) pick = v.code;
  return pick;
}

/** Unit rates (day/night for Economy 7) and standing charges for one full tariff code. */
async function tariffBands(code, from, to) {
  const fuel = code.startsWith('G-') ? 'gas-tariffs' : 'electricity-tariffs';
  const base = `${API}/products/${productFromCode(code)}/${fuel}/${code}`;
  const range = `?period_from=${iso(from)}&period_to=${iso(to)}&page_size=1500`;
  const twoRate = /^E-2R-/.test(code);
  const isExportTariff = /OUTGOING|EXPORT/.test(code);
  const [u, n, sc] = await Promise.all([
    cachedAll('rates', `${base}/${twoRate ? 'day-unit-rates' : 'standard-unit-rates'}/${range}`, false, to),
    twoRate ? cachedAll('rates', `${base}/night-unit-rates/${range}`, false, to) : Promise.resolve([]),
    isExportTariff ? Promise.resolve([]) : cachedAll('sc', `${base}/standing-charges/`, false),
  ]);
  return { code, twoRate, unit: toBands(u), night: toBands(n), sc: toBands(sc) };
}
/** Economy 7 night hours vary by meter; 00:30–07:30 GMT is the most common, so it's used as an estimate. */
function isE7Night(t) { const d = new Date(t); const m = d.getUTCHours() * 60 + d.getUTCMinutes(); return m >= 30 && m < 450; }
function rateFor(tb, t) {
  if (!tb) return null;
  if (tb.twoRate && isE7Night(t)) return rateAt(tb.night, t);
  return rateAt(tb.unit, t);
}
function standingFor(tb, t) { return tb ? rateAt(tb.sc, t) || 0 : 0; }

/**
 * Load readings for [from, to) plus, for every day, the rates for:
 *  - the tariff you were actually on that day (from your account's agreement history),
 *  - Agile and Go — your own version if you were on it, otherwise the version on sale that day.
 */
async function loadPeriod(from, to, days, isExport) {
  const cappedTo = Math.min(to, midnight(addDays(new Date(), 1)).getTime());
  const mpan = isExport ? settings.exportMpan : settings.mpan;
  const serial = isExport ? (settings.exportSerial || settings.serial) : settings.serial;
  const agreements = isExport ? settings.exportAgreements : settings.elecAgreements;
  const region = settings.region;

  const [cons, agileVersions, goVersions] = await Promise.all([
    cachedAll('cons', consumptionUrl('elec', mpan, serial, from, cappedTo), true, cappedTo),
    isExport ? Promise.resolve([]) : versionsFor('agile', days),
    isExport ? Promise.resolve([]) : versionsFor('go', days),
  ]);

  const plan = days.map(d => {
    const noon = d.getTime() + 12 * 3600e3;
    const actual = agreementAt(agreements, noon);
    const kind = actual ? tariffKind(productFromCode(actual)) : null;
    let agile, go = null;
    if (isExport) {
      agile = kind === 'agile-export' ? actual : tariffCode(settings.exportProduct, region);
    } else {
      agile = kind === 'agile' ? actual : tariffCode(versionAt(agileVersions, noon) || settings.agileProduct, region);
      go = kind === 'go' ? actual : tariffCode(versionAt(goVersions, noon) || settings.goProduct, region);
    }
    return { day: d.getTime(), actual, kind, agile, go };
  });

  const codes = [...new Set(plan.flatMap(p => [p.actual, p.agile, p.go]).filter(Boolean))];
  const bands = new Map();
  const names = new Map();
  await Promise.all(codes.map(async c => {
    bands.set(c, await tariffBands(c, from, cappedTo).catch(() => null));
    names.set(c, await productDisplayName(c));
  }));

  const perDay = new Map(plan.map(p => [p.day, {
    agile: bands.get(p.agile),
    go: p.go ? bands.get(p.go) : null,
    actual: p.actual ? bands.get(p.actual) : null,
    actualKind: p.kind,
    actualName: p.actual ? names.get(p.actual) : null,
    agileName: names.get(p.agile),
    goName: p.go ? names.get(p.go) : null,
  }]));
  return {
    slots: cons.map(c => ({ t: Date.parse(c.interval_start), kwh: c.consumption })).sort((a, b) => a.t - b.t),
    perDay,
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
        ...(day.mineCost != null && !mineColumn(day, isExport) ? [{ type: 'line', label: (day.mineName || 'Yours') + ' ' + pounds(day.mineCost), data: items.map(i => i.mine), yAxisID: 'y1', stepped: 'middle',
          borderColor: css('--mine'), borderWidth: 1.5, borderDash: [4, 3], pointRadius: 0, order: 0 }] : []),
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
    Your account number is under your name on your <a href="https://octopus.energy/dashboard/new/accounts" target="_blank" rel="noopener">Octopus account home page</a>;
    your API key is on the <a href="https://octopus.energy/dashboard/new/accounts/personal-details/api-access" target="_blank" rel="noopener">API access page</a>.</p>
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

/**
 * Automatic price-list thresholds: over the last week of Agile prices (plus today/tomorrow),
 * the cheapest quarter of half-hours counts as "low" and the most expensive quarter as "high".
 */
async function updateAutoThresholds(upcoming) {
  const today = midnight(new Date()).getTime();
  const from = addDays(new Date(today), -7).getTime();
  let past = [];
  try { past = await cachedAll('rates', ratesUrl(settings.agileProduct, from, today), false, today); } catch { /* use what we have */ }
  const ps = past.map(r => r.value_inc_vat).concat(upcoming.map(x => x.p)).sort((a, b) => a - b);
  if (ps.length < 48) return;
  const q = f => ps[Math.min(ps.length - 1, Math.floor(f * ps.length))];
  const round = v => Math.round(v * 2) / 2;
  const low = round(q(0.25)), high = Math.max(low + 0.5, round(q(0.75)));
  if (low !== settings.lowThreshold || high !== settings.highThreshold) {
    settings.lowThreshold = low;
    settings.highThreshold = high;
    saveSettings();
  }
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
    <div id="install-slot"></div>
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
    if (settings.highlightPrices && settings.autoThresholds) {
      await updateAutoThresholds(prices);
      if (token !== renderToken) return;
    }
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
    const data = await loadPeriod(yStart.getTime(), today.getTime(), [yStart], false);
    if (token !== renderToken) return;
    if (data.slots.length < 3) {
      body.textContent = "Yesterday's smart meter readings haven't arrived yet — Octopus usually publishes them within a day.";
      return;
    }
    const day = computeDay(data.slots, data.perDay.get(yStart.getTime()), { shift: settings.timeshift && settings.timeshiftAll });
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
  let shown = prices.slice(); // in time order, earliest first
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
/** Is the tariff you were on one of the two columns already shown (Agile / Go)? */
function mineColumn(day, isExport) {
  if (day.mineCost == null) return null;
  if (isExport) return day.mineKind === 'agile-export' ? 'agile' : null;
  return day.mineKind === 'agile' ? 'agile' : day.mineKind === 'go' ? 'go' : null;
}

function signedDiff(alt, paid, isExport) {
  // Positive = the alternative would have been better for you.
  const better = isExport ? alt - paid : paid - alt;
  if (Math.abs(better) < 0.5) return '<span class="muted">about the same</span>';
  return `<span class="${better > 0 ? 'cheaper' : 'pricier'}">${pounds(Math.abs(better))} ${isExport ? (better > 0 ? 'more' : 'less') : (better > 0 ? 'cheaper' : 'more expensive')}</span>`;
}

function dayCardInner(day, date, isExport, switched, current) {
  const a = isExport ? 'Agile Outgoing' : 'Agile';
  const g = isExport ? 'Fixed' : 'Go';
  const col = mineColumn(day, isExport);
  const tag = k => (col === k ? ' <span class="yours">yours</span>' : '');
  const mine = day.mineCost != null && !col
    ? `<b class="mine">${isExport ? 'You earned' : 'You paid'} ${pounds(day.mineCost)}</b> <span class="muted">(${esc(day.mineName || 'your tariff')}${day.mineApprox ? ', approx.' : ''})</span> · `
    : '';
  let avg = '';
  if (settings.showAverage && day.total > 0) {
    avg = `<div class="small muted">Agile avg rate ${pence(day.agileAvg)} · your avg ${pence(day.actualAvg)} · ${g} avg ${pence(day.goAvg)}</div>`;
  }
  // Only mention tariff versions when they differ from today's, so ordinary days stay uncluttered.
  const notes = [];
  if (current && day.mineCode && day.mineCode !== current.mine) {
    notes.push(`Your tariff then: <b>${esc(day.mineName || productFromCode(day.mineCode))}</b> (${esc(productFromCode(day.mineCode))})`);
  }
  if (current) {
    const cmp = [];
    if (day.agileCode && day.agileCode !== day.mineCode && productFromCode(day.agileCode) !== current.agile) cmp.push(`${a} ${esc(productFromCode(day.agileCode))}`);
    if (day.goCode && day.goCode !== day.mineCode && productFromCode(day.goCode) !== current.go) cmp.push(`Go ${esc(productFromCode(day.goCode))}`);
    if (cmp.length) notes.push(`Compared with ${cmp.join(', ')} — the version${cmp.length > 1 ? 's' : ''} on sale then`);
  }
  const versionNote = notes.length ? `<div class="small muted tariff-note">${notes.join('<br>')}</div>` : '';
  return `${switched ? `<div class="switch-tag">Switched to ${esc(switched)}</div>` : ''}<div class="day-head">
      <span class="totals">${mine}<b class="agile">${a} ${pounds(day.agileCost)}</b>${tag('agile')} · <b class="go">${g} ${pounds(day.goCost)}</b>${tag('go')} · ${kwh(day.total)}</span>
    </div>${versionNote}${avg}`;
}

/** Warning highlight: flag days where Agile or Go would have beaten the tariff you were on. */
function paintWarn(card, day, isExport) {
  card.classList.remove('warn', 'warn-border');
  if (!settings.smartTariff || isExport || !day.total) return;
  let bad;
  if (day.mineCost != null) {
    const alts = [];
    if (day.mineKind !== 'agile') alts.push(day.agileCost);
    if (day.mineKind !== 'go') alts.push(day.goCost);
    bad = alts.length && Math.min(...alts) < day.mineCost - 0.5;
  } else {
    const onGo = settings.currentTariff === 'go';
    bad = onGo ? day.agileCost < day.goCost : day.goCost < day.agileCost;
  }
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
    data = await loadPeriod(period.start.getTime(), period.end.getTime(), days, isExport);
  } catch (e) {
    if (token !== renderToken) return;
    el.innerHTML = errorBox(e);
    return;
  }
  if (token !== renderToken) return;

  const byDay = splitByDay(data.slots, days);
  const shiftAll = settings.timeshift && settings.timeshiftAll;
  const todayArr = [midnight(new Date())];
  const [agileNow, goNow] = isExport ? [[], []] : await Promise.all([versionsFor('agile', todayArr), versionsFor('go', todayArr)]);
  if (token !== renderToken) return;
  const current = {
    mine: (isExport ? settings.exportTariff : settings.elecTariff) || null,
    agile: isExport ? settings.exportProduct : (versionAt(agileNow, Date.now()) || settings.agileProduct),
    go: isExport ? null : (versionAt(goNow, Date.now()) || settings.goProduct),
  };
  const results = [];
  let prevCode = null;
  for (const d of days) {
    const slots = byDay.get(d.getTime()) || [];
    const tb = data.perDay.get(d.getTime());
    const code = tb && tb.actual ? tb.actual.code : null;
    const switched = prevCode && code && code !== prevCode ? tb.actualName : null;
    if (code) prevCode = code;
    if (slots.length < 3 || !tb || !tb.agile) { results.push({ date: d, day: null }); continue; }
    const plain = computeDay(slots, tb, { isExport });
    const shifted = settings.timeshift && !isExport ? computeDay(slots, tb, { isExport, shift: true }) : null;
    if (shifted) shifted.anyShift = shifted.items.some(i => i.shifted);
    results.push({ date: d, day: plain, shifted, showShift: shiftAll, switched });
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
    card.querySelector('.day-body').innerHTML = dayCardInner(day, r.date, isExport, r.switched, current);
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

/** "Octopus Go (1–9 Nov), Agile Octopus (10–17 Nov)" */
function tariffTimeline(days) {
  const runs = [];
  for (const r of days) {
    const name = r.day.mineName;
    if (!name) continue;
    const last = runs[runs.length - 1];
    if (last && last.name === name) last.to = r.date; else runs.push({ name, from: r.date, to: r.date });
  }
  if (runs.length <= 1) return runs.length ? esc(runs[0].name) : '';
  return runs.map(x => `${esc(x.name)} (${fmtShort.format(x.from)}–${fmtShort.format(x.to)})`).join(', ');
}

function renderSummary(results, isExport) {
  const days = results.filter(r => r.day);
  const card = document.getElementById('summary');
  if (!days.length) {
    card.innerHTML = `<h2>${isExport ? 'Export' : 'Usage'} summary</h2><p class="muted">No readings in this period.</p>`;
    return;
  }
  const sum = (list, f) => list.reduce((a, r) => a + f(r), 0);
  const agile = sum(days, r => r.day.agileCost);
  const go = sum(days, r => r.day.goCost);
  const goShift = settings.timeshift && !isExport ? sum(days, r => (r.shifted || r.day).goCost) : null;
  const total = sum(days, r => r.day.total);
  const a = isExport ? 'Agile Outgoing' : 'Agile';
  const g = isExport ? 'Fixed export' : 'Go';

  // What you actually paid, over the days we know your tariff for.
  const known = days.filter(r => r.day.mineCost != null);
  const paid = sum(known, r => r.day.mineCost);
  const agileKnown = sum(known, r => r.day.agileCost);
  const goKnown = sum(known, r => r.day.goCost);
  const allKnown = known.length === days.length;
  const timeline = tariffTimeline(days);

  const bestAgile = isExport ? agile > go : agile < go;
  const agileRates = days.map(r => r.day.agileAvg).filter(x => x != null);
  const energyMine = sum(days, r => r.day.actualAvg != null ? r.day.actualAvg * r.day.total : 0);

  let verdict;
  if (known.length) {
    verdict = `<p class="small" style="margin:10px 0 0">${isExport ? 'Compared with what you earned' : 'Compared with what you paid'}${allKnown ? '' : ` (on the ${known.length} days your tariff is known)`}:
      <b>${a}</b> would have been ${signedDiff(agileKnown, paid, isExport)}, <b>${g}</b> ${signedDiff(goKnown, paid, isExport)}${isExport ? '' : ' — standing charges included'}.</p>`;
  } else {
    const winner = bestAgile ? a : g;
    verdict = `<p class="small" style="margin:10px 0 0"><b>${esc(winner)}</b> ${isExport ? 'paid' : 'was cheaper'} by <b>${pounds(Math.abs(agile - go))}</b> over this period${isExport ? '' : ' (standing charges included)'}.</p>`;
  }

  card.innerHTML = `
    <h2>${isExport ? 'Export' : 'Usage'} summary · ${days.length} day${days.length > 1 ? 's' : ''}</h2>
    ${timeline ? `<p class="small muted" style="margin:-4px 0 10px">Your tariff: ${timeline}</p>` : ''}
    <div class="stats">
      ${known.length ? `<div class="stat mine"><div class="label">${isExport ? 'You earned' : 'You paid'}${allKnown ? '' : ` (${known.length} days)`}</div><div class="value">${pounds(paid)}</div></div>` : ''}
      <div class="stat agile ${!known.length && bestAgile ? 'best' : ''}"><div class="label">${a}${isExport ? ' earnings' : ' cost'}</div><div class="value">${pounds(agile)}</div></div>
      <div class="stat go ${!known.length && !bestAgile ? 'best' : ''}"><div class="label">${g}${isExport ? ' earnings' : ' cost'}</div><div class="value">${pounds(go)}</div></div>
      <div class="stat"><div class="label">${isExport ? 'Exported' : 'Used'}</div><div class="value">${total.toFixed(1)} kWh</div></div>
      <div class="stat"><div class="label">Your avg rate${isExport ? '' : ' (excl. standing)'}</div><div class="value">${pence(total ? energyMine / total : null)}</div></div>
      <div class="stat"><div class="label">Agile avg unit rate</div><div class="value">${pence(agileRates.length ? agileRates.reduce((x, y) => x + y, 0) / agileRates.length : null)}</div></div>
      ${goShift != null ? `<div class="stat go"><div class="label">Go with load shift</div><div class="value">${pounds(goShift)}</div></div>` : ''}
    </div>
    ${verdict}
    <div class="chart-box" style="height:200px;margin-top:10px"><canvas id="summary-chart"></canvas></div>`;

  const o = baseChartOptions();
  o.plugins.tooltip = { callbacks: { label: c => ` ${c.dataset.label}: ${pounds(c.parsed.y * 100)}` } };
  o.scales.y.ticks.callback = v => '£' + v;
  const datasets = [];
  if (known.length) {
    datasets.push({ label: isExport ? 'You earned' : 'You paid', data: days.map(r => (r.day.mineCost != null ? r.day.mineCost / 100 : null)), backgroundColor: css('--mine') });
  }
  datasets.push(
    { label: a, data: days.map(r => r.day.agileCost / 100), backgroundColor: css('--agile') },
    { label: g, data: days.map(r => r.day.goCost / 100), backgroundColor: css('--go') },
  );
  charts.add(new Chart(document.getElementById('summary-chart'), {
    type: 'bar',
    data: { labels: days.map(r => fmtShort.format(r.date)), datasets },
    options: o,
  }));
}

/* ---- Gas ---- */
function gasTimeline(results) {
  const runs = [];
  for (const r of results) {
    if (!r.tariff) continue;
    const last = runs[runs.length - 1];
    if (last && last.name === r.tariff) last.to = r.date; else runs.push({ name: r.tariff, from: r.date, to: r.date });
  }
  if (runs.length <= 1) return runs.length ? esc(runs[0].name) : '';
  return runs.map(x => `${esc(x.name)} (${fmtShort.format(x.from)}–${fmtShort.format(x.to)})`).join(', ');
}

/** Readings arrive in m³ (most SMETS2 meters) or kWh (most SMETS1). */
function gasUnit() {
  if (settings.gasUnit === 'm3' || settings.gasUnit === 'kwh') return settings.gasUnit;
  return settings.gasDetectedUnit || 'm3';
}
/** m³ → kWh using the standard volume correction (1.02264) and a typical UK calorific value (39.4 MJ/m³). */
function gasKwh(v) {
  return gasUnit() === 'kwh' ? v : (v * 1.02264 * 39.4) / 3.6;
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
  // The gas tariff you were on each day (from your account), falling back to your current one.
  const codeFor = d => agreementAt(settings.gasAgreements, d.getTime() + 12 * 3600e3) || settings.gasTariff || null;
  const codes = [...new Set(days.map(codeFor).filter(Boolean))];
  const bands = new Map(), names = new Map();
  let cons;
  try {
    [cons] = await Promise.all([
      cachedAll('gas', consumptionUrl('gas', settings.mprn, settings.gasSerial, period.start.getTime(), to), true, to),
      ...codes.map(async c => {
        bands.set(c, await tariffBands(c, period.start.getTime(), to).catch(() => null));
        names.set(c, await productDisplayName(c));
      }),
    ]);
  } catch (e) {
    if (token !== renderToken) return;
    el.innerHTML = errorBox(e);
    return;
  }
  if (token !== renderToken) return;
  const manualUnit = num(settings.gasUnitRate, 6), manualSc = num(settings.gasStanding, 30);
  const tbAt = t => bands.get(codeFor(midnight(new Date(t))));
  const useTariff = codes.some(c => bands.get(c) && bands.get(c).unit.length);
  const unitAt = t => { const tb = tbAt(t); return (tb && rateAt(tb.unit, t)) ?? manualUnit; };
  const scAt = t => { const tb = tbAt(t); return (tb && rateAt(tb.sc, t)) ?? manualSc; };
  const slots = cons.map(c => {
    const t = Date.parse(c.interval_start);
    return { t, kwh: gasKwh(c.consumption), p: unitAt(t) };
  }).sort((a, b) => a.t - b.t);
  const byDay = splitByDay(slots, days);
  const results = days.map(d => {
    const s = byDay.get(d.getTime()) || [];
    const total = s.reduce((a, x) => a + x.kwh, 0);
    const energy = s.reduce((a, x) => a + x.kwh * x.p, 0);
    return { date: d, slots: s, total, cost: s.length ? energy + scAt(d.getTime()) : 0, tariff: names.get(codeFor(d)) || '' };
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
    <p class="small muted" style="margin:8px 0 0">${useTariff ? `Your tariff: ${gasTimeline(results)} — latest ` : 'At '}${pence(unit)}/kWh and ${pence(sc)}/day standing charge. Readings in ${gasUnit() === 'kwh' ? 'kWh' : 'm³, converted to kWh'}.</p>`;

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

/* ---- Current tariff rates (Settings) ---- */
function tariffBase(code) {
  const fuel = code.startsWith('G-') ? 'gas-tariffs' : 'electricity-tariffs';
  return `${API}/products/${productFromCode(code)}/${fuel}/${code}`;
}

/** Load today's + tomorrow's unit rates and the standing charge for a full tariff code. */
async function loadTariffRates(code) {
  const today = midnight(new Date()).getTime();
  const to = addDays(new Date(today), 2).getTime();
  const range = `?period_from=${iso(today)}&period_to=${iso(to)}&page_size=1500`;
  const base = tariffBase(code);
  const twoRate = /^E-2R-/.test(code);
  const [a, b, sc] = await Promise.all([
    cachedAll('rates', `${base}/${twoRate ? 'day-unit-rates' : 'standard-unit-rates'}/${range}`, false),
    twoRate ? cachedAll('rates', `${base}/night-unit-rates/${range}`, false) : Promise.resolve([]),
    code.startsWith('E-') && /OUTGOING|EXPORT/.test(code) ? Promise.resolve([]) : cachedAll('sc', `${base}/standing-charges/`, false),
  ]);
  return { twoRate, unit: toBands(a), night: toBands(b), standing: rateAt(toBands(sc), Date.now()) };
}

/**
 * Describe a set of rate bands in the way that suits the tariff:
 * half-hourly (Agile), daily (Tracker), time-of-use windows (Go) or a single flat rate.
 */
function describeUnitRates(bands) {
  const now = Date.now();
  const today = midnight(new Date()).getTime();
  const tomorrow = addDays(new Date(today), 1).getTime();
  const dayAfter = addDays(new Date(today), 2).getTime();
  const clip = (from, to) => bands
    .filter(b => b.from < to && b.to > from)
    .map(b => ({ from: Math.max(b.from, from), to: Math.min(b.to, to), p: b.p, len: b.to - b.from }));
  const t = clip(today, tomorrow);
  if (!t.length) return { kind: 'unknown', html: '<span class="muted">No rate published for today</span>' };

  if (t.length >= 24) {
    const ps = t.map(b => b.p);
    const avg = ps.reduce((x, y) => x + y, 0) / ps.length;
    const tm = clip(tomorrow, dayAfter);
    const tmNote = tm.length >= 24 ? ` · tomorrow ${pence(Math.min(...tm.map(b => b.p)))}–${pence(Math.max(...tm.map(b => b.p)))}` : '';
    return {
      kind: 'half-hourly',
      html: `<b>${pence(rateAt(bands, now))}</b> now<br><span class="muted">Today ${pence(Math.min(...ps))}–${pence(Math.max(...ps))}, avg ${pence(avg)}${tmNote}</span>`,
    };
  }

  // Daily-changing (Tracker): bands about a day long that end. Bands start at midnight UTC,
  // so read each day at midday to avoid the 23:00/01:00 overlap in summer time.
  if (t.every(b => b.len >= 23 * 3600e3 && b.len <= 25 * 3600e3)) {
    const noon = d => new Date(d + 12 * 3600e3).getTime();
    const tp = rateAt(bands, noon(today));
    const tmp = rateAt(bands, noon(tomorrow));
    return {
      kind: 'daily',
      html: `<b>${pence(tp)}</b>/kWh today<br><span class="muted">${tmp != null ? `Tomorrow ${pence(tmp)}` : "Tomorrow's rate isn't published yet"}</span>`,
    };
  }

  const prices = [...new Set(t.map(b => b.p))];
  if (prices.length === 1) return { kind: 'flat', html: `<b>${pence(prices[0])}</b>/kWh` };

  // Time-of-use: list each price with its windows, joining a window that wraps past midnight.
  const lines = prices.sort((x, y) => x - y).map(p => {
    const wins = [];
    for (const b of t.filter(x => x.p === p)) {
      const last = wins[wins.length - 1];
      if (last && last.to === b.from) last.to = b.to; else wins.push({ from: b.from, to: b.to });
    }
    if (wins.length > 1 && wins[0].from === today && wins[wins.length - 1].to === tomorrow) {
      const first = wins.shift();
      wins[wins.length - 1].to = first.to;
    }
    const isNow = rateAt(bands, now) === p;
    return `<b>${pence(p)}</b> ${wins.map(w => `${hhmm(w.from)}–${hhmm(w.to)}`).join(', ')}${isNow ? ' <span class="now-tag">now</span>' : ''}`;
  });
  return { kind: 'time-of-use', html: lines.join('<br>') };
}

/** Plain average of a tariff's unit rate across today's half-hours. */
function dayAverage(bands) {
  const start = midnight(new Date()).getTime();
  const end = addDays(new Date(start), 1).getTime();
  const ps = [];
  for (let t = start; t < end; t += HALF_HOUR) { const p = rateAt(bands, t); if (p != null) ps.push(p); }
  return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : null;
}

/** Under the Agile card, compare Agile with the tariff you're on: now, across today, and standing charge. */
function addAgileComparison(rows, loaded) {
  const ai = rows.findIndex(r => r.compare);
  const mi = rows.findIndex(r => r.label === 'Electricity');
  const agile = loaded[ai], mine = loaded[mi];
  const el = document.querySelector(`#rate-${ai}`);
  if (ai < 0 || !agile || !mine || !el) return;
  const diff = (a, b, unit) => {
    if (a == null || b == null) return '';
    const d = a - b;
    if (Math.abs(d) < 0.005) return `<span class="muted">same as yours</span>`;
    return `<span class="${d < 0 ? 'cheaper' : 'pricier'}">${pence(Math.abs(d))}${unit} ${d < 0 ? 'cheaper' : 'more expensive'}</span>`;
  };
  const lines = [];
  if (!mine.twoRate) {
    const now = Date.now();
    lines.push(`<div class="kv"><span>Right now</span><div>${diff(rateAt(agile.unit, now), rateAt(mine.unit, now), '')}</div></div>`);
    const aa = dayAverage(agile.unit), ma = dayAverage(mine.unit);
    lines.push(`<div class="kv"><span>Today avg</span><div>${diff(aa, ma, '')}<div class="small muted">Agile ${pence(aa)} vs yours ${pence(ma)} — a plain average, not weighted by when you use power</div></div></div>`);
  }
  lines.push(`<div class="kv"><span>Standing</span><div>${diff(agile.standing, mine.standing, '/day')}</div></div>`);
  const box = document.createElement('div');
  box.className = 'compare-box';
  box.innerHTML = `${lines.join('')}<p class="small" style="margin:6px 0 0"><a href="#history">See what you'd actually have paid on Agile →</a></p>`;
  el.appendChild(box);
}

const KIND_NOTE = {
  'half-hourly': 'Changes every half hour',
  daily: 'Changes daily',
  'time-of-use': 'Cheaper at set times',
  flat: '',
  unknown: '',
};

async function renderCurrentRates() {
  const box = document.getElementById('current-rates');
  if (!box) return;
  const c = settings.connected || {};
  const rows = [
    settings.elecTariff && { label: 'Electricity', name: c.elecTariff, code: settings.elecTariff },
    settings.gasTariff && settings.gas && { label: 'Gas', name: c.gasTariff, code: settings.gasTariff },
    settings.exportTariff && settings.exportEnabled && { label: 'Export', name: c.exportTariff, code: settings.exportTariff, isExport: true },
  ].filter(Boolean);
  // If you're not on Agile, show Agile in your region alongside for comparison.
  const onAgile = tariffKind(productFromCode(settings.elecTariff)) === 'agile';
  if (rows.length && settings.region && settings.agileProduct && !onAgile) {
    rows.push({ label: 'Agile', name: 'Agile Octopus · for comparison', code: tariffCode(settings.agileProduct, settings.region), compare: true });
  }
  const loaded = [];

  if (!rows.length) {
    box.innerHTML = settings.connected
      ? '<p class="small muted" style="margin:0">Press “Refresh from account” to show your current rates.</p>'
      : '';
    return;
  }
  box.innerHTML = `<h3>Your current rates</h3>${rows.map((r, i) => `
    <div class="rate-card${r.compare ? ' compare' : ''}" id="rate-${i}">
      <div class="rate-head"><b>${esc(r.label)}</b><span class="muted">${esc(r.name || productFromCode(r.code))}</span></div>
      <div class="rate-body muted small">Loading…</div>
    </div>`).join('')}
    <p class="small muted" style="margin:6px 0 0">Prices include VAT.</p>`;

  await Promise.all(rows.map(async (r, i) => {
    const el = document.querySelector(`#rate-${i} .rate-body`);
    try {
      const rates = await loadTariffRates(r.code);
      loaded[i] = rates;
      if (!el.isConnected) return;
      let unitHtml, note = '';
      if (rates.twoRate) {
        const day = describeUnitRates(rates.unit);
        const night = describeUnitRates(rates.night);
        unitHtml = `Day ${day.html} · Night ${night.html}`;
        note = 'Economy 7 — night hours depend on your meter';
      } else {
        const d = describeUnitRates(rates.unit);
        unitHtml = d.html;
        note = KIND_NOTE[d.kind];
      }
      el.classList.remove('muted', 'small');
      el.innerHTML = `
        <div class="kv"><span>${r.isExport ? 'You earn' : 'Unit rate'}</span><div>${unitHtml}${note ? `<div class="small muted">${note}</div>` : ''}</div></div>
        ${r.isExport ? '' : `<div class="kv"><span>Standing</span><div><b>${pence(rates.standing)}</b>/day</div></div>`}`;
    } catch (e) {
      if (el.isConnected) el.textContent = `Couldn't load rates (${e.message})`;
    }
  }));
  addAgileComparison(rows, loaded);
}


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
      <p class="small muted" style="margin:0 0 10px">Just two things — everything else (meters, region, tariffs, export and gas) is looked up for you.</p>
      ${field('apiKey', 'API key', 'password', { placeholder: 'sk_live_…',
        hint: 'On your Octopus <a href="https://octopus.energy/dashboard/new/accounts/personal-details/api-access" target="_blank" rel="noopener">API access page</a>. Press <i>Generate</i> if you don’t have one — it’s only shown once, so paste it straight in here.' })}
      ${field('accountNumber', 'Account number', 'text', { placeholder: 'A-1B2C3D4E',
        hint: 'Starts with A-. It’s under your name at the top of your <a href="https://octopus.energy/dashboard/new/accounts" target="_blank" rel="noopener">Octopus account home page</a>.' })}
      <div class="row" style="padding:6px 0 0">
        <button type="button" class="btn" id="connect">${settings.connected ? 'Refresh from account' : 'Connect'}</button>
        <span id="connect-status" class="small muted" role="status"></span>
      </div>
      <div id="connected">${connectedSummary()}</div>
      <div id="current-rates" class="rates"></div>
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
      ${field('smartTariff', 'Highlight days another tariff was cheaper', 'checkbox', { hint: 'Marks days where Agile or Go would have cost less than the tariff you were on' })}
      ${(settings.elecAgreements || []).length ? '' : field('currentTariff', "Tariff you're on", 'select', { dep: 'smartTariff', hint: 'Connect your account and this is worked out day by day instead', options: [['go', 'Go'], ['agile', 'Agile']] })}
      ${field('highlightBorder', 'Highlight with border', 'checkbox', { dep: 'smartTariff', hint: 'Off = shaded background' })}
      ${field('showAverage', 'Show average unit rates', 'checkbox', { hint: "Agile's average price vs the average you actually paid" })}
      ${field('exportFixed', 'Fixed export price (p/kWh)', 'number', { dep: 'exportEnabled', hint: 'Compared against Agile Outgoing' })}
    `, openGroups.has('compare'))}

    ${section('home', 'Price list', [settings.showPriceNow && 'from now', settings.showDayAverage && 'avg/min/max', settings.highlightPrices && 'shaded'].filter(Boolean).join(' · ') || 'all prices', `
      ${field('showPriceNow', 'Only current & future prices', 'checkbox')}
      ${field('showDayAverage', 'Show avg / min / max', 'checkbox')}
      ${field('avgDay', 'For', 'select', { dep: 'showDayAverage', options: [['today', 'Today'], ['tomorrow', 'Tomorrow']] })}
      ${field('highlightPrices', 'Colour prices', 'checkbox', { hint: 'Green below the low threshold, red above the high one' })}
      ${field('autoThresholds', 'Set thresholds automatically', 'checkbox', { dep: 'highlightPrices',
        hint: `From the last week of Agile prices: cheapest quarter green, most expensive quarter red. Currently below ${pence(num(settings.lowThreshold, 15))} / above ${pence(num(settings.highThreshold, 30))}.` })}
      ${field('lowThreshold', 'Low threshold (p)', 'number', { dep: 'highlightPrices&!autoThresholds' })}
      ${field('highThreshold', 'High threshold (p)', 'number', { dep: 'highlightPrices&!autoThresholds' })}
    `, openGroups.has('home'))}

    ${section('shift', 'Load shift', settings.timeshift ? 'on' : 'off', `
      <p class="small muted" style="margin:0 0 6px">Estimates your Go cost if big loads (like a car or immersion heater) had run in the cheap window. Tap a day's graph to toggle.</p>
      ${field('timeshift', 'Enable load shift', 'checkbox')}
      ${field('loadThreshold', 'Shift half-hours above (kWh)', 'number', { dep: 'timeshift' })}
      ${field('baseload', 'Baseload left behind (kWh)', 'number', { dep: 'timeshift' })}
      ${field('timeshiftAll', 'Open graphs in shifted view', 'checkbox', { dep: 'timeshift',
        hint: 'Off: each day shows your real usage — tap a graph to see it shifted. On: every day starts shifted — tap to see real usage. Only the Go cost changes.' })}
      <div class="field" data-dep="timeshift"><span>Hours that can be shifted<small><a href="#" id="hours-all">All</a> · <a href="#" id="hours-none">None</a></small></span>
        <div class="hours-grid">${ALL_HOURS.map(h => `<label><input type="checkbox" name="hour" value="${h}" ${hours.has(h) ? 'checked' : ''}>${h}</label>`).join('')}</div></div>
    `, openGroups.has('shift'))}

    ${section('gasopts', 'Gas', settings.gas ? `readings in ${gasUnit() === 'kwh' ? 'kWh' : 'm³'}${settings.gasTariff ? '' : ' · manual prices'}` : 'off', `
      <p class="small muted" data-dep-off="gas" style="margin:0">No gas meter set up. Connect your account, or turn on "Gas meter" under Meter details.</p>
      ${field('gasUnit', 'Gas readings', 'select', { dep: 'gas',
        hint: 'Leave on Automatic. Only change it if your gas use looks about 11× too high or low.',
        options: [
          ['auto', `Automatic${settings.gasDetectedUnit ? ` (detected: ${settings.gasDetectedUnit === 'kwh' ? 'kWh' : 'm³'})` : ' (m³ assumed)'}`],
          ['m3', 'm³ — most newer (SMETS2) meters'],
          ['kwh', 'kWh — most older (SMETS1) meters'],
        ] })}
      ${settings.gasTariff ? '' : `
        <p class="small muted">Your gas tariff isn't known, so enter its prices. Connecting your account fills these in automatically.</p>
        ${field('gasUnitRate', 'Unit rate (p/kWh)', 'number', { dep: 'gas' })}
        ${field('gasStanding', 'Standing charge (p/day)', 'number', { dep: 'gas' })}`}
    `, openGroups.has('gasopts'))}

    ${section('advanced', 'Advanced', esc(`${settings.agileProduct} vs ${settings.goProduct}`), `
      <p class="small muted" style="margin:0 0 6px">History compares against the Agile and Go versions that were on sale on each date (or your own, if you were on one). These are only used if that lookup fails.</p>
      ${field('agileProduct', 'Fallback Agile product')}
      ${field('goProduct', 'Fallback Go product')}
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
  const syncDeps = () => {
    syncFieldDeps();
    form.querySelectorAll('[data-dep-off]').forEach(p => { p.hidden = !!settings[p.dataset.depOff]; });
  };
  const syncFieldDeps = () => form.querySelectorAll('[data-dep]').forEach(f => {
    // data-dep: 'a', '!a' or 'a&!b' — shown only while every condition holds.
    const on = f.dataset.dep.split('&').every(k => (k[0] === '!' ? !settings[k.slice(1)] : !!settings[k]));
    f.classList.toggle('disabled', !on);
    f.querySelectorAll('input,select').forEach(i => { i.disabled = !on; });
  });
  syncDeps();
  renderCurrentRates();

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
    <h3>Install on your phone</h3>
    <p>${installPrompt ? '<button type="button" class="btn" id="about-install">Install app</button>' : isStandalone()
      ? 'You’re using the installed app.'
      : 'In Chrome on Android, tap <b>⋮</b> then <b>Install app</b> (or <b>Add to home screen</b>). It then opens in its own window, without the browser bars, and works offline with your last-loaded data.'}</p>
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

/* ---------------- installable app ---------------- */
var installPrompt = null; // var: About may render (via route()) before this line runs
function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}
async function runInstall() {
  if (!installPrompt) return;
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  installPrompt = null;
  showInstallCard();
  if (outcome === 'accepted') toast('Installing — look for Go Agile on your home screen.');
}
/** A small, dismissible "Install" card on Home, only when Chrome says the app can be installed. */
function showInstallCard() {
  const slot = document.getElementById('install-slot');
  if (!slot) return;
  if (!installPrompt || isStandalone() || store.get('ga:installDismissed', false)) { slot.innerHTML = ''; return; }
  slot.innerHTML = `<section class="card install-card">
    <div><b>Install Go Agile</b><div class="small muted">Open it from your home screen like an app.</div></div>
    <div class="row"><button type="button" class="btn" id="install-btn">Install</button>
    <button type="button" class="icon-btn dismiss" id="install-dismiss" aria-label="Not now">×</button></div></section>`;
  document.getElementById('install-btn').onclick = runInstall;
  document.getElementById('install-dismiss').onclick = () => { store.set('ga:installDismissed', true); slot.innerHTML = ''; };
}
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault(); // show our own button instead of Chrome's mini-bar
  installPrompt = e;
  showInstallCard();
  const btn = document.getElementById('about-install');
  if (btn) btn.onclick = runInstall;
});
window.addEventListener('appinstalled', () => { installPrompt = null; showInstallCard(); });
// Re-attach after each page render (Home and About are rebuilt on navigation).
window.addEventListener('hashchange', () => setTimeout(() => {
  showInstallCard();
  const btn = document.getElementById('about-install');
  if (btn) btn.onclick = runInstall;
}, 0));
showInstallCard();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
