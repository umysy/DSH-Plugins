/**
 * Store the platform console token in the DSH credential store.
 *
 * The token is a reusable console session credential, so it never belongs in a
 * shell argument (which lands in the command history) or in a chat message. Three
 * ways in, in order of reliability:
 *
 *   1. A file, which sidesteps the terminal entirely:
 *        node tools/set-platform-token.mjs --from-file .token.txt
 *      (write the value into that file, run the command, then delete the file)
 *   2. The environment:
 *        $env:DEEPSEEK_USER_TOKEN="Bearer …"; node tools/set-platform-token.mjs
 *   3. A silent prompt:
 *        node tools/set-platform-token.mjs --prompt
 *
 * The prompt is implemented here rather than with `Read-Host -AsSecureString`
 * because PowerShell collapses a PASTED value in a SecureString prompt down to a
 * single character — and some terminals deliver the paste to the shell prompt
 * instead of to the program, which is why the file route exists.
 *
 * Options:
 *   --from-file <path>              read the token from a file
 *   --prompt                        read the token from a silent prompt
 *   --url http://127.0.0.1:19387    Harness origin (the default)
 *   --check-only                    verify an already-stored token instead
 *
 * What it prints: the masked token the Host acknowledged, or the Host's error
 * code. It never prints the token itself.
 */

import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);

function argValue(name, fallback) {
  const index = args.indexOf('--' + name);
  if (index < 0 || index + 1 >= args.length) return fallback;
  const value = args[index + 1].trim();
  return value === '' ? fallback : value;
}

const baseUrl = argValue('url', 'http://127.0.0.1:19387').replace(/\/+$/, '');
const checkOnly = args.includes('--check-only');
const wantPrompt = args.includes('--prompt');
const fromFile = argValue('from-file', null);

/**
 * Read one line from the terminal WITHOUT echoing it.
 *
 * `readline` writes the pending line itself, so the standard trick is to swallow
 * every terminal write while the answer is being typed and print the newline
 * afterwards ourselves. History is cleared so the value cannot be recalled with
 * the up arrow.
 */
function promptSecret(question) {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY !== true) {
      reject(new Error('stdin is not a terminal; pass the token in DEEPSEEK_USER_TOKEN instead'));
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.history = [];
    const originalWrite = rl._writeToOutput;
    let echo = false;
    rl._writeToOutput = function muted(text) {
      if (echo) process.stdout.write(text);
    };
    rl.question(question, (answer) => {
      echo = true;
      process.stdout.write('\n');
      rl.close();
      resolve(answer);
    });
    rl.on('error', reject);
  });
}

async function main() {
  if (checkOnly) {
    const response = await fetch(baseUrl + '/quota-card/health', { headers: { accept: 'application/json' } });
    const body = await response.json();
    console.log('health ok        :', body.ok === true);
    console.log('credentials      :', body.platform?.credentials);
    // Masked fingerprint of the stored credential: proves WHICH token is in use
    // without revealing it. A rotation is confirmed when this changes.
    console.log('stored token     :', body.platform?.token ?? '(unavailable)');
    console.log('history enabled  :', body.config?.platformHistory);
    console.log('history state    :', JSON.stringify(body.platform?.history ?? {}));
    return;
  }

  let token = process.env.DEEPSEEK_USER_TOKEN;

  // A file is the most reliable route: the terminal never sees the value, so no
  // paste handling, line discipline, or shell history can truncate or echo it.
  if (fromFile !== null) {
    try {
      token = (await readFile(fromFile, 'utf8')).trim();
      console.log('read the token from:', fromFile);
      console.log('delete that file now that it has been read:');
      console.log("  Remove-Item -LiteralPath '" + fromFile + "'");
    } catch (error) {
      console.log('could not read', fromFile, '-', String(error?.message ?? error));
      process.exitCode = 1;
      return;
    }
  }

  // Fall back to the prompt when no environment value arrived and the tool was
  // started on a terminal, so the documented one-liner just works.
  if ((typeof token !== 'string' || token.trim() === '') && (wantPrompt || process.stdin.isTTY === true)) {
    console.log('Paste the Authorization value (it will not be shown), then press Enter.');
    console.log('DevTools → Network → any api/v0 request → Headers → Request Headers →');
    console.log('the value beside Authorization. Ctrl+C to abort.');
    try {
      token = await promptSecret('Authorization value: ');
    } catch (error) {
      console.log('could not read the token:', String(error?.message ?? error));
    }
  }

  if (typeof token !== 'string' || token.trim() === '') {
    console.log('No token supplied, so there is nothing to store.');
    console.log('');
    console.log('Most reliable — write the value into a file, then:');
    console.log('  node ' + process.argv[1] + ' --from-file <path>');
    console.log('');
    console.log('Or through the environment, e.g. in PowerShell:');
    console.log("  $env:DEEPSEEK_USER_TOKEN = 'Bearer …'; node " + process.argv[1]);
    console.log('  Remove-Item Env:\\DEEPSEEK_USER_TOKEN -ErrorAction SilentlyContinue');
    console.log('');
    console.log('Or from a silent prompt (may not work if the terminal delivers a paste');
    console.log('to the shell prompt instead of to this program):');
    console.log('  node ' + process.argv[1] + ' --prompt');
    process.exitCode = 1;
    return;
  }

  // Catch the mistakes that actually happened while building this: a placeholder
  // left in place, a whole command line typed instead of the header value, and a
  // paste that arrived as one character.
  const candidate = token.trim().replace(/^bearer\s+/i, '').trim();
  if (candidate.length < 16 || /\s/.test(candidate)) {
    console.log('Refusing to store this: it does not look like a single token.');
    console.log('  length        :', candidate.length, '(expected at least 16)');
    console.log('  has whitespace:', /\s/.test(candidate));
    if (candidate.length === 1) {
      console.log('A single character means the terminal did not deliver the paste to this');
      console.log('program. Use `--from-file <path>` instead: the terminal is not involved.');
    }
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
