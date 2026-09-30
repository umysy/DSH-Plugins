/**
 * dsh-quota-card — peak/off-peak rule, cost estimate, and number formatting.
 *
 * Pure functions only: no imports, no I/O, no ambient time. Every entry point
 * takes the instant as an argument, which is what lets the test suite pin exact
 * peak/off-peak boundaries.
 *
 * Rule (https://api-docs.deepseek.com/quick_start/pricing):
 *   "Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00
 *    and 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese public
 *    holidays. All other hours are off-peak, including weekends and Chinese
 *    public holidays in full."
 * 01:00-04:00 + 06:00-10:00 UTC == 09:00-12:00 + 14:00-18:00 Asia/Shanghai.
 *
 * Token accounting (DSH `TokenUsage` — "counts are DISJOINT"):
 *   `inputTokens` is UNCACHED input only; cached input arrives separately as
 *   `cacheReadTokens` / `cacheWriteTokens`, and billed input is the sum of the
 *   three. Nothing is double-counted.
 *   Cache-hit rate = cacheRead / (input + cacheRead + cacheWrite).
 */

/** 1 = Monday … 7 = Sunday (ISO-8601 weekday numbering). */
export const DEFAULT_PEAK_DAYS = [1, 2, 3, 4, 5];

export const DEFAULT_PEAK_WINDOWS = [
  { start: '09:00', end: '12:00', startMinutes: 9 * 60, endMinutes: 12 * 60 },
  { start: '14:00', end: '18:00', startMinutes: 14 * 60, endMinutes: 18 * 60 },
];

export const DEFAULT_PEAK_MULTIPLIER = 2;

export const FALLBACK_MODEL = 'deepseek-flash';

/** Mirrors `lib/config.js`; used only when a caller passes no price table. */
export const FALLBACK_PRICES = {
  [FALLBACK_MODEL]: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
  'deepseek-v4-pro': { cacheHit: 0.3, cacheMiss: 9, output: 27 },
};

/** Empty token totals; every bucket in the ledger has this shape. */
export function emptyTotals() {
  return { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, requests: 0 };
}

/** Field-wise sum of token totals. */
export function addTotals(a, b) {
  const base = a ?? emptyTotals();
  const extra = b ?? emptyTotals();
  return {
    inputTokens: base.inputTokens + extra.inputTokens,
    cacheReadTokens: base.cacheReadTokens + extra.cacheReadTokens,
    cacheWriteTokens: base.cacheWriteTokens + extra.cacheWriteTokens,
    outputTokens: base.outputTokens + extra.outputTokens,
    requests: base.requests + extra.requests,
  };
}

/** Total tokens processed (all three input classes plus output). */
export function totalTokens(totals) {
  if (totals === null || totals === undefined) return 0;
  return (
    (totals.inputTokens || 0) +
    (totals.cacheReadTokens || 0) +
    (totals.cacheWriteTokens || 0) +
    (totals.outputTokens || 0)
  );
}

/** Billed input = uncached + cache read + cache write. */
export function billedInput(totals) {
  if (totals === null || totals === undefined) return 0;
  return (totals.inputTokens || 0) + (totals.cacheReadTokens || 0) + (totals.cacheWriteTokens || 0);
}

/** Cache-hit rate in `[0, 1]`; `null` when no input was measured (never 0/0). */
export function cacheHitRate(totals) {
  const input = billedInput(totals);
  if (!Number.isFinite(input) || input <= 0) return null;
  return Math.min(1, Math.max(0, (totals.cacheReadTokens || 0) / input));
}

const pad2 = (value) => String(value).padStart(2, '0');

// ── zone-local calendar ───────────────────────────────────────────────────────

const formatters = new Map();

