/**
 * dsh-quota-card — usage ledger.
 *
 * Records provider-reported token usage per Beijing calendar day, per model, and
 * per price tier, then serves the "today" and "this month" views.
 *
 * Why a ledger instead of re-reading session logs: DeepSeek publishes no usage
 * API, and DSH session logs are multi-frame zstd that would both duplicate this
 * live tap and cost a decompressor. The tradeoff is explicit and documented in
 * the README — history starts when the plugin is installed.
 *
 * Durability is best-effort by design: a failed write degrades to an in-memory
 * ledger and never throws into the Host's model-call path.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  addTotals,
  cacheHitRate,
  emptyTotals,
  estimateCost,
  resolveTier,
  totalTokens,
  zoneDateString,
  zoneMonthString,
  zoneParts,
} from './pricing.js';

/** Keep this many days; older buckets are dropped on load and on flush. */
const MAX_DAYS = 400;

/** Above this file size we stop growing the ledger and keep only 90 days. */
const MAX_BYTES = 4 * 1024 * 1024;

/** Minimum spacing between two writes. */
const FLUSH_INTERVAL_MS = 5000;

const TIERS = ['peak', 'offPeak'];

/** `$DSH_HOME` or `~/.dsh`, matching the rest of the Harness. */
export function dshHome(env = process.env) {
  const configured = env && typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return configured === '' ? join(homedir(), '.dsh') : configured;
}

/** Default ledger path. */
export function defaultLedgerPath(env = process.env) {
  return join(dshHome(env), 'quota-card', 'usage.json');
}

function emptyModelTotals() {
  return { peak: emptyTotals(), offPeak: emptyTotals() };
}

/**
 * Fold one day loaded from disk onto one day already in memory, keeping BOTH
 * tiers, BOTH purpose rows, and both request counts. Records can land before
 * the initial read settles (the Host does not await the load), and those
 * in-memory records must survive the merge. The file's records and the
 * in-memory records for the same day are disjoint sets (each record is counted
 * exactly once), so every counter is summed.
 */
function mergeDay(base, incoming) {
  const out = base ?? { models: {}, byPurpose: {} };
  if (incoming === null || incoming === undefined || typeof incoming !== 'object') return out;
  out.models = out.models ?? {};
  out.byPurpose = out.byPurpose ?? {};
  for (const [model, totals] of Object.entries(incoming.models ?? {})) {
    const live = out.models[model];
    out.models[model] = live === undefined
      ? totals
      : {
        peak: addTotals(live.peak, totals?.peak),
        offPeak: addTotals(live.offPeak, totals?.offPeak),
      };
  }
  for (const [purpose, totals] of Object.entries(incoming.byPurpose ?? {})) {
    out.byPurpose[purpose] = addTotals(out.byPurpose[purpose], totals);
  }
  return out;
}

/**
 * Create a ledger bound to one resolved config.
 *
 * @param {object} options
 * @param {object} options.config normalized config (see `lib/config.js`).
 * @param {string} [options.filePath] ledger path; defaults under `$DSH_HOME`.
 * @param {() => number} [options.now] clock injection for tests.
 * @param {(message: string, error?: unknown) => void} [options.onError]
 * @returns {object} the ledger handle.
 */
