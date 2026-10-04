#!/usr/bin/env node
/**
 * One-time TikTok OAuth, plus token upkeep you can run by hand.
 *
 *   node host/tiktok-auth.js            # opens the browser, catches the callback
 *   node host/tiktok-auth.js --manual   # print the URL, paste the result back
 *   node host/tiktok-auth.js --status   # token state, no secrets printed
 *   node host/tiktok-auth.js --refresh  # force a refresh now
 *
 * Registered as a Desktop-platform app in Login Kit, which is what lets the
 * redirect be http://localhost:<port>/callback/ — a Web-platform app is held to
 * "absolute and begins with https", with no localhost exception. Desktop buys the
 * loopback redirect at the price of mandatory PKCE.
 *
 * This file does no token arithmetic of its own. Everything that touches the
 * token endpoint lives in container/cli/tiktok_token.js, because that is where it
 * must also run unattended; this reaches it through `docker exec`, the same way
 * host/verify-sync.js reaches ffprobe. One implementation, no second copy.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { ROOT } = require('./lib/config');

const SECRETS_FILE = path.join(ROOT, 'secrets', 'tiktok.json');
const IN_CONTAINER = '/data/workflow/container/cli/tiktok_token.js';
const AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const SCOPES = 'video.upload';
const WAIT_MS = 5 * 60 * 1000;

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? '');
};

/** Runs the container-side token tool and hands back its one line of JSON. */
function token(...argv) {
  try {
    // stderr is captured rather than inherited: docker forwards the container's
    // stderr straight through, so letting it inherit prints every error twice.
    return JSON.parse(execFileSync('docker',
      ['exec', 'shadowing-n8n', 'node', IN_CONTAINER, ...argv],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim());
  } catch (err) {
    const detail = (err.stderr || err.stdout || err.message).toString().trim();
    throw new Error(detail.includes('No such container')
      ? 'the n8n container is not running - `docker compose up -d` first'
      : detail);
  }
}

const readSecrets = () => JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));

function saveSecrets(next) {
  const tmp = `${SECRETS_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, SECRETS_FILE);
}

/**
 * PKCE, TikTok's way.
 *
 * RFC 7636 says the challenge is BASE64URL(SHA256(verifier)). TikTok's docs say
 * `CryptoJS.SHA256(code_verifier).toString(CryptoJS.enc.Hex)` — a HEX digest. It
 * is a real deviation, not a loose wording, and sending the base64url form gets
 * the authorize step rejected with nothing that points at the cause. Hex it is.
 *
 * The verifier itself is base64url of 48 random bytes: 64 characters, inside the
 * 43-128 range, and base64url's alphabet is already all "unreserved".
 */
function pkce() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('hex');
  return { verifier, challenge };
}

function authorizeUrl(secrets, state, challenge) {
  return `${AUTHORIZE_URL}?${new URLSearchParams({
    client_key: secrets.clientKey,
    response_type: 'code',
    scope: SCOPES,
    redirect_uri: secrets.redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })}`;
}

const PAGE = (title, body) => `<!doctype html><meta charset="utf-8">`
  + `<title>${title}</title>`
  + `<body style="font:16px/1.6 -apple-system,system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem">`
  + `<h1 style="font-size:1.3rem">${title}</h1>${body}</body>`;

/** Serves the loopback redirect until TikTok comes back, or the wait runs out. */
function waitForCallback(redirectUri, expectedState) {
  const url = new URL(redirectUri);
  const port = Number(url.port);
  if (!port) throw new Error(`redirectUri needs an explicit port, got ${redirectUri}`);

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const got = new URL(req.url, `http://localhost:${port}`);
      const code = got.searchParams.get('code');
      const error = got.searchParams.get('error');
      const state = got.searchParams.get('state');

      // The browser may ask for /favicon.ico before the real callback arrives.
      if (!code && !error) {
        res.writeHead(404).end();
        return;
      }

      const done = (status, title, body, outcome) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGE(title, body));
        server.close();
        clearTimeout(timer);
        outcome();
      };

      if (error) {
        const desc = got.searchParams.get('error_description') ?? '';
        done(400, 'TikTok refused', `<p><code>${error}</code> ${desc}</p>`,
          () => reject(new Error(`TikTok refused - ${error} ${desc}`.trim())));
        return;
      }
      // The point of `state`: it proves this callback answers the request this
      // machine started, not one someone else steered the browser into.
      if (state !== expectedState) {
        done(400, 'State mismatch', '<p>Start again from the terminal.</p>',
          () => reject(new Error('state mismatch - run the command again')));
        return;
      }
      done(200, 'Authorised', '<p>You can close this tab and go back to the terminal.</p>',
        () => resolve(code));
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`gave up after ${WAIT_MS / 60000} min with no callback`));
    }, WAIT_MS);

    server.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(err.code === 'EADDRINUSE'
        ? `port ${port} is already in use - free it, or use --manual`
        : err.message));
    });
    server.listen(port, '127.0.0.1');
  });
}

