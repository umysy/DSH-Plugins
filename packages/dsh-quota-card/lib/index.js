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

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { normalizeConfig, toPublicConfig } from './config.js';
import { createLedger } from './ledger.js';
import { createPlatformHistory } from './platform.js';
import { resolveTier, zoneParts } from './pricing.js';

/** Cordis plugin name (also the ledger namespace and the route prefix). */
export const name = 'quota-card';

const ROUTE_SNAPSHOT = '/quota-card/snapshot';
const ROUTE_HEALTH = '/quota-card/health';
const ROUTE_TOKEN = '/quota-card/token';

/** Upper bound for a pasted credential; the real token is ~64 chars. */
const MAX_TOKEN_LENGTH = 4096;

/** Upper bound for a JSON request body, so a wrong request cannot allocate. */
const MAX_BODY_BYTES = 16 * 1024;

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
    tokenWrites: 0,
  };
  let snapshotCache = null;
  /** The `deepseekAccount` service, when this composition ships it. */
  let account = null;
  const accountState = { probe: 'pending', lastError: '' };
  /** The `credentials` service, when this composition ships it. */
  let credentials = null;
  const credentialState = { probe: 'pending' };

  // The account seam is a SOFT probe: a profile without it keeps full balance
  // support through DEEPSEEK_API_KEY, and the entry still activates cleanly.
  ctx.inject(['deepseekAccount'], (child) => {
    account = child.deepseekAccount ?? null;
    accountState.probe = account === null ? 'missing' : 'present';
  });

  // Credentials matter only for the opt-in account history (the console's
  // private API needs the console session token). Soft probe as well.
  ctx.inject(['credentials'], (child) => {
    credentials = child.credentials ?? null;
    credentialState.probe = credentials === null ? 'missing' : 'present';
  });

  /**
   * The platform console session token: the credential-resolution order is the
   * documented one (environment, then the DSH credential store, which `.env`
   * files layer under), and the value never leaves this process.
   */
  async function resolvePlatformToken() {
    if (credentials === null) return null;
    try {
      const resolved = await credentials.resolve(config.platformTokenRef);
      const raw = resolved !== null && resolved !== undefined && typeof resolved.value === 'string'
        ? resolved.value.trim()
        : '';
      if (raw === '') return null;
      // Accept exactly what the user copied: a bare token, or the whole
      // `Bearer <token>` Authorization value from DevTools.
      const withoutScheme = raw.replace(/^bearer\s+/i, '').trim();
      return withoutScheme === '' ? null : withoutScheme;
    } catch (error) {
      accountState.lastError = String(error?.message ?? error).slice(0, 160);
      return null;
    }
  }

  // ── account history (opt-in; the console's private usage API) ──────────────

  const historyFile = join(dirname(ledger.filePath), 'platform.json');

  const history = createPlatformHistory({
    resolveToken: resolvePlatformToken,
    months: config.platformHistoryMonths,
    ttlMs: config.platformHistoryTtlMs,
    onError: (message, error) => console.error(message, error),
  });

  /** Persist the last good scan so a restart shows numbers before the first request. */
  async function saveHistory(payload) {
    try {
      await mkdir(dirname(historyFile), { recursive: true });
      await writeFile(historyFile + '.tmp', JSON.stringify(payload), 'utf8');
      await rename(historyFile + '.tmp', historyFile);
    } catch (error) {
      console.error('quota-card: could not persist the platform history', error);
    }
  }

  async function loadHistory() {
    try {
      const parsed = JSON.parse(await readFile(historyFile, 'utf8'));
      history.seed(parsed);
    } catch {
      /* no persisted history yet is the normal first run */
    }
  }

  /**
   * Kick a scan when one is due and persist the result. Deliberately NOT awaited
   * by the snapshot route: a slow or failing console call must never delay the
   * local numbers the card always has.
   */
  function refreshHistory() {
    if (!config.platformHistory || credentialState.probe === 'missing') return;
    history.refresh('snapshot').then(
      (payload) => {
        if (payload !== null) saveHistory(payload).catch(() => undefined);
      },
      (error) => console.error('quota-card: history refresh failed', error),
    );
  }

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
      usage: { today: ledger.today(now), month: ledger.month(now), lifetime: ledger.lifetime() },
      platform: config.platformHistory ? history.current() : null,
      balanceSource: account === null
        ? (apiKey() === '' ? 'none' : 'api-key')
        : (accountState.probe === 'present' ? 'account' : 'none'),
    };
    snapshotCache = { at: now, value };
    // Fire-and-forget: the reply never waits for the console.
    refreshHistory();
    return value;
  }

  // ── routes ──────────────────────────────────────────────────────────────────

  /**
   * The bridge is loopback-only, and a mutation additionally requires that the
   * request is not cross-site. `Sec-Fetch-Site` is sent by every browser and is
   * the DNS-rebinding defence: a page on another origin cannot forge it, while a
   * request from the desktop shell's own `dsh-app://` origin is still allowed
   * (it may omit `Origin` entirely, which is why that header alone is not used).
   */
  function isLoopbackRequest(request, requireSameSite) {
    const address = request?.socket?.remoteAddress;
    if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false;
    const host = request?.headers?.host;
    if (typeof host !== 'string' || host === '') return false;
    let hostUrl;
    try {
      hostUrl = new URL('http://' + host);
    } catch {
      return false;
    }
    if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false;
    if (requireSameSite !== true) return true;
    const site = request.headers['sec-fetch-site'];
    if (site === 'cross-site') return false;
    if (site === undefined) {
      // No fetch metadata at all: accept only when no Origin claims another site.
      const origin = request.headers.origin;
      if (origin === undefined) return true;
      try {
        return new URL(origin).host === hostUrl.host;
      } catch {
        return false;
      }
    }
    return true;
  }

  /** Read a bounded JSON body; null when it is too large or not an object. */
  async function readJsonBody(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) return null;
      chunks.push(chunk);
    }
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return parsed !== null && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  /** `abcdef…wxyz` — never the whole value, never reversible in practice. */
  function maskSecret(value) {
    if (typeof value !== 'string' || value === '') return null;
    if (value.length <= 10) return '****';
    return value.slice(0, 6) + '****' + value.slice(-4);
  }

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
      path: ROUTE_TOKEN,
      handler: async (request, response) => {
        // Writing a credential is the one mutating route, so it is gated on a
        // loopback peer AND a same-origin request — a browser tab on another
        // origin cannot post the token here.
        if (isLoopbackRequest(request, true) === false) {
          sendJson(request, response, 403, { ok: false, error: 'forbidden' });
          return;
        }
        if (request.method !== 'POST') {
          sendJson(request, response, 405, { ok: false, error: 'method-not-allowed' });
          return;
        }
        if (credentials === null) {
          sendJson(request, response, 503, { ok: false, error: 'credentials-unavailable' });
          return;
        }
        try {
          const body = await readJsonBody(request);
          const raw = body !== null && typeof body.token === 'string' ? body.token.trim() : '';
          const token = raw.replace(/^bearer\s+/i, '').trim();
          if (token === '') {
            sendJson(request, response, 400, { ok: false, error: 'empty-token' });
            return;
          }
          if (token.length > MAX_TOKEN_LENGTH) {
            sendJson(request, response, 400, { ok: false, error: 'token-too-long' });
            return;
          }
          await credentials.set(config.platformTokenRef, token);
          counters.tokenWrites += 1;
          // A fresh credential invalidates the cached scan immediately.
          history.invalidate();
          refreshHistory();
          sendJson(request, response, 200, { ok: true, stored: true, masked: maskSecret(token) });
        } catch (error) {
          sendJson(request, response, 502, {
            ok: false,
            error: 'store-failed',
            detail: String(error?.message ?? error).slice(0, 160),
          });
        }
      },
    },
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
            platformHistory: config.platformHistory,
            platformTokenRef: config.platformTokenRef,
            platformHistoryMonths: config.platformHistoryMonths,
          },
          balance: {
            accountService: accountState.probe,
            hasApiKey: apiKey() !== '',
            lastAccountError: accountState.lastError,
          },
          platform: {
            credentials: credentialState.probe,
            history: history.diagnostics(),
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
      // Seed the last good history scan so the card shows real numbers before
      // the first console request finishes, then let the first snapshot refresh.
      loadHistory().then(
        () => undefined,
        () => undefined,
      );
      return () => {
        ledger.flush().catch((error) => console.error('quota-card: final flush failed', error));
      };
    }, 'quota-card: ledger');
  }
}

export default { apply, name };