export function createLedger(options) {
  const config = options?.config ?? {};
  const filePath = typeof options?.filePath === 'string' && options.filePath !== ''
    ? options.filePath
    : defaultLedgerPath(options?.env);
  const now = typeof options?.now === 'function' ? options.now : () => Date.now();
  const onError = typeof options?.onError === 'function' ? options.onError : () => {};

  /**
   * The in-memory ledger. Shape:
   *   { version, days: { "YYYY-MM-DD": { models: { [model]: { peak, offPeak } }, byPurpose: { [purpose]: totals } } } }
   */
  const state = { version: 1, days: {} };
  /**
   * `degraded` records that a read or a write failed at some point (and why it
   * is worth looking at `/quota-card/health`); `recovered` records that a write
   * has succeeded since. Together they distinguish "broken" from "was broken".
   */
  const counters = {
    recorded: 0,
    flushes: 0,
    errors: 0,
    loaded: false,
    degraded: false,
    recovered: false,
    quarantined: false,
    writeBlocked: false,
  };
  let lastFlushAt = 0;
  let writing = null;
  let loading = null;
  let loadSettled = false;
  let dirty = false;
  let capReached = false;
  let trailing = null;

  function noteError(message, error) {
    counters.errors += 1;
    try {
      onError(message, error);
    } catch {
      /* an error reporter must never throw */
    }
  }

  /** Drop days that are too old, or everything but the last 90 when capped. */
  function prune(atMs) {
    const cutoff = zoneDateString(atMs - (capReached ? 90 : MAX_DAYS) * 86_400_000, config.timezone);
    for (const day of Object.keys(state.days)) if (day < cutoff) delete state.days[day];
  }

  /**
   * Load once and remember the promise. A record that lands before the load
   * settles must not write an empty ledger over the previous file, so `write`
   * waits on this.
   */
  function ensureLoaded() {
    if (loading === null) {
      loading = load().finally(() => {
        loadSettled = true;
      });
    }
    return loading;
  }

  async function load() {
    try {
      const text = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object' && parsed.days !== null && typeof parsed.days === 'object') {
        // MERGE, never replace: a `record()` can land while this read is in
        // flight, and replacing the map would silently drop it.
        for (const [date, day] of Object.entries(parsed.days)) {
          state.days[date] = mergeDay(state.days[date], day);
        }
        counters.loaded = true;
        prune(now());
      } else {
        throw new Error('unexpected ledger shape');
      }
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
        counters.loaded = true; // first run: an empty ledger is the correct state
        return;
      }
      noteError('quota-card: ledger unreadable, starting from an empty ledger', error);
      counters.degraded = true;
      // Do NOT clear `state.days`: records that landed while this read was in
      // flight were never in the unreadable file, so they must survive.
      try {
        // Preserve the unreadable file instead of overwriting evidence.
        await rename(filePath, filePath + '.corrupt-' + Date.now());
        counters.quarantined = true;
      } catch (renameError) {
        // Without a quarantine we cannot tell "empty" from "unreadable", so
        // refuse to write rather than risk persisting an empty ledger over a
        // real one. In-memory numbers keep working.
        counters.writeBlocked = true;
        noteError('quota-card: could not quarantine the unreadable ledger; writes are disabled', renameError);
      }
    }
  }

  async function write() {
    // The previous ledger could be neither read nor quarantined, so a write now
    // could destroy real data. Stay in memory instead.
    if (counters.writeBlocked) return;
    const payload = {
      version: 1,
      updatedAt: now(),
      note: 'dsh-quota-card usage ledger — token counts reported by the provider, bucketed by Beijing calendar day.',
      days: state.days,
    };
    const text = JSON.stringify(payload);
    try {
      await mkdir(join(filePath, '..'), { recursive: true });
      const temporary = filePath + '.tmp';
      await writeFile(temporary, text, 'utf8');
      await rename(temporary, filePath); // atomic on the same volume
      counters.flushes += 1;
      dirty = false;
      if (counters.degraded) counters.recovered = true;
      if (text.length > MAX_BYTES) {
        capReached = true;
        prune(now());
      }
    } catch (error) {
      noteError('quota-card: ledger write failed; continuing in memory', error);
      counters.degraded = true;
    }
  }

  /** Serialize writes so two flushes can never interleave. */
  function scheduleFlush(force) {
    const at = now();
    if (!force && at - lastFlushAt < FLUSH_INTERVAL_MS) {
      // Throttled: remember that data is pending and make sure a trailing flush
      // actually happens, so a burst of activity followed by silence still
      // persists instead of waiting for the next record or for dispose.
      dirty = true;
      if (trailing === null) {
        trailing = setTimeout(() => {
          trailing = null;
          scheduleFlush(true);
        }, FLUSH_INTERVAL_MS);
        if (typeof trailing.unref === 'function') trailing.unref();
      }
      return writing ?? Promise.resolve();
    }
    lastFlushAt = at;
    const previous = writing ?? Promise.resolve();
    writing = previous
      .then(() => ensureLoaded())
      .then(() => write())
      .catch((error) => noteError('quota-card: flush failed', error));
    return writing;
  }

  /**
   * Record one provider-reported usage block.
   * @param {{at?: number, model?: string, usage?: object, purpose?: string}} input
   * @returns {boolean} true when a bucket was updated.
   */
  function record(input) {
    const usage = input?.usage;
    if (usage === null || usage === undefined || typeof usage !== 'object') return false;
    const at = Number.isFinite(input.at) ? input.at : now();
    const date = zoneDateString(at, config.timezone);
    const tier = resolveTier(at, config).peak ? 'peak' : 'offPeak';
    const model = typeof input.model === 'string' && input.model !== '' ? input.model : 'unknown';
    const day = state.days[date] ?? { models: {}, byPurpose: {} };
    const modelTotals = day.models[model] ?? emptyModelTotals();
    const delta = {
      inputTokens: toCount(usage.inputTokens),
      cacheReadTokens: toCount(usage.cacheReadTokens),
      cacheWriteTokens: toCount(usage.cacheWriteTokens),
      outputTokens: toCount(usage.outputTokens),
      requests: 1,
    };
    modelTotals[tier] = addTotals(modelTotals[tier], delta);
    day.models[model] = modelTotals;
    const purpose = typeof input.purpose === 'string' && input.purpose !== '' ? input.purpose : 'conversation';
    day.byPurpose[purpose] = addTotals(day.byPurpose[purpose], delta);
    state.days[date] = day;
    counters.recorded += 1;
    dirty = true;
    scheduleFlush(false);
    return true;
  }

  function toCount(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }

  /** Fold one day's buckets into a single totals object per tier. */
  function dayTotals(day) {
    const out = { peak: emptyTotals(), offPeak: emptyTotals() };
    if (day === undefined) return out;
    for (const modelTotals of Object.values(day.models ?? {})) {
      for (const tier of TIERS) out[tier] = addTotals(out[tier], modelTotals[tier]);
    }
    return out;
  }

  /** Every `{model, tier, totals}` entry of one day, for the cost estimate. */
  function dayEntries(day) {
    const entries = [];
    if (day === undefined) return entries;
    for (const [model, modelTotals] of Object.entries(day.models ?? {})) {
      for (const tier of TIERS) {
        const totals = modelTotals[tier];
        if (totals !== undefined && totalTokens(totals) > 0) entries.push({ model, tier, totals });
      }
    }
    return entries;
  }

  /** Combine the two tier totals of one bucket into a single total. */
  function combine(perTier) {
    return addTotals(perTier.peak, perTier.offPeak);
  }

  function entriesOf(day) {
    return dayEntries(day);
  }

  /** Fold a set of `{model, tier, totals}` entries into per-tier totals. */
  function foldEntries(entries) {
    const perTier = { peak: emptyTotals(), offPeak: emptyTotals() };
    for (const entry of entries) {
      if (entry.tier === 'peak') perTier.peak = addTotals(perTier.peak, entry.totals);
      else perTier.offPeak = addTotals(perTier.offPeak, entry.totals);
    }
    return perTier;
  }

  function summarize(perTier, entries) {
    const totals = combine(perTier);
    const cost = estimateCost(entries, config);
    return {
      tokens: totalTokens(totals),
      totals,
      peak: totalTokens(perTier.peak),
      offPeak: totalTokens(perTier.offPeak),
      cacheHitRate: cacheHitRate(totals),
      cost: cost.total,
      costApproximate: cost.approximate,
    };
  }

  /** Today's view (Beijing calendar day). */
  function today(atMs = now()) {
    const date = zoneDateString(atMs, config.timezone);
    const day = state.days[date];
    return { date, ...summarize(dayTotals(day), entriesOf(day)) };
  }

  /** This month's view (Beijing calendar month), summed from the daily buckets. */
  function month(atMs = now()) {
    const monthKey = zoneMonthString(atMs, config.timezone);
    const entries = [];
    let days = 0;
    for (const [date, day] of Object.entries(state.days)) {
      if (!date.startsWith(monthKey)) continue;
      days += 1;
      entries.push(...entriesOf(day));
    }
    const summary = summarize(foldEntries(entries), entries);
    summary.days = days;
    return { month: monthKey, ...summary };
  }

  /**
   * Everything this ledger has ever recorded, plus the day range it covers.
   * That range is the honest caveat: this counts from the day the plugin was
   * installed, NOT since the account was created — lifetime history only exists
   * in the console, see `lib/platform.js`.
   */
  function lifetime() {
    const entries = [];
    let days = 0;
    let from = null;
    let to = null;
    for (const [date, day] of Object.entries(state.days)) {
      days += 1;
      if (from === null || date < from) from = date;
      if (to === null || date > to) to = date;
      entries.push(...entriesOf(day));
    }
    const summary = summarize(foldEntries(entries), entries);
    summary.days = days;
    summary.from = from;
    summary.to = to;
    return summary;
  }

  /** Diagnostics for `GET /quota-card/health`. */
  function diagnostics() {
    const parts = zoneParts(now(), config.timezone);
    return {
      ...counters,
      // `dayCount` (not `days`) so the spread counters above cannot mask it.
      dayCount: Object.keys(state.days).length,
      tiers: TIERS.slice(),
      zone: config.timezone,
      zoneDate: parts.date,
      maxDays: MAX_DAYS,
      capped: capReached,
    };
  }

  return {
    filePath,
    /** Idempotent: the first call performs the read, later calls reuse it. */
    load: ensureLoaded,
    record,
    today,
    month,
    lifetime,
    diagnostics,
    /** Drop stale buckets and persist immediately (used on dispose). */
    async flush() {
      if (trailing !== null) {
        clearTimeout(trailing);
        trailing = null;
      }
      await ensureLoaded().catch(() => undefined);
      prune(now());
      if (!dirty && counters.flushes > 0) return;
      await scheduleFlush(true);
    },
    /** Test hook: whether the initial read has settled. */
    loaded: () => loadSettled,
  };
}
