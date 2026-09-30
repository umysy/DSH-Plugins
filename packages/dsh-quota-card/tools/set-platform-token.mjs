/**
 * Store the platform console token in the DSH credential store.
 *
 * The token is a reusable console session credential, so it never belongs in a
 * shell argument (which lands in the command history) or in a chat message. This
 * tool reads it from the environment and POSTs it to the local Host, which is
 * the only writer.
 *
 * PowerShell:
 *   $env:DEEPSEEK_USER_TOKEN="Bearer …"; node packages/dsh-quota-card/tools/set-platform-token.mjs
 *   Remove-Item Env:\DEEPSEEK_USER_TOKEN
 *
 * Options:
 *   --url http://127.0.0.1:19387    Harness origin (the default)
 *   --check-only                    verify an already-stored token instead
 *
 * What it prints: the masked token the Host acknowledged, or the Host's error
 * code. It never prints the token itself.
 */

const args = process.argv.slice(2);

function argValue(name, fallback) {
  const index = args.indexOf('--' + name);
  if (index < 0 || index + 1 >= args.length) return fallback;
  const value = args[index + 1].trim();
  return value === '' ? fallback : value;
}

const baseUrl = argValue('url', 'http://127.0.0.1:19387').replace(/\/+$/, '');
const checkOnly = args.includes('--check-only');
const token = process.env.DEEPSEEK_USER_TOKEN;

async function main() {
  if (checkOnly) {
    const response = await fetch(baseUrl + '/quota-card/health', { headers: { accept: 'application/json' } });
    const body = await response.json();
    console.log('health ok        :', body.ok === true);
    console.log('credentials      :', body.platform?.credentials);
    console.log('history enabled  :', body.config?.platformHistory);
    console.log('history state    :', JSON.stringify(body.platform?.history ?? {}));
    return;
  }

  if (typeof token !== 'string' || token.trim() === '') {
    console.log('DEEPSEEK_USER_TOKEN is not set, so there is nothing to store.');
    console.log('Set it for this command only, e.g. in PowerShell:');
    console.log('  $env:DEEPSEEK_USER_TOKEN=(Get-Clipboard).Trim(); node packages/dsh-quota-card/tools/set-platform-token.mjs');
    process.exitCode = 1;
    return;
  }

  // Catch the mistakes that actually happened while building this: a placeholder
  // left in place, or a whole command line copied instead of the header value.
  const candidate = token.trim().replace(/^bearer\s+/i, '').trim();
  if (candidate.length < 16 || /\s/.test(candidate)) {
    console.log('Refusing to store this: it does not look like a single token.');
    console.log('  length        :', candidate.length, '(expected at least 16)');
    console.log('  has whitespace:', /\s/.test(candidate));
    console.log('Copy the Authorization VALUE: DevTools → Network → an api/v0 request →');
    console.log('Headers → Request Headers → right-click the value → Copy value.');
    process.exitCode = 1;
    return;
  }

  const response = await fetch(baseUrl + '/quota-card/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ token: candidate }),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    /* reported below */
  }
  console.log('http status      :', response.status);
  if (body === null) {
    console.log('body             : (not JSON)');
    process.exitCode = 1;
    return;
  }
  if (body.ok === true) {
    console.log('stored           :', body.masked, '(masked; the value itself was never printed)');
    console.log('\nNext: set `platformHistory: true` in the plugin config and restart the');
    console.log('Harness. Then /quota-card/health shows the scan state.');
    return;
  }
  console.log('error            :', body.error, body.detail === undefined ? '' : '- ' + body.detail);
  if (body.error === 'forbidden') {
    console.log('\nThe Host refused the write. It accepts loopback requests that are not');
    console.log('cross-site; check that --url points at this machine\'s Harness origin.');
  }
  process.exitCode = 1;
}

main().catch((error) => {
  console.error('request failed:', String(error?.message ?? error));
  console.error('Is the Harness running at ' + baseUrl + '?');
  process.exitCode = 1;
});
