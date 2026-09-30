/**
 * dsh-quota-card — Host half.
 *
 * Responsibilities:
 *   1. Tap `llm/stream` and record every provider-reported `usage` block into a
 *      per-day / per-model / per-tier ledger (`lib/ledger.js`).
 *   2. Proxy the official DeepSeek balance API, keeping the credential on this
 *      side: the browser never sees the API key.
 *   3. Serve both to the browser half over two read-only HTTP routes.
 *
 * Hard rules (they are what keeps a third-party plugin from breaking the Host):
 *   - NO third-party imports. Only `node:` builtins and this package's own pure
 *     modules, so module resolution never depends on the profile layout.
 *   - Every optional service is reached through a SOFT probe
 *     (`ctx.inject([name], child => …)`), never a hard inject: a composition
 *     without a web server must still boot this entry.
 *   - Nothing in the model-call path may throw. The usage tap logs and moves on.
 */

import { normalizeConfig, toPublicConfig } from './config.js';
import { createLedger } from './ledger.js';
import { resolveTier, zoneParts } from './pricing.js';

/** Cordis plugin name (also the ledger namespace and the route prefix). */
export const name = 'quota-card';

const ROUTE_SNAPSHOT = '/quota-card/snapshot';
const ROUTE_HEALTH = '/quota-card/health';

/** Cached snapshot staleness. The snapshot itself is cheap; this only avoids
 * recomputing the month fold for several polls within the same second. */
const SNAPSHOT_TTL_MS = 1000;

/** Never wait longer than this for the balance API. */
const BALANCE_TIMEOUT_MS = 10_000;

/**
 * Cordis entry point.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} rawConfig the `config` object of this plugin's patch row.
 */