function partsFormatter(timeZone) {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * Calendar fields of one instant in a zone, independent of the machine's zone.
 * An unknown zone name degrades to UTC instead of throwing.
 * @param {number} at epoch milliseconds.
 * @param {string} timeZone IANA zone name.
 */
export function zoneParts(at, timeZone) {
  const safe = Number.isFinite(at) ? at : Date.now();
  let fields;
  try {
    fields = partsFormatter(timeZone).formatToParts(new Date(safe));
  } catch {
    fields = partsFormatter('UTC').formatToParts(new Date(safe));
  }
  const read = (type) => {
    const part = fields.find((entry) => entry.type === type);
    return part === undefined ? '' : part.value;
  };
  const year = Number(read('year'));
  const month = Number(read('month'));
  const day = Number(read('day'));
  const hours = Number(read('hour')) % 24; // some engines render midnight as 24
  const minutes = Number(read('minute'));
  // The weekday is derived from the zone-local calendar date rather than read
  // from a `weekday` field, so it can never disagree with the date above.
  const dayIso = ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1;
  return {
    year,
    month,
    day,
    hours: Number.isFinite(hours) ? hours : 0,
    minutes: Number.isFinite(minutes) ? minutes : 0,
    dayIso,
    date: year + '-' + pad2(month) + '-' + pad2(day),
    monthDay: pad2(month) + '-' + pad2(day),
  };
}

/** `2026-09-30` in the given zone. */
export function zoneDateString(at, timeZone) {
  return zoneParts(at, timeZone).date;
}

/** `2026-09` in the given zone. */
export function zoneMonthString(at, timeZone) {
  const parts = zoneParts(at, timeZone);
  return parts.year + '-' + pad2(parts.month);
}

/**
 * `at` shifted by whole days, wall-clock time preserved. The zone offset is
 * re-read at the target instant, so a DST transition never drifts the local
 * time. Used by the test suite to build fixed fixtures.
 */
export function shiftDays(at, delta, timeZone) {
  const from = zoneParts(at, timeZone);
  const naive = Date.UTC(from.year, from.month - 1, from.day + delta, from.hours, from.minutes);
  // Guess: treat the naive stamp as UTC, then correct by the target's offset.
  const guess = naive - offsetMs(at, timeZone);
  return guess - (offsetMs(guess, timeZone) - offsetMs(at, timeZone));
}

/** Zone offset in ms for one instant (positive east of UTC). */
function offsetMs(at, timeZone) {
  const parts = zoneParts(at, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hours, parts.minutes);
  return asUtc - Math.floor(at / 60_000) * 60_000;
}

// ── peak / off-peak ───────────────────────────────────────────────────────────

const MINUTE_MS = 60_000;
const DAY_MINUTES = 24 * 60;

/**
 * How far the "next peak morning" walk may look. It must clear the longest
 * holiday block plus its surrounding weekend: 春节 2026 runs 02-15..02-23, so a
 * week is not enough and a month is comfortably sufficient.
 */
const MAX_PEAK_WALK_DAYS = 32;

function inWindow(minutes, window) {
  return minutes >= window.startMinutes && minutes < window.endMinutes;
}

function isPeakWindow(minutes, windows) {
  for (const window of windows) if (inWindow(minutes, window)) return true;
  return false;
}

/** Midnight of the next zone-local day. */
function nextMidnight(fromMs, minutes) {
  return fromMs + (DAY_MINUTES - minutes) * MINUTE_MS;
}

/** Expand `MM-DD` entries to `YYYY-MM-DD` for one year (full dates pass through). */
function expandDates(entries, year) {
  if (!Array.isArray(entries)) return [];
  const out = [];
  for (const entry of entries) {
    const text = String(entry);
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) out.push(text);
    else if (/^\d{2}-\d{2}$/.test(text)) out.push(year + '-' + text);
  }
  return out;
}

/** The rule in force for one instant: is it a peak day, and is it in a peak window. */
function ruleState(atMs, rule) {
  const parts = zoneParts(atMs, rule.timezone);
  const holiday = rule.holidays.includes(parts.date);
  const peakDay = !holiday && (rule.peakDays.includes(parts.dayIso) ||
    (rule.countMakeupAsPeak && rule.makeupWorkdays.includes(parts.date)));
  const minutes = parts.hours * 60 + parts.minutes;
  return { parts, minutes, peak: peakDay && isPeakWindow(minutes, rule.peakWindows) };
}

/**
 * Next instant strictly after `fromMs` whose tier differs from the current one.
 * @returns {number|null} epoch ms, or null when the tier never changes.
 */
function nextTransition(fromMs, rule) {
  const state = ruleState(fromMs, rule);
  // A rule can only ever change tier if it has at least one window. (A rule with
  // no peak DAY can still be peak — via `countMakeupAsPeak` on a make-up
  // weekend — so that case must not short-circuit here.)
  if (rule.peakWindows.length === 0) return null;
  if (state.peak) {
    // Leaving peak: the nearest peak-window end.
    let best;
    for (const window of rule.peakWindows) {
      if (!inWindow(state.minutes, window)) continue;
      const remaining = window.endMinutes - state.minutes;
      if (remaining <= 0) continue;
      if (best === undefined || remaining < best) best = remaining;
    }
    return best === undefined ? null : fromMs + best * MINUTE_MS;
  }
  // Entering peak: a later window TODAY, but only when today is a peak day. On
  // a weekend or a holiday a later window is not a tier change at all, so the
  // search must fall through to the next peak day.
  if (isPeakDayFor(fromMs, rule)) {
    let best;
    for (const window of rule.peakWindows) {
      const delta = window.startMinutes - state.minutes;
      if (delta > 0 && (best === undefined || delta < best)) best = delta;
    }
    if (best !== undefined) return fromMs + best * MINUTE_MS;
  }
  // Otherwise the first window of the next peak day. The walk must clear the
  // longest holiday block: 春节 2026 spans 02-15..02-23, so a single week is not
  // enough — from 02-13 20:00 the next peak morning is 02-24 09:00.
  let cursor = nextMidnight(fromMs, state.minutes);
  for (let step = 0; step < MAX_PEAK_WALK_DAYS; step += 1) {
    if (isPeakDayFor(cursor, rule)) {
      let first;
      for (const window of rule.peakWindows) {
        if (first === undefined || window.startMinutes < first) first = window.startMinutes;
      }
      if (first === undefined) return null;
      return cursor + first * MINUTE_MS;
    }
    cursor += DAY_MINUTES * MINUTE_MS;
  }
  return null;
}

