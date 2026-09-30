/**
 * dsh-quota-card — platform account history (opt-in "all time" figures).
 *
 * DeepSeek publishes NO lifetime-spend API. The only place that number exists is
 * the platform console, which is served by UNDOCUMENTED private endpoints:
 *
 *   GET https://platform.deepseek.com/api/v0/usage/cost?month=M&year=Y
 *   GET https://platform.deepseek.com/api/v0/usage/amount?month=M&year=Y
 *
 * Authenticated with the *console session token* (`userToken`) — the platform
 * grant DSH already stores — NOT with the inference API key. They carry no SLA
 * and may change without notice, which is why every consumer of this module
 * degrades to the local ledger instead of failing.
 *
 * Nothing in here is on the model-call path, and no token ever leaves the Host.
 */

/** Documented shape is `data.biz_data[0]`; tolerate an array or a bare object. */
function costRecord(payload) {
  const biz = payload?.data?.biz_data;
  if (Array.isArray(biz)) return biz[0] ?? {};
  if (biz !== null && typeof biz === 'object') return biz;
  return {};
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Pull `https://platform.deepseek.com`'s console token out of the DSH credential
 * file (a small block-structured YAML doc).
 *
 * The read is deliberately narrow: a line is only accepted when the indent stack
 * says it sits at `records → deepseek-account-platform/… → payload → token`. That
 * is what keeps the inference API key in the sibling `refs:` block from ever
 * being mistaken for the platform session token.
 *
 * Format notes, all learned from the real file: a `payload:` container is often
 * followed by an inline `kind: grant` at the SAME indent, and values may be bare
 * scalars or single/double quoted. An earlier implementation compared indents
 * instead of tracking the path, and silently skipped the token because of it.
 *
 * Pure: the `DEEPSEEK_USER_TOKEN` override is applied by the caller.
 *
 * @param {string} text raw contents of `$DSH_HOME/.credentials.yaml`.
 * @returns {string|null} the token, or null when the file does not hold one.
 */
export function parsePlatformToken(text) {
  if (typeof text !== 'string' || text === '') return null;
  const stack = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    const keyMatch = /^(\s*)([^:\s][^:]*):(.*)$/.exec(raw);
    if (keyMatch === null) continue;
    const indent = keyMatch[1].replace(/\t/g, '  ').length;
    const key = keyMatch[2].trim();
    const value = keyMatch[3].trim();
    while (stack.length > 0 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack.length === 0 ? null : stack[stack.length - 1].key;
    if (value === '') {
      stack.push({ indent, key });
      continue;
    }
    if (
      key === 'token'
      && parent === 'payload'
      && (stack.length >= 2 && String(stack[stack.length - 2].key).startsWith('deepseek-account-platform/'))
    ) {
      const quoted = /^(['"])([\s\S]*)\1$/.exec(value);
      const resolved = (quoted === null ? value : quoted[2]).trim();
      if (resolved !== '') return resolved;
    }
  }
  return null;
}

/**
 * Headers the console itself sends; the endpoint rejects requests without them.
 * The token is sensitive — only ever hand these headers to the platform origin,
 * and never into a response body or a log line.
 */
export function platformRequestHeaders(token, userAgent, referer) {
  return {
    accept: 'application/json',
    authorization: 'Bearer ' + token,
    'user-agent': userAgent,
    referer: referer ?? 'https://platform.deepseek.com/usage',
  };
}

/**
 * Does this payload say "your session is not valid" rather than "no data"?
 * The console answers 200 with `{ code: 40002 }` for a missing/expired token.
 */
export function platformAuthFailure(status, payload) {
  if (status === 401 || status === 403) return true;
  const code = payload?.code;
  if (code === 40002 || code === 40003) return true;
  const bizCode = payload?.data?.biz_code;
  return bizCode === 40002 || bizCode === 40003;
}

/**
 * One month of cost rows -> CNY total plus a per-model split.
 * `REQUEST` entries carry a request count, not money, and are excluded.
 */
export function sumMonthCost(payload) {
  const record = costRecord(payload);
  let cost = 0;
  const byModel = {};
  for (const group of Array.isArray(record.total) ? record.total : []) {
    let groupCost = 0;
    for (const entry of Array.isArray(group?.usage) ? group.usage : []) {
      if (String(entry?.type ?? '') === 'REQUEST') continue;
      groupCost += num(entry?.amount);
    }
    cost += groupCost;
    const model = typeof group?.model === 'string' ? group.model : 'unknown';
    byModel[model] = (byModel[model] ?? 0) + groupCost;
  }
  return { cost, byModel, currency: typeof record.currency === 'string' ? record.currency : 'CNY' };
}

/** One month of amount rows -> tokens, request count, and the cache split. */
export function sumMonthTokens(payload) {
  const record = payload?.data?.biz_data;
  const source = Array.isArray(record) ? record[0] ?? {} : (record ?? {});
  const byModel = {};
  const byType = {};
  let tokens = 0;
  let requests = 0;
  for (const group of Array.isArray(source.total) ? source.total : []) {
    let groupTokens = 0;
    for (const entry of Array.isArray(group?.usage) ? group.usage : []) {
      const type = String(entry?.type ?? '');
      const amount = num(entry?.amount);
      if (type === 'REQUEST') {
        requests += amount;
        continue;
      }
      tokens += amount;
      groupTokens += amount;
      byType[type] = (byType[type] ?? 0) + amount;
    }
    const model = typeof group?.model === 'string' ? group.model : 'unknown';
    byModel[model] = (byModel[model] ?? 0) + groupTokens;
  }
  // Cache reads are about 98% of the raw sum and are billed at roughly 2% of the
  // cache-miss rate. Reporting the raw sum alone would badly overstate what the
  // account actually processed for money, so both are kept: `tokens` is the raw
  // total and `billed` is what is charged.
  //
  // `billed` is built by ADDING the billed types, never by subtracting the cache
  // reads from the total. The subtraction form silently depends on "cache reads
  // are the bulk", so any other token type in the payload — the console does
  // report a `PROMPT_TOKEN` bucket — would be swept into the billed figure
  // unnoticed. Adding the known-billed types makes that impossible.
  //
  // Official rule: an input token is either a cache hit or a cache miss; the
  // miss rate also covers the fresh input that produces the cache entry.
  const cacheHits = byType.PROMPT_CACHE_HIT_TOKEN ?? 0;
  let billed = 0;
  for (const [type, amount] of Object.entries(byType)) {
    if (type === 'PROMPT_CACHE_HIT_TOKEN') continue;
    billed += amount;
  }
  return {
    tokens,
    billed,
    cacheHits,
    requests,
    byModel,
    byType,
  };
}

/**
 * Fold one month's two payloads into the facts the card reports. Either payload
 * may be null (one endpoint can fail on its own).
 */
export function aggregatePlatformUsage(costPayload, amountPayload, window, extra) {
  const hasCost = costPayload !== null && costPayload !== undefined;
  const hasAmount = amountPayload !== null && amountPayload !== undefined;
  if (!hasCost && !hasAmount) return null;
  const cost = hasCost ? sumMonthCost(costPayload) : { cost: 0, byModel: {}, currency: 'CNY' };
  const tokens = hasAmount
    ? sumMonthTokens(amountPayload)
    : { tokens: 0, billed: 0, cacheHits: 0, requests: 0, byModel: {}, byType: {} };
  const month = String(window.year) + '-' + String(window.month).padStart(2, '0');
  return {
    month,
    cost: cost.cost,
    currency: cost.currency,
    tokens: tokens.tokens,
    billed: tokens.billed,
    cacheHits: tokens.cacheHits,
    requests: tokens.requests,
    byType: tokens.byType,
    byModel: { ...cost.byModel, ...tokens.byModel },
    ...(extra ?? {}),
  };
}

/** Add `months` (newest first) into the lifetime view the card renders. */
export function foldMonths(months) {
  let cost = 0;
  let tokens = 0;
  let billed = 0;
  let cacheHits = 0;
  let requests = 0;
  let currency = 'CNY';
  const byModel = {};
  let newest = null;
  let oldest = null;
  for (const entry of months ?? []) {
    cost += entry.cost;
    tokens += entry.tokens;
    billed += entry.billed ?? entry.tokens;
    cacheHits += entry.cacheHits ?? 0;
    requests += entry.requests;
    currency = entry.currency || currency;
    for (const [model, value] of Object.entries(entry.byModel ?? {})) {
      byModel[model] = (byModel[model] ?? 0) + value;
    }
    if (newest === null || entry.month > newest) newest = entry.month;
    if (oldest === null || entry.month < oldest) oldest = entry.month;
  }
  return {
    cost,
    tokens,
    billed,
    cacheHits,
    requests,
    currency,
    byModel,
    newestMonth: newest,
    oldestMonth: oldest,
    months: (months ?? []).length,
  };
}

// ── the host-facing half: credentials, HTTP, and the month walk ──────────────

export const COST_URL = 'https://platform.deepseek.com/api/v0/usage/cost';
export const AMOUNT_URL = 'https://platform.deepseek.com/api/v0/usage/amount';

/** The console rejects requests without a browser-shaped UA and a referer. */
export const PLATFORM_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';

export const PLATFORM_REFERER = 'https://platform.deepseek.com/usage';

/** Stop the backward walk after this many consecutive empty months. */
const EMPTY_MONTH_STREAK = 3;

/** Hard cap on `from`/`to`, whatever the config says. */
export const MAX_SCAN_MONTHS = 120;

/** Upper bound for a pasted credential; the real token is 64 chars. */
export const MAX_TOKEN_LENGTH = 4096;

/** `{ year, month }` shifted by whole months (month is 1-12). */
export function shiftMonth(cursor, delta) {
  const index = cursor.year * 12 + (cursor.month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** Newest first list of `{ year, month }` covering `count` months ending at `from`. */
export function monthRange(from, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(shiftMonth(from, -i));
  return out;
}

/** `{ year, month }` -> `"YYYY-MM"`. */
export function monthKey(cursor) {
  return String(cursor.year) + '-' + String(cursor.month).padStart(2, '0');
}

/**
 * Whether a pasted value can possibly be a console session token. It rejects the
 * mistakes that actually happen — a placeholder left in place, a whole command
 * line, a multi-line paste — instead of silently storing them and letting every
 * later scan fail with a confusing auth error.
 *
 * Deliberately permissive on the charset: the credential is undocumented, so the
 * check must not reject a future format.
 */
export function tokenLooksValid(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (text.length < 16 || text.length > MAX_TOKEN_LENGTH) return false;
  return !/\s/.test(text);
}

/**
 * One month's cost + amount payloads, or null when neither answered.
 * `request` is injected so the caller owns retries, timeouts, and headers.
 * When both fail, the reason is attached so the caller can report WHY instead of
 * only counting that something went wrong.
 */
export async function fetchMonth(cursor, request) {
  const query = '?month=' + cursor.month + '&year=' + cursor.year;
  const failures = [];
  const attempt = async (url) => {
    try {
      return await request(url);
    } catch (error) {
      failures.push(String(error?.name ?? error?.message ?? error).slice(0, 40));
      return null;
    }
  };
  const [cost, amount] = await Promise.all([
    attempt(COST_URL + query),
    attempt(AMOUNT_URL + query),
  ]);
  if (cost === null && amount === null) {
    return { failed: true, kind: failures.length > 0 ? failures.join('+') : 'no-response' };
  }
  const facts = aggregatePlatformUsage(cost, amount, cursor, {});
  if (facts === null) return { failed: true, kind: 'no-facts' };
  if (cost === null || amount === null) {
    facts.partial = cost === null ? 'cost-missing' : 'amount-missing';
  }
  return facts;
}

/**
 * Walk backwards month by month and fold the months that HAVE usage.
 *
 * Empty months are never collected — they only advance the stop counter, so a
 * trailing run of idle months cannot pollute the totals or the reported
 * coverage range. `scanned` still counts them, so a caller can see how far the
 * walk actually went.
 *
 * @param {object} options
 * @param {{year:number,month:number}} options.from newest month to include.
 * @param {number} options.months how far back to look (capped by MAX_SCAN_MONTHS).
 * @param {(url: string) => Promise<unknown|null>} options.request
 * @param {(progress: object) => void} [options.onMonth] progress callback.
 * @returns {Promise<{total: object, months: object[], stoppedBy: string, failures: object[]}>}
 */
export async function scanHistory(options) {
  const months = Math.min(Math.max(1, Number(options.months) || 1), MAX_SCAN_MONTHS);
  const collected = [];
  const failures = [];
  let emptyRun = 0;
  let stoppedBy = 'range-exhausted';
  let scanned = 0;
  for (const cursor of monthRange(options.from, months)) {
    const facts = await fetchMonth(cursor, options.request);
    scanned += 1;
    if (facts === null || facts.failed === true) {
      failures.push({ month: monthKey(cursor), kind: facts === null ? 'no-response' : facts.kind });
      stoppedBy = 'request-failed';
      break;
    }
    const empty = facts.cost === 0 && facts.tokens === 0 && facts.requests === 0;
    if (empty) {
      emptyRun += 1;
      // Stop after a run of empty months, but never report a failure as a
      // finding: if nothing was found at all, the walk simply reached its cap.
      if (emptyRun >= EMPTY_MONTH_STREAK) {
        stoppedBy = collected.length > 0 ? 'empty-streak' : 'all-empty';
        break;
      }
    } else {
      emptyRun = 0;
      collected.push(facts);
    }
    if (typeof options.onMonth === 'function') options.onMonth({ cursor, facts, scanned });
  }
  const total = foldMonths(collected);
  total.scanned = scanned;
  total.stoppedBy = stoppedBy;
  total.failureCount = failures.length;
  total.lastFailure = failures.length === 0 ? null : failures[failures.length - 1];
  return { total, months: collected, stoppedBy, failures };
}

/** Which numeric fields a persisted history must carry to be reusable as-is. */
const PAYLOAD_FIELDS = ['months', 'cost', 'tokens', 'billed', 'cacheHits', 'requests'];

/**
 * Is this persisted payload still in the shape the current code produces?
 *
 * A cache file written by an older release can lack fields a newer one relies
 * on — a seeded payload missing `billed` would silently render a raw token total
 * as if it were the billed figure. Rejecting an outdated payload makes the next
 * refresh scan again instead of trusting stale semantics.
 */
export function historyPayloadComplete(payload) {
  if (payload === null || payload === undefined || typeof payload !== 'object') return false;
  if (!Number.isFinite(payload.scannedAt)) return false;
  for (const field of PAYLOAD_FIELDS) {
    if (!Number.isFinite(payload[field])) return false;
  }
  return true;
}

/**
 * Build the platform-history reader the Host mounts.
 *
 * Everything it needs is injected so it stays testable and so the Host keeps
 * ownership of credentials (never the browser, never a log line).
 *
 * @param {object} options
 * @param {() => Promise<string|null>} options.resolveToken
 * @param {(url: string) => Promise<unknown|null>} options.request
 * @param {number} options.months how far back to scan.
 * @param {number} options.ttlMs how long a scan stays fresh.
 * @param {() => number} [options.now]
 * @param {(message: string, error?: unknown) => void} [options.onError]
 */
export function createPlatformHistory(options) {
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : 10 * 60_000;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const onError = typeof options.onError === 'function' ? options.onError : () => {};

  /** @type {{payload: object, at: number}|null} */
  let cache = null;
  let inflight = null;
  const counters = {
    scans: 0,
    failures: 0,
    monthsFetched: 0,
    requestFailures: 0,
    refusedSeed: 0,
    lastError: '',
    lastFailure: null,
    tokenMissing: 0,
  };

  function snapshotPayload() {
    if (cache === null) return null;
    return { ...cache.payload, cachedAt: cache.at, fresh: now() - cache.at < ttlMs };
  }

  async function runScan(reason) {
    counters.scans += 1;
    try {
      const token = await options.resolveToken();
      if (token === null || token === '') {
        counters.tokenMissing += 1;
        counters.lastError = 'no-platform-token';
        return null;
      }
      let authFailed = false;
      let httpError = '';
      const headers = platformRequestHeaders(token, PLATFORM_USER_AGENT, PLATFORM_REFERER);
      const request = async (url) => {
        const response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
        const text = await response.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          counters.requestFailures += 1;
          return null;
        }
        if (platformAuthFailure(response.status, json)) {
          authFailed = true;
          counters.requestFailures += 1;
          return null;
        }
        if (!response.ok || json.code !== 0) {
          httpError = 'http-' + response.status;
          counters.requestFailures += 1;
          return null;
        }
        return json;
      };
      const current = new Date();
      const { total, failures } = await scanHistory({
        from: { year: current.getFullYear(), month: current.getMonth() + 1 },
        months: options.months,
        request,
        onMonth: () => {
          counters.monthsFetched += 1;
        },
      });
      // Name the reason precisely: a bare counter cannot tell a signed-out token
      // from a rate limit from a network drop, which is exactly what the user
      // needs when a scan comes back short.
      if (authFailed) counters.lastError = 'auth-failed';
      else if (httpError !== '') counters.lastError = httpError;
      else if (failures.length > 0) counters.lastError = 'failed:' + failures[0].month + ':' + failures[0].kind;
      if (failures.length > 0) {
        counters.lastFailure = failures[failures.length - 1];
        counters.failures += failures.length;
      }
      if (total.months === 0) {
        if (counters.lastError === '') counters.lastError = 'no-usage-returned';
        return null;
      }
      const payload = {
        ...total,
        stoppedBy: total.stoppedBy,
        source: 'platform',
        scannedAt: now(),
        reason: reason ?? 'scheduled',
      };
      cache = { payload, at: now() };
      if (counters.lastError.startsWith('no-')) counters.lastError = '';
      return payload;
    } catch (error) {
      counters.failures += 1;
      counters.lastError = String(error?.message ?? error).slice(0, 160);
      onError('quota-card: platform history scan failed', error);
      return null;
    }
  }

  return {
    /** The cached payload, or null when nothing usable has been scanned. */
    current: snapshotPayload,
    /** Scan if stale; concurrent callers share one scan. Never rejects. */
    refresh(reason) {
      if (inflight !== null) return inflight;
      if (cache !== null && now() - cache.at < ttlMs) return Promise.resolve(snapshotPayload());
      inflight = runScan(reason).finally(() => {
        inflight = null;
      });
      return inflight;
    },
    /**
     * Load a persisted payload written by an earlier process. A payload from an
     * older schema is refused (and dropped) so the next refresh rescans rather
     * than serving fields that no longer mean what the code assumes.
     */
    seed(payload) {
      if (!historyPayloadComplete(payload)) {
        if (payload !== null && payload !== undefined) counters.refusedSeed += 1;
        return false;
      }
      cache = { payload, at: payload.scannedAt };
      return true;
    },
    /** Drop the cache so the next `refresh` scans again (a new credential). */
    invalidate() {
      cache = null;
    },
    diagnostics() {
      return {
        ...counters,
        cached: cache !== null,
        cachedAt: cache === null ? null : cache.at,
        months: cache === null ? 0 : (cache.payload.months ?? 0),
        billedTokens: cache === null ? 0 : (cache.payload.billed ?? 0),
        rawTokens: cache === null ? 0 : (cache.payload.tokens ?? 0),
      };
    },
  };
}