(async () => {
  if (!fs.existsSync(SECRETS_FILE)) {
    console.error(
      'No secrets/tiktok.json yet.\n\n'
      + '  cp secrets/tiktok.example.json secrets/tiktok.json\n'
      + '  chmod 600 secrets/tiktok.json\n\n'
      + 'then fill in clientKey, clientSecret and redirectUri from\n'
      + 'https://developers.tiktok.com > Manage apps > Products > Login Kit.',
    );
    process.exit(1);
  }

  if (args.includes('--status')) {
    console.log(JSON.stringify(token('status'), null, 2));
    return;
  }
  if (args.includes('--refresh')) {
    console.log(`refreshed - access token good for ${token('refresh').expiresInMinutes} min`);
    return;
  }

  const secrets = readSecrets();
  const missing = ['clientKey', 'clientSecret', 'redirectUri'].filter((k) => !secrets[k]);
  if (missing.length) throw new Error(`secrets/tiktok.json is missing - ${missing.join(', ')}`);

  // --- step two of the manual flow -----------------------------------------
  const pasted = flag('--callback');
  if (pasted !== null) {
    if (!pasted) throw new Error('--callback needs the URL you landed on, in quotes');
    const landed = new URL(pasted);
    const error = landed.searchParams.get('error');
    if (error) {
      throw new Error(`TikTok refused - ${error} ${landed.searchParams.get('error_description') ?? ''}`.trim());
    }
    const code = landed.searchParams.get('code');
    if (!code) throw new Error('that URL has no ?code= in it - did you paste the whole address?');

    const stored = readSecrets();
    if (stored.pendingState && landed.searchParams.get('state') !== stored.pendingState) {
      throw new Error('state mismatch - start again with `node host/tiktok-auth.js --manual`');
    }
    report(token('exchange', decodeURIComponent(code), stored.pendingVerifier ?? ''));
    return;
  }

  const state = crypto.randomBytes(12).toString('hex');
  const { verifier, challenge } = pkce();
  // Stashed so --manual can finish in a second invocation; the auto flow holds
  // both in memory and never needs to read them back.
  saveSecrets({ ...secrets, pendingState: state, pendingVerifier: verifier });
  const url = authorizeUrl(secrets, state, challenge);

  if (args.includes('--manual')) {
    console.log(`1. Open this in a browser logged into the TikTok account you post from:\n`);
    console.log(`${url}\n`);
    console.log(`2. Approve, then copy the WHOLE address you land on.\n`);
    console.log(`3. node host/tiktok-auth.js --callback '<paste it, in single quotes>'`);
    return;
  }

  console.log(`Listening on ${secrets.redirectUri} for up to ${WAIT_MS / 60000} minutes.`);
  console.log('Opening the browser — approve there, logged into the account you post from.\n');
  console.log(`If nothing opens, paste this in yourself:\n${url}\n`);

  const waiting = waitForCallback(secrets.redirectUri, state);
  try {
    execFileSync('open', [url], { stdio: 'ignore' });
  } catch {
    // Headless or no `open`: the URL is printed above, which is enough.
  }

  // The code is single-use and expires in minutes, so handing it and the verifier
  // over on argv is acceptable where the client secret would not be.
  report(token('exchange', await waiting, verifier));
})().catch((err) => { console.error(err.message); process.exit(1); });

function report(result) {
  console.log(`\nAuthorised. scope=${result.scope} openId=${result.openId}`);
  console.log(`Access token good for ${result.expiresInMinutes} min; the refresh token lasts`);
  console.log('a year and rotates on every use - container/cli/tiktok_token.js keeps up with it.');
  console.log('\nCheck any time with: node host/tiktok-auth.js --status');
}
