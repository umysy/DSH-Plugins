/**
 * dsh-quota-card — configuration.
 *
 * Pure data + validation. The ONLY import is this package's own holiday table —
 * no third-party module, no I/O, no ambient time beyond the caller-supplied year.
 * That keeps the Host half loadable by bare Node (the plugin's strongest review
 * invariant) and the module testable in isolation.
 *
 * Every field is optional. A missing or invalid field falls back to the
 * built-in default instead of failing the plugin, so a typo in
 * cordis.patch.yml can never keep the Harness from booting.
 */

import { HOLIDAYS, MAKEUP_WORKDAYS } from './holidays.js';

/** Official peak windows in Beijing time. See README for the source. */
const DEFAULT_PEAK_WINDOWS = [
  ['09:00', '12:00'],
  ['14:00', '18:00'],
];

/** 1 = Monday … 7 = Sunday (ISO-8601 weekday numbering). */
const DEFAULT_PEAK_DAYS = [1, 2, 3, 4, 5];

/** Off-peak price = peak price / this. 2 => "half of peak". */
const DEFAULT_PEAK_MULTIPLIER = 2;

/**
 * Built-in price table, CNY per 1,000,000 tokens, peak rates.
 * Off-peak is derived by dividing by `peakMultiplier`.
 * Source: https://api-docs.deepseek.com/quick_start/pricing
 */
const DEFAULT_PRICES = {
  'deepseek-flash': { cacheHit: 0.04, cacheMiss: 2, output: 8 },
  'deepseek-v4-pro': { cacheHit: 0.3, cacheMiss: 9, output: 27 },
};

export const DEFAULTS = {
  timezone: 'Asia/Shanghai',
  peakWindows: DEFAULT_PEAK_WINDOWS,
  peakDays: DEFAULT_PEAK_DAYS,
  peakMultiplier: DEFAULT_PEAK_MULTIPLIER,
  // The holiday and make-up tables are NOT listed here: `normalizeConfig` runs
  // the imported HOLIDAYS / MAKEUP_WORKDAYS constants through `normalizeDateMap`
  // (via `normalizeDateField`), the same path user config takes, so there is
  // exactly one default for them and exactly one code path that can produce
  // their shape.
  countMakeupAsPeak: false,
  showCost: false,
  note: '空闲价格为高峰价格的一半',
  prices: DEFAULT_PRICES,
  balancePollMs: 60000,
  // Sent to the official account seam when it supplies the balance. Purely
  // informational; the seam uses it to tag the request, not to authorize it.
  locale: 'zh_CN',
  clientVersion: 'dsh-quota-card/0.3.0',
  // ── account history (the console's private usage API) ─────────────────────
  // Off by default: it needs the console session token (the `userToken` in
  // platform.deepseek.com's localStorage) and it reads an UNDOCUMENTED endpoint.
  // With it on, the lifetime rows show the whole account history instead of the
  // local ledger's own (install-date onward) range.
  platformHistory: false,
  platformTokenRef: 'DEEPSEEK_USER_TOKEN',
  platformHistoryMonths: 48,
  platformHistoryTtlMs: 600000,
};

/**
 * `HH:MM` (or `H:MM`) -> minutes since local midnight; `undefined` when invalid.
 * `24:00` is accepted as an end-of-day instant (1440) so a window can end at
 * midnight; a window that STARTS there is still rejected, because its end could
 * never be after its start.
 */
export function clockToMinutes(value) {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (match === null) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return undefined;
  if (minutes < 0 || minutes > 59) return undefined;
  if (hours === 24 && minutes === 0) return 24 * 60;
  if (hours < 0 || hours > 23) return undefined;
  return hours * 60 + minutes;
}

/**
 * Minutes since midnight -> `HH:MM` (zero-padded, 24-hour). This is the canonical
 * form of every normalized window, so a user writing `'09:00'` gets `'09:00'`
 * back rather than `'9:00'`; the card prints its own compact `9:00-12:00` label
 * from the minute numbers. `1440` renders as `24:00` for the same reason.
 */
export function minutesToClock(minutes) {
  const safe = Math.max(0, Math.min(24 * 60, Math.round(minutes)));
  const hours = Math.floor(safe / 60);
  const mins = safe % 60;
  return String(hours).padStart(2, '0') + ':' + String(mins).padStart(2, '0');
}

/**
 * Normalize one `[start, end]` pair to `{ start, end, startMinutes, endMinutes }`.
 * A window whose end is not after its start is dropped (cross-midnight windows
 * are not part of the official rule and would make "remaining time" ambiguous).
 */
