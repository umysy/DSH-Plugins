/**
 * Authentication probe for the platform console usage API.
 *
 * The console endpoints (platform.deepseek.com/api/v0/usage/*) are private and
 * undocumented. This asks the two questions that decide how the plugin can offer
 * the "spend since the account was created" figures:
 *
 *   1. Does an inference API key work there?          (expected: no)
 *   2. Does the console session token (userToken)?    (expected: yes)
 *
 * Run:
 *   node packages/dsh-quota-card/tools/probe-platform-usage.mjs --key sk-…
 *   node packages/dsh-quota-card/tools/probe-platform-usage.mjs --user-token …
 *
 * Credentials may also come from the environment (DEEPSEEK_API_KEY,
 * DEEPSEEK_USER_TOKEN) so they never have to appear in a command line. Nothing
 * here prints a credential value — only its length and how the API answered.
 *
 * Extra options:
 *   --year 2026 --month 9     window for the single-month query
 *   --scan 6                  walk back N months using the accepted credential
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parsePlatformToken, aggregatePlatformUsage, platformRequestHeaders } from '../lib/platform.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const REFERER = 'https://platform.deepseek.com/usage';
const COST_URL = 'https://platform.deepseek.com/api/v0/usage/cost';
const AMOUNT_URL = 'https://platform.deepseek.com/api/v0/usage/amount';

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

function textArg(name) {
  const index = process.argv.indexOf('--' + name);
  if (index < 0 || index + 1 >= process.argv.length) return null;
  const value = process.argv[index + 1].trim();
  return value === '' ? null : value;
}

function env(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Accepts either the bare token or a copied `Authorization` header value
 * ("Bearer <token>"), so the credential can be pasted exactly as DevTools shows
 * it. Values are never printed.
 */
function normalizeUserToken(raw) {
  if (raw === null) return null;
  let text = raw.trim();
  if (text === '') return null;
  if (/^bearer\s+/i.test(text)) text = text.replace(/^bearer\s+/i, '').trim();
  if (text === '') return null;
  const first = text[0];
  if (first !== '{' && first !== '"' && first !== '[') return text;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'string') return parsed.trim() === '' ? null : parsed.trim();
    if (parsed !== null && typeof parsed === 'object') {
      for (const key of ['token', 'userToken', 'value', 'access_token', 'accessToken']) {
        const found = parsed[key];
        if (typeof found === 'string' && found.trim() !== '') return found.trim();
      }
    }
  } catch {
    // Not JSON after all — treat the raw text as the token.
    return text;
  }
  return null;
}