/** Whether any peak window applies on the zone-local day containing `atMs`. */
function isPeakDayFor(atMs, rule) {
  const parts = zoneParts(atMs, rule.timezone);
  if (rule.holidays.includes(parts.date)) return false; // holidays win out
  if (rule.peakDays.includes(parts.dayIso)) return true;
  return rule.countMakeupAsPeak === true && rule.makeupWorkdays.includes(parts.date);
}

/**
 * Normalize a config object (plus the code-level holiday table) into the flat
 * rule shape the resolvers use.
 * @param {object} config normalized config from `lib/config.js`.
 * @param {number} year the year used to expand `MM-DD` holiday entries.
 */
export function toRule(config, year) {
  const source = config ?? {};
  const holidays = pickYear(source.holidays, year);
  const makeup = pickYear(source.makeupWorkdays, year);
  return {
    timezone: typeof source.timezone === 'string' && source.timezone !== '' ? source.timezone : 'Asia/Shanghai',
    peakWindows: Array.isArray(source.peakWindows) && source.peakWindows.length > 0 ? source.peakWindows : DEFAULT_PEAK_WINDOWS,
    peakDays: Array.isArray(source.peakDays) ? source.peakDays : DEFAULT_PEAK_DAYS,
    peakMultiplier: Number.isFinite(source.peakMultiplier) && source.peakMultiplier > 0
      ? source.peakMultiplier
      : DEFAULT_PEAK_MULTIPLIER,
    holidays: expandDates(holidays, year),
    makeupWorkdays: expandDates(makeup, year),
    countMakeupAsPeak: source.countMakeupAsPeak === true,
  };
}

/**
 * One year's entries from a date map. Accepts:
 *   - a year-keyed map `{ "2026": ["MM-DD", …] }` — ONLY that year is returned;
 *     a missing year yields `[]`, so a stale table can never be applied to the
 *     wrong year
 *   - a festival-keyed map `{ 春节: ["02-17"] }` — all groups are flattened and
 *     attributed to the requested year
 *   - a flat array, or a single string
 */
function pickYear(value, year) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [value];
  if (typeof value !== 'object') return [];
  const keys = Object.keys(value);
  if (keys.length > 0 && keys.every((key) => /^\d{4}$/.test(key))) {
    const found = value[String(year)];
    return Array.isArray(found) ? found : (typeof found === 'string' ? [found] : []);
  }
  const out = [];
  for (const entry of Object.values(value)) {
    if (Array.isArray(entry)) out.push(...entry);
    else if (typeof entry === 'string') out.push(entry);
  }
  return out;
}

/**
 * The tier in force at one instant, plus when it next changes.
 * @param {number} at epoch ms.
 * @param {object} config normalized config.
 * @returns {{peak:boolean,multiplier:number,label:string,nextChangeAt:number|null,date:string,minutes:number,holiday:boolean,makeup:boolean}}
 */
export function resolveTier(at, config) {
  const atMs = Number.isFinite(at) ? at : Date.now();
  const year = zoneParts(atMs, config?.timezone ?? 'Asia/Shanghai').year;
  const rule = toRule(config ?? {}, year);
  const state = ruleState(atMs, rule);
  const holiday = rule.holidays.includes(state.parts.date);
  return {
    peak: state.peak,
    multiplier: state.peak ? 1 : 1 / rule.peakMultiplier,
    label: state.peak ? 'peak' : 'off-peak',
    nextChangeAt: nextTransition(atMs, rule),
    date: state.parts.date,
    minutes: state.minutes,
    holiday,
    makeup: rule.makeupWorkdays.includes(state.parts.date),
  };
}

// ── cost estimate ─────────────────────────────────────────────────────────────

/**
 * Resolve one model id against the price table: exact match, else the longest
 * configured model that prefixes it (covers dated aliases such as
 * `deepseek-flash-2026-09-10`), else the fallback row.
 * @returns {{price: object, matched: string, exact: boolean}}
 */