export function apply(ctx, rawConfig) {
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.inject !== 'function') return;

  // Year used to attribute bare `MM-DD` config date entries. It must be read
  // BEFORE the config exists, so it uses the default zone; a configured zone
  // that differs by a whole year for a few hours a day is not a real case, and
  // the tier checks re-derive the year from `config.timezone` every call.
  const startYear = zoneParts(Date.now(), 'Asia/Shanghai').year;
  const config = normalizeConfig(rawConfig, startYear);
  const ledger = createLedger({
    config,
    env: process.env,
    onError: (message, error) => console.error(message, error),
  });

  /** Counters surfaced by `GET /quota-card/health`. */
  const counters = {
    taps: 0,
    usageBlocks: 0,
    balanceFetches: 0,
    balanceServedFromCache: 0,
    balanceFailures: 0,
    balanceFromAccount: 0,
    balanceFromKey: 0,
    snapshotReads: 0,
  };
  let snapshotCache = null;
  /** The `deepseekAccount` service, when this composition ships it. */
  let account = null;
  const accountState = { probe: 'pending', lastError: '' };

  // The account seam is a SOFT probe: a profile without it keeps full balance
  // support through DEEPSEEK_API_KEY, and the entry still activates cleanly.
  ctx.inject(['deepseekAccount'], (child) => {
    account = child.deepseekAccount ?? null;
    accountState.probe = account === null ? 'missing' : 'present';
  });

  // ── usage tap ───────────────────────────────────────────────────────────────

  const tap = async function* usageTap(options, next) {
    counters.taps += 1;
    const stream = next();
    for await (const chunk of stream) {
      try {
        if (chunk !== null && typeof chunk === 'object' && chunk.type === 'usage') {
          counters.usageBlocks += 1;
          ledger.record({
            at: Date.now(),
            model: options?.model,
            usage: chunk.usage,
            purpose: options?.purpose,
          });
        }
      } catch (error) {
        // A ledger failure must never break or truncate the model stream.
        console.error('quota-card: usage recording failed', error);
      }
      yield chunk;
    }
  };

  ctx.inject(['llm'], (child) => {
    if (typeof child.on !== 'function' || typeof child.effect !== 'function') return;
    child.effect(
      () => child.on('llm/stream', tap),
      'quota-card: provider-usage tap',
    );
  });

  // ── balance ─────────────────────────────────────────────────────────────────

  function apiKey() {
    const value = process.env?.DEEPSEEK_API_KEY;
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
  }

  function pickNumber(source, key) {
    const value = Number(source?.[key]);
    return Number.isFinite(value) ? value : undefined;
  }

  /** Client identity the account seam expects for a balance query. */
  function accountClient() {
    const offset = -new Date().getTimezoneOffset() * 60;
    return {
      version: config.clientVersion,
      locale: config.locale,
      timezoneOffsetSeconds: Number.isFinite(offset) ? offset : 0,
    };
  }

  function pickWallet(wallets, key) {
    const list = Array.isArray(wallets) ? wallets : [];
    let chosen;
    for (const wallet of list) {
      if (String(wallet?.currency ?? '').toUpperCase() === 'CNY') {
        chosen = wallet;
        break;
      }
      if (chosen === undefined) chosen = wallet;
    }
    if (chosen === undefined) return { balance: undefined, currency: 'CNY' };
    const amount = Number(chosen[key] ?? chosen.balance);
    return {
      balance: Number.isFinite(amount) ? amount : undefined,
      currency: String(chosen.currency ?? 'CNY').toUpperCase(),
    };
  }

  /** One provider response -> the balance object the card renders, or an error tag. */
  function shapeBalance(payload) {
    const infos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : [];
    let chosen;
    for (const info of infos) {
      if (String(info?.currency ?? '').toUpperCase() === 'CNY') {
        chosen = info;
        break;
      }
      if (chosen === undefined) chosen = info;
    }
    if (chosen === undefined) {
      const flat = pickNumber(payload, 'total_balance') ?? pickNumber(payload, 'balance');
      if (flat === undefined) return { error: 'unexpected-response' };
      return {
        currency: String(payload?.currency ?? 'CNY').toUpperCase(),
        balance: flat,
        granted: undefined,
        toppedUp: undefined,
        available: payload?.is_available !== false,
      };
    }
    const balance = pickNumber(chosen, 'total_balance');
    if (balance === undefined) return { error: 'unexpected-response' };
    return {
      currency: String(chosen.currency ?? 'CNY').toUpperCase(),
      balance,
      granted: pickNumber(chosen, 'granted_balance'),
      toppedUp: pickNumber(chosen, 'topped_up_balance'),
      available: payload?.is_available !== false,
    };
  }

  /**
   * Signed-in balance through the official account seam. Preferred over the API
   * key because it needs no configuration and reuses the token the app already
   * holds.
   * @returns {Promise<object|null>} null when unavailable (no service, signed
   *   out, a failed query, or nothing usable in the response).
   */
  async function balanceFromAccount() {
    if (account === null || typeof account.getBalance !== 'function') return null;
    try {
      const result = await account.getBalance(accountClient());
      if (result === null || result === undefined) return null; // signed out
      if (result.status !== 'ready') return null; // the query itself failed
      const main = pickWallet(result.value, 'balance');
      const bonus = pickWallet(result.bonusWallets, 'balance');
      if (main.balance === undefined) return null;
      counters.balanceFromAccount += 1;
      return {
        currency: main.currency,
        balance: main.balance,
        granted: bonus.balance,
        toppedUp: undefined,
        available: true,
        source: 'account',
      };
    } catch (error) {
      // A missing/expired grant is not an error worth surfacing: fall through to
      // the API key, and only report it if that is missing too.
      accountState.lastError = String(error?.message ?? error).slice(0, 160);
      return null;
    }
  }

  /** Balance through the official public API with the environment API key. */
  async function balanceFromApiKey(key) {
    counters.balanceFetches += 1;
    counters.balanceFromKey += 1;
    try {
      const response = await fetch('https://api.deepseek.com/user/balance', {
        headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
        signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
      });
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        counters.balanceFailures += 1;
        return { error: 'bad-json', detail: text.slice(0, 120) };
      }
      if (!response.ok) {
        counters.balanceFailures += 1;
        const message = payload?.error?.message ?? payload?.error ?? String(response.status);
        return { error: 'http-' + response.status, detail: String(message).slice(0, 160) };
      }
      const shaped = shapeBalance(payload);
      if (shaped.error === undefined) shaped.source = 'api-key';
      else counters.balanceFailures += 1;
      return shaped;
    } catch (error) {
      counters.balanceFailures += 1;
      return { error: 'network', detail: String(error?.message ?? error).slice(0, 160) };
    }
  }

  /**
   * Signed-in first, API key second, and a precise reason when neither works.
   * `account-unavailable` means the account seam exists but has nothing to give
   * (signed out, or the grant expired) — the card tells the user to sign in.
   */
  async function readBalance() {
    const fromAccount = await balanceFromAccount();
    if (fromAccount !== null) return fromAccount;
    const key = apiKey();
    if (key !== '') return balanceFromApiKey(key);
    return {
      error: account === null ? 'no-credentials' : 'account-unavailable',
      detail: accountState.lastError,
    };
  }

  // ── snapshot ────────────────────────────────────────────────────────────────

  function snapshot(atMs) {
    const now = Number.isFinite(atMs) ? atMs : Date.now();
    const cached = snapshotCache;
    if (cached !== null && now - cached.at < SNAPSHOT_TTL_MS) return cached.value;
    const tier = resolveTier(now, config);
    const year = zoneParts(now, config.timezone).year;
    const value = {
      ok: true,
      now,
      source: 'dsh-quota-card',
      config: toPublicConfig(config, year),
      tier: {
        peak: tier.peak,
        label: tier.label,
        nextChangeAt: tier.nextChangeAt,
        holiday: tier.holiday,
        makeup: tier.makeup,
        date: tier.date,
      },
      usage: { today: ledger.today(now), month: ledger.month(now) },
      balanceSource: account === null
        ? (apiKey() === '' ? 'none' : 'api-key')
        : (accountState.probe === 'present' ? 'account' : 'none'),
    };
    snapshotCache = { at: now, value };
    return value;
  }

  // ── routes ──────────────────────────────────────────────────────────────────

  function corsHeaders(request) {
    const origin = request?.headers?.origin;
    if (typeof origin === 'string' && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)) {
      return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
    }
    return {};
  }

  function sendJson(request, response, status, body) {
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(request),
    };
    response.writeHead(status, headers);
    response.end(JSON.stringify(body));
  }

  let balanceCache = { at: 0, value: null };
  let balancePending = null;

  /** Serve the balance from a short-lived cache, with single-flight refresh. */
  function balanceCached() {
    const at = Date.now();
    if (balanceCache.value !== null && at - balanceCache.at < config.balancePollMs) {
      counters.balanceServedFromCache += 1;
      return Promise.resolve(balanceCache.value);
    }
    if (balancePending !== null) return balancePending;
    balancePending = readBalance().then(
      (result) => {
        balancePending = null;
        if (result.error === undefined) {
          balanceCache = { at: Date.now(), value: result };
          return result;
        }
        // Keep the last good value visible through a transient failure.
        return { ...result, stale: balanceCache.value };
      },
      (error) => {
        balancePending = null;
        return { error: 'internal', detail: String(error?.message ?? error) };
      },
    );
    return balancePending;
  }

  const routes = [
    {
      kind: 'exact',
      path: ROUTE_SNAPSHOT,
      handler: async (request, response) => {
        counters.snapshotReads += 1;
        try {
          const payload = snapshot(Date.now());
          // The balance is fetched on its own cadence and merged here so a slow
          // or failing DeepSeek call can never delay the local numbers.
          const balance = await balanceCached();
          sendJson(request, response, 200, { ...payload, balance });
        } catch (error) {
          sendJson(request, response, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTE_HEALTH,
      handler: (request, response) => {
        sendJson(request, response, 200, {
          ok: true,
          ledger: ledger.diagnostics(),
          path: ledger.filePath,
          counters,
          config: {
            timezone: config.timezone,
            peakWindows: config.peakWindows.map((window) => [window.start, window.end]),
            peakDays: config.peakDays,
            peakMultiplier: config.peakMultiplier,
            holidayYears: Object.keys(config.holidays),
            countMakeupAsPeak: config.countMakeupAsPeak,
            models: Object.keys(config.prices),
            balancePollMs: config.balancePollMs,
            clientVersion: config.clientVersion,
          },
          balance: {
            accountService: accountState.probe,
            hasApiKey: apiKey() !== '',
            lastAccountError: accountState.lastError,
          },
        });
      },
    },
  ];

  ctx.inject(['webServer'], (child) => {
    if (typeof child.effect !== 'function') return;
    for (const route of routes) {
      child.effect(
        () => child.webServer.register(route),
        'quota-card: route ' + route.path,
      );
    }
  });

  // ── lifecycle ───────────────────────────────────────────────────────────────

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      // Load the previous ledger now, then keep flushing while we run.
      ledger.load().then(
        () => undefined,
        (error) => console.error('quota-card: ledger load failed', error),
      );
      return () => {
        ledger.flush().catch((error) => console.error('quota-card: final flush failed', error));
      };
    }, 'quota-card: ledger');
  }
}

export default { apply, name };