function normalizeWindow(input) {
  if (!Array.isArray(input) || input.length !== 2) return undefined;
  const startMinutes = clockToMinutes(input[0]);
  const endMinutes = clockToMinutes(input[1]);
  if (startMinutes === undefined || endMinutes === undefined) return undefined;
  if (endMinutes <= startMinutes) return undefined;
  return {
    start: minutesToClock(startMinutes),
    end: minutesToClock(endMinutes),
    startMinutes,
    endMinutes,
  };
}

/** Keep valid windows only, sorted, falling back to the official default. */
function normalizeWindows(input) {
  if (!Array.isArray(input)) return DEFAULTS.peakWindows.map(([start, end]) => normalizeWindow([start, end])).filter(Boolean);
  const windows = [];
  for (const candidate of input) {
    const window = normalizeWindow(candidate);
    if (window !== undefined) windows.push(window);
  }
  if (windows.length === 0) return DEFAULTS.peakWindows.map(([start, end]) => normalizeWindow([start, end])).filter(Boolean);
  windows.sort((a, b) => a.startMinutes - b.startMinutes);
  return windows;
}

/** Positive ISO weekday numbers, de-duplicated and sorted; [] means "never peak". */
function normalizePeakDays(input) {
  if (!Array.isArray(input)) return DEFAULT_PEAK_DAYS.slice();
  const days = new Set();
  for (const raw of input) {
    const day = Number(raw);
    if (Number.isInteger(day) && day >= 1 && day <= 7) days.add(day);
  }
  return [...days].sort((a, b) => a - b);
}

/**
 * Flatten a `{ 名称: ["MM-DD", …] }` / `{ "2026": [...] }` / flat-array date map
 * into `{ "YYYY": ["MM-DD", …] }`. Short dates are attributed to `defaultYear`
 * (the year the Host is currently running in, supplied by the caller so this
 * module stays free of ambient time).
 */
function normalizeDateMap(input, defaultYear) {
  const out = {};
  const current = String(defaultYear);
  const add = (value) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    const full = /^(\d{4})-(\d{2}-\d{2})$/.exec(trimmed);
    let year;
    let monthDay;
    if (full !== null) {
      year = full[1];
      monthDay = full[2];
    } else if (/^\d{2}-\d{2}$/.test(trimmed)) {
      year = current;
      monthDay = trimmed;
    } else {
      return;
    }
    if (out[year] === undefined) out[year] = [];
    if (!out[year].includes(monthDay)) out[year].push(monthDay);
  };
  const visit = (value) => {
    if (Array.isArray(value)) for (const entry of value) add(entry);
    else add(value);
  };
  if (Array.isArray(input) || typeof input === 'string') {
    visit(input);
  } else if (input !== null && typeof input === 'object') {
    const byYear = Object.keys(input).length > 0 && Object.keys(input).every((key) => /^\d{4}$/.test(key));
    if (byYear) for (const year of Object.keys(input)) for (const entry of [].concat(input[year])) add(String(year) + '-' + String(entry));
    else for (const value of Object.values(input)) visit(value);
  }
  for (const year of Object.keys(out)) out[year].sort();
  return out;
}

/** Price table with finite non-negative numbers only. */
function normalizePrices(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return DEFAULTS.prices;
  const out = {};
  for (const [model, row] of Object.entries(input)) {
    if (model === '' || row === null || typeof row !== 'object') continue;
    const clean = {};
    for (const key of ['cacheHit', 'cacheMiss', 'output']) {
      const value = Number(row[key]);
      if (Number.isFinite(value) && value >= 0) clean[key] = value;
    }
    if (Object.keys(clean).length === 3) out[model] = clean;
  }
  if (Object.keys(out).length === 0) return DEFAULTS.prices;
  return out;
}

function positiveInt(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.round(number);
}

/**
 * Normalize one date-map field, falling back to the BUILT-IN table for shapes
 * that carry no usable date at all (a number, `null`, a wrong object), so a typo
 * cannot silently disable the holiday rule. An explicit empty map `{}` or empty
 * array `[]` is intentional and DOES clear the table — the card then reports
 * 「节假日表：未知」.
 */
function normalizeDateField(input, defaultYear, builtin) {
  const fallback = normalizeDateMap(builtin, defaultYear);
  if (input === undefined || input === null) return fallback;
  if (typeof input !== 'string' && typeof input !== 'object') return fallback;
  const normalized = normalizeDateMap(input, defaultYear);
  if (Object.keys(normalized).length > 0) return normalized;
  const isEmptyLiteral = input === ''
    || (Array.isArray(input) && input.length === 0)
    || (typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 0);
  return isEmptyLiteral ? normalized : fallback;
}

/**
 * Merge a raw `config` object (from cordis.patch.yml) over the defaults.
 * @param {unknown} raw loader-provided config; anything unexpected is ignored.
 * @param {number} [defaultYear] year attributed to bare `MM-DD` date entries.
 */