export function priceForModel(model, prices) {
  const table = prices !== null && typeof prices === 'object' && Object.keys(prices).length > 0
    ? prices
    : FALLBACK_PRICES;
  const name = typeof model === 'string' ? model : '';
  if (table[name] !== undefined) return { price: table[name], matched: name, exact: true };
  let best;
  for (const candidate of Object.keys(table)) {
    if (candidate !== '' && name.startsWith(candidate) && (best === undefined || candidate.length > best.length)) {
      best = candidate;
    }
  }
  if (best !== undefined) return { price: table[best], matched: best, exact: false };
  const fallback = table[FALLBACK_MODEL] ?? Object.values(table)[0] ?? FALLBACK_PRICES[FALLBACK_MODEL];
  return { price: fallback, matched: FALLBACK_MODEL, exact: false };
}

/**
 * CNY cost of one model's totals at one tier.
 * @param {object} totals token totals.
 * @param {{cacheHit:number,cacheMiss:number,output:number}} price peak-tier rates per 1M tokens.
 * @param {number} divisor `peakMultiplier` for off-peak, `1` for peak.
 */
export function costOfTotals(totals, price, divisor) {
  if (totals === null || totals === undefined) return 0;
  const factor = divisor > 0 ? 1 / divisor : 1;
  const million = 1_000_000;
  return (
    ((totals.cacheReadTokens || 0) * (price.cacheHit || 0) +
      (totals.inputTokens || 0) * (price.cacheMiss || 0) +
      (totals.cacheWriteTokens || 0) * (price.cacheMiss || 0) +
      (totals.outputTokens || 0) * (price.output || 0)) /
    million *
    factor
  );
}

/**
 * Estimated spend for one bucket, pricing each request at the tier in force
 * when it ran (a single blended rate would misprice boundary requests).
 *
 * @param {Iterable<{model:string, tier:'peak'|'offPeak', totals:object}>} entries
 * @param {object} config normalized config.
 * @returns {{total:number, byModel:object, approximate:boolean}}
 */
export function estimateCost(entries, config) {
  const multiplier = Number.isFinite(config?.peakMultiplier) && config.peakMultiplier > 0
    ? config.peakMultiplier
    : DEFAULT_PEAK_MULTIPLIER;
  const byModel = {};
  let total = 0;
  let approximate = false;
  for (const entry of entries ?? []) {
    const { price, matched, exact } = priceForModel(entry.model, config?.prices);
    if (!exact) approximate = true;
    const cost = costOfTotals(entry.totals, price, entry.tier === 'offPeak' ? multiplier : 1);
    total += cost;
    const row = byModel[entry.model] ?? { model: entry.model, matched, exact, cost: 0 };
    row.cost += cost;
    byModel[entry.model] = row;
  }
  return { total, byModel, approximate };
}

// ── formatting (also inlined in `lib/client.js`, which cannot import ESM) ─────

/**
 * Compact token count: `999`, `1.2K`, `15.5M`, `1.05B`, `2.3T`.
 * Values below 1000 stay exact; larger ones keep at most three significant
 * digits, carrying into the next unit when rounding crosses 1000.
 */
export function formatTokens(value) {
  if (!Number.isFinite(value)) return '--';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs < 1000) return sign + String(Math.round(abs));
  const units = ['K', 'M', 'B', 'T'];
  let scaled = abs;
  let unit = -1;
  while (scaled >= 1000 && unit < units.length - 1) {
    scaled /= 1000;
    unit += 1;
  }
  let text;
  if (scaled >= 100) text = scaled.toFixed(0);
  else if (scaled >= 10) text = scaled.toFixed(1);
  else text = scaled.toFixed(2);
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  // Carry 999.9K -> 1M so a value rounded at the unit boundary stays true.
  if (Number(text) >= 1000 && unit < units.length - 1) return sign + '1' + units[unit + 1];
  return sign + text + units[unit];
}

/** `99.2%` / `0%`; `--` when the rate is unknown. */
export function formatPercent(rate) {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '--';
  return (rate * 100).toFixed(1) + '%';
}

/**
 * `¥9.66` / `$12.50`. Below one cent the value keeps four decimals (trailing
 * zeros trimmed) so a tiny estimate does not render as `¥0.00`.
 */
export function formatMoney(value, currency) {
  if (!Number.isFinite(value)) return '--';
  const symbol = currency === 'USD' ? '$' : '¥';
  const abs = Math.abs(value);
  if (abs === 0) return symbol + '0.00';
  if (abs < 0.01) return symbol + value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return symbol + value.toFixed(2);
}

/** `1h 23m` / `45m` / `2d 3h`; `--` when the instant is unknown. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--';
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return String(minutes) + 'm';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? String(hours) + 'h' : hours + 'h ' + rest + 'm';
  const days = Math.floor(hours / 24);
  const hourRest = hours % 24;
  return hourRest === 0 ? String(days) + 'd' : days + 'd ' + hourRest + 'h';
}