async function readCredentials() {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  const file = join(home, '.credentials.yaml');
  try {
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}

/** The persisted history the plugin writes; its presence proves a scan succeeded. */
async function readHistoryFile() {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');
  try {
    return JSON.parse(await readFile(join(home, 'quota-card', 'platform.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** `abcdef…wxyz`, never the whole value. */
function maskToken(value) {
  if (typeof value !== 'string' || value === '') return '(empty)';
  if (value.length <= 10) return '****';
  return value.slice(0, 6) + '****' + value.slice(-4);
}

/**
 * The console token the PLUGIN resolves, i.e. the DSH credential entry named by
 * `platformTokenRef` (default `DEEPSEEK_USER_TOKEN`).
 *
 * Verified against a real `$DSH_HOME/.credentials.yaml`: plain references live in
 * a top-level `refs:` block as `NAME: value`, while `records:` holds richer
 * records whose `payload.token` is the DSH ACCOUNT grant — a different credential
 * that this API rejects. Only `refs:` is read here, so the two cannot be confused.
 */
async function readStoredToken(refName) {
  const text = await readCredentials();
  if (text === '') return null;
  const wanted = typeof refName === 'string' && refName !== '' ? refName : 'DEEPSEEK_USER_TOKEN';
  let inRefs = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inRefs = /^refs:\s*$/.test(line);
      continue;
    }
    if (!inRefs) continue;
    const match = /^\s+([A-Za-z0-9_.\-]+):\s*(.*)$/.exec(line);
    if (match === null || match[1] !== wanted) continue;
    const value = match[2].trim().replace(/^["']|["']$/g, '');
    if (value === '') continue;
    return { value: normalizeUserToken(value) ?? value, source: 'DSH refs:' + wanted };
  }
  return null;
}

/**
 * Print a JSON payload's shape: keys, array lengths, and a small sample of the
 * values. Used to verify the undocumented console endpoints rather than assuming
 * their structure — an assumed path is how a paywalled field silently reads 0.
 */
function dumpShape(value, label, depth = 0, maxDepth = 4) {
  const pad = '  '.repeat(depth + 1);
  if (value === undefined) {
    console.log(pad + label + ': undefined');
    return;
  }
  if (Array.isArray(value)) {
    console.log(pad + label + ': array length ' + value.length);
    if (value.length > 0 && depth < maxDepth) dumpShape(value[0], '[0]', depth + 1, maxDepth);
    return;
  }
  if (value === null || typeof value !== 'object') {
    console.log(pad + label + ': ' + JSON.stringify(value));
    return;
  }
  console.log(pad + label + ': object keys [' + Object.keys(value).join(', ') + ']');
  if (depth >= maxDepth) return;
  for (const [key, entry] of Object.entries(value)) dumpShape(entry, key, depth + 1, maxDepth);
}

async function query(url, credential, scheme) {
  const headers = platformRequestHeaders(credential, UA, REFERER);
  if (scheme === 'raw') delete headers.authorization;
  if (scheme === 'raw') headers.authorization = credential;
  try {
    const response = await fetch(url, { headers, redirect: 'manual' });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* reported as null */
    }
    return { status: response.status, json, text };
  } catch (error) {
    return { status: 0, json: null, text: String(error?.message ?? error) };
  }
}

function verdict(result) {
  if (result.json === null) return 'unparseable body (HTTP ' + result.status + ')';
  const code = result.json.code;
  if (code === 0) return 'ACCEPTED (code 0)';
  if (code === 40002) return 'rejected: missing token (40002)';
  if (code === 40003) return 'rejected: invalid/expired token (40003)';
  return 'unexpected envelope: ' + JSON.stringify(result.json).slice(0, 160);
}

const year = arg('year', new Date().getUTCFullYear());
const month = arg('month', new Date().getUTCMonth() + 1);
const scan = arg('scan', 0);

// Candidates, in the order worth testing. `raw` means the credential is sent as
// the Authorization value with no "Bearer " prefix.
const candidates = [];
const apiKey = textArg('key') ?? env('DEEPSEEK_API_KEY');
const userToken = normalizeUserToken(textArg('user-token') ?? env('DEEPSEEK_USER_TOKEN'));
const fromFile = parsePlatformToken(await readCredentials());
// The credential the PLUGIN actually uses, read from its own store location.
// Testing only the environment and the account grant leaves the interesting
// candidate untested, which is exactly what makes a failed rotation look like
// an unexplained auth error.
const storedToken = await readStoredToken(env('DSH_QUOTA_TOKEN_REF'));

if (storedToken !== null) candidates.push({ label: 'console userToken (plugin)', scheme: 'bearer', credential: storedToken.value, source: storedToken.source, fingerprint: maskToken(storedToken.value) });
if (userToken !== null) candidates.push({ label: 'console userToken', scheme: 'bearer', credential: userToken, source: textArg('user-token') === null ? 'env' : 'argument' });
if (apiKey !== null) candidates.push({ label: 'inference API key', scheme: 'bearer', credential: apiKey, source: textArg('key') === null ? 'env' : 'argument' });
// Last on purpose: the fallback retry below runs the bare-header scheme on the
// LAST candidate, and the account grant is the one already known to be rejected.
if (fromFile !== null) candidates.push({ label: 'DSH platform grant', scheme: 'bearer', credential: fromFile, source: 'credentials file records:' });

if (candidates.length === 0) {
  console.log('No credential to test. Pass --key / --user-token, or set');
  console.log('DEEPSEEK_API_KEY / DEEPSEEK_USER_TOKEN, or store the console token with');
  console.log('tools/set-platform-token.mjs.');
  process.exitCode = 1;
} else {
  console.log('Testing against GET ' + COST_URL + '?month=' + month + '&year=' + year + '\n');
  let accepted = null;
  for (const candidate of candidates) {
    const result = await query(COST_URL + '?month=' + month + '&year=' + year, candidate.credential, candidate.scheme);
    if (candidate.fingerprint !== undefined) {
      console.log('stored token fingerprint (masked):', candidate.fingerprint);
    }
    console.log(
      (candidate.label + ' (' + candidate.source + ')').padEnd(38),
      'len=' + String(candidate.credential.length).padEnd(4),
      'http=' + String(result.status).padEnd(4),
      verdict(result),
    );
    if (accepted === null && result.json !== null && result.json.code === 0) accepted = candidate;
  }

  // A bare "Authorization: <token>" (no Bearer prefix) is the other scheme the
  // console could be using; only worth a second round on the winner.
  if (accepted === null) {
    const best = candidates[candidates.length - 1];
    const raw = await query(COST_URL + '?month=' + month + '&year=' + year, best.credential, 'raw');
    console.log('\nretry with a bare Authorization header on "' + best.label + '":', verdict(raw));
  }

  if (accepted === null) {
    console.log('\nRESULT: none of the available credentials is accepted by the console API.');
    console.log('The lifetime figures need the console session token (localStorage "userToken" on');
    console.log('platform.deepseek.com), which is a different credential from the inference API key.');
  } else {
    // Re-query with the winning credential so both payloads come from the same
    // request pair this report describes.
    const cost = await query(COST_URL + '?month=' + month + '&year=' + year, accepted.credential, accepted.scheme);
    const amount = await query(AMOUNT_URL + '?month=' + month + '&year=' + year, accepted.credential, accepted.scheme);
    console.log('\nRESULT: "' + accepted.label + '" works. This package can offer the lifetime figures.\n');
    console.log('=== parsed for ' + year + '-' + String(month).padStart(2, '0') + ' ===');
    console.log(JSON.stringify(
      aggregatePlatformUsage(cost.json, amount.json, { year, month }, { source: 'probe' }),
      null,
      2,
    ));

    // The cost payload must be inspected, not assumed: see `dumpShape` above.
    // The raw snippet is truncated and carries no credential (the token travels
    // only in the request headers).
    console.log('\n=== cost response, raw head (first 400 chars) ===');
    console.log(typeof cost.text === 'string' ? cost.text.slice(0, 400) : String(cost.text));
    console.log('\n=== shape of the cost payload (keys, array lengths, first entries) ===');
    dumpShape(cost.json, 'cost');
    console.log('\n=== shape of the amount payload ===');
    dumpShape(amount.json, 'amount');

    if (scan > 0) {
      console.log('\n=== spend profile, back up to ' + scan + ' months ===');
      let cursor = { year, month };
      for (let i = 0; i < scan; i += 1) {
        const result = await query(COST_URL + '?month=' + cursor.month + '&year=' + cursor.year, accepted.credential, accepted.scheme);
        const at = aggregatePlatformUsage(result.json, null, cursor, {});
        console.log(
          cursor.year + '-' + String(cursor.month).padStart(2, '0') +
          '  spend=' + (at === null ? 'n/a' : at.cost.toFixed(4)),
        );
        cursor = cursor.month === 1 ? { year: cursor.year - 1, month: 12 } : { year: cursor.year, month: cursor.month - 1 };
      }
    }
  }
}