export function normalizeConfig(raw, defaultYear) {
  const year = Number.isInteger(defaultYear) ? defaultYear : new Date().getFullYear();
  const config = {
    timezone: DEFAULTS.timezone,
    peakWindows: normalizeWindows(undefined),
    peakDays: DEFAULT_PEAK_DAYS.slice(),
    peakMultiplier: DEFAULT_PEAK_MULTIPLIER,
    // The built-in tables go through the same normalizer as user config, so
    // `config.holidays` is ALWAYS `{ "YYYY": ["MM-DD", …] }` no matter which
    // layer supplied it. Skipping this is how a shape mismatch silently
    // disables the holiday rule.
    holidays: normalizeDateField(undefined, year, HOLIDAYS),
    makeupWorkdays: normalizeDateField(undefined, year, MAKEUP_WORKDAYS),
    countMakeupAsPeak: DEFAULTS.countMakeupAsPeak,
    showCost: DEFAULTS.showCost,
    note: DEFAULTS.note,
    prices: DEFAULTS.prices,
    balancePollMs: DEFAULTS.balancePollMs,
    locale: DEFAULTS.locale,
    clientVersion: DEFAULTS.clientVersion,
    platformHistory: DEFAULTS.platformHistory,
    platformTokenRef: DEFAULTS.platformTokenRef,
    platformHistoryMonths: DEFAULTS.platformHistoryMonths,
    platformHistoryTtlMs: DEFAULTS.platformHistoryTtlMs,
  };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return config;

  if (typeof raw.timezone === 'string' && raw.timezone.trim() !== '') config.timezone = raw.timezone.trim();
  if (raw.peakWindows !== undefined) config.peakWindows = normalizeWindows(raw.peakWindows);
  if (raw.peakDays !== undefined) config.peakDays = normalizePeakDays(raw.peakDays);
  if (raw.holidays !== undefined) config.holidays = normalizeDateField(raw.holidays, year, HOLIDAYS);
  if (raw.makeupWorkdays !== undefined) config.makeupWorkdays = normalizeDateField(raw.makeupWorkdays, year, MAKEUP_WORKDAYS);
  if (raw.countMakeupAsPeak !== undefined) config.countMakeupAsPeak = raw.countMakeupAsPeak === true;
  if (raw.prices !== undefined) config.prices = normalizePrices(raw.prices);
  if (raw.showCost !== undefined) config.showCost = raw.showCost === true;
  if (raw.note !== undefined) config.note = typeof raw.note === 'string' ? raw.note : '';
  if (raw.balancePollMs !== undefined) config.balancePollMs = positiveInt(raw.balancePollMs, DEFAULTS.balancePollMs);
  if (typeof raw.locale === 'string' && raw.locale.trim() !== '') config.locale = raw.locale.trim();
  if (typeof raw.clientVersion === 'string' && raw.clientVersion.trim() !== '') config.clientVersion = raw.clientVersion.trim();
  if (raw.platformHistory !== undefined) config.platformHistory = raw.platformHistory === true;
  if (typeof raw.platformTokenRef === 'string' && raw.platformTokenRef.trim() !== '') config.platformTokenRef = raw.platformTokenRef.trim();
  if (raw.platformHistoryMonths !== undefined) {
    config.platformHistoryMonths = Math.min(positiveInt(raw.platformHistoryMonths, DEFAULTS.platformHistoryMonths), 120);
  }
  if (raw.platformHistoryTtlMs !== undefined) {
    config.platformHistoryTtlMs = positiveInt(raw.platformHistoryTtlMs, DEFAULTS.platformHistoryTtlMs);
  }

  const multiplier = Number(raw.peakMultiplier);
  if (Number.isFinite(multiplier) && multiplier > 0) config.peakMultiplier = multiplier;

  return config;
}

/**
 * The wire/config shape the browser half receives. The price table stays on the
 * Host, which is why the browser half needs no copy of the pricing rules.
 */
export function toPublicConfig(config, year) {
  const holidayYear = config.holidays[String(year)] === undefined ? null : year;
  return {
    timezone: config.timezone,
    peakWindows: config.peakWindows.map((window) => ({ start: window.start, end: window.end })),
    peakDays: config.peakDays.slice(),
    peakMultiplier: config.peakMultiplier,
    holidays: (config.holidays[String(year)] ?? []).slice(),
    holidayYear,
    makeupWorkdays: (config.makeupWorkdays[String(year)] ?? []).slice(),
    countMakeupAsPeak: config.countMakeupAsPeak,
    showCost: config.showCost,
    note: config.note,
  };
}
