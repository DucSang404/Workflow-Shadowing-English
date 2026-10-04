#!/usr/bin/env node
/**
 * The whole TikTok OAuth token lifecycle, in one place.
 *
 * Used two ways:
 *   require('./tiktok_token')              - from tiktok_publish.js
 *   node tiktok_token.js refresh           - from host/tiktok-auth.js via docker exec
 *   node tiktok_token.js exchange <code> [codeVerifier]
 *   node tiktok_token.js status
 *
 * It lives under container/ because that is where it has to work *unattended*:
 * the access token dies every 24h, so any publish may need to refresh first. The
 * host tool reaches it through `docker exec`, the same way host/verify-sync.js
 * reaches ffprobe — one implementation, no second copy to drift.
 *
 * The file it owns is secrets/tiktok.json. Two things make that file delicate:
 *
 *   1. The refresh token ROTATES. TikTok says "the returned refresh_token may be
 *      different than the one passed in" and the old one stops working. Lose the
 *      new value and the only way back is the browser consent screen again. So
 *      every write is atomic - temp file then rename - and the refresh token is
 *      never cleared on an error path.
 *   2. It holds the client secret. That is a deliberate exception to the rule in
 *      CLAUDE.md that provider keys live only in the n8n credential store: the
 *      n8n public API v1 cannot update a credential's value, and this value
 *      changes every day, so the store physically cannot hold it.
 */
const fs = require('fs');
const path = require('path');

const SECRETS_FILE = '/data/workflow/secrets/tiktok.json';
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
// Inbox drafts only. `video.publish` is the Direct Post scope and it is pointless
// to ask for it until the Content Posting API audit has passed - before that every
// direct post is forced to SELF_ONLY, which nobody can see.
const SCOPES = 'video.upload';
// Refresh this far ahead of expiry rather than on the stroke of it, so a slow
// upload cannot have its token die halfway through.
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

function readSecrets() {
  if (!fs.existsSync(SECRETS_FILE)) {
    throw new Error(`${SECRETS_FILE} not found - copy secrets/tiktok.example.json and fill it in`);
  }
  return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
}

/**
 * Atomic, mode-preserving write. A half-written token file costs a trip through
 * the browser consent screen, so it is worth the rename.
 */
function writeSecrets(next) {
  const tmp = `${SECRETS_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, SECRETS_FILE);
  return next;
}

async function postForm(fields) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams(fields).toString(),
  });
  const body = await res.json().catch(() => ({}));
  // TikTok answers 200 with an `error` field as often as it answers a 4xx, so the
  // status code alone is not the check.
  if (!res.ok || body.error) {
    throw new Error(`token endpoint: ${body.error ?? res.status} - ${body.error_description ?? ''}`.trim());
  }
  if (!body.access_token) throw new Error(`token endpoint returned no access_token: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

/** Folds a token response into the secrets file, keeping the app credentials. */
function applyToken(secrets, token) {
  return writeSecrets({
    ...secrets,
    pendingState: undefined,
    pendingVerifier: undefined,
    accessToken: token.access_token,
    // Rotation: keep the new one when TikTok sends one, never blank the old one.
    refreshToken: token.refresh_token || secrets.refreshToken,
    expiresAt: Date.now() + (Number(token.expires_in) || 86400) * 1000,
    openId: token.open_id ?? secrets.openId ?? '',
    scope: token.scope ?? secrets.scope ?? '',
  });
}

/**
 * `codeVerifier` is required for a Desktop-platform app and absent for a Web one,
 * so it is only sent when there is one.
 */
async function exchangeCode(secrets, code, codeVerifier) {
  return applyToken(secrets, await postForm({
    client_key: secrets.clientKey,
    client_secret: secrets.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: secrets.redirectUri,
    ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
  }));
}

async function refresh(secrets) {
  if (!secrets.refreshToken) {
    throw new Error('no refresh token yet - run `node host/tiktok-auth.js` on the host first');
  }
  return applyToken(secrets, await postForm({
    client_key: secrets.clientKey,
    client_secret: secrets.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: secrets.refreshToken,
  }));
}

/** Returns usable secrets, refreshing first if the access token is about to die. */
async function validSecrets({ force = false } = {}) {
  const secrets = readSecrets();
  const stale = !secrets.accessToken || Date.now() > (secrets.expiresAt ?? 0) - REFRESH_MARGIN_MS;
  if (force || stale) return { secrets: await refresh(secrets), refreshed: true };
  return { secrets, refreshed: false };
}

module.exports = {
  SECRETS_FILE, AUTHORIZE_URL, SCOPES,
  readSecrets, writeSecrets, exchangeCode, refresh, validSecrets,
};

// --- CLI ---------------------------------------------------------------------
if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  const peek = (v) => (v ? `${String(v).slice(0, 4)}...(${String(v).length})` : '(empty)');

  (async () => {
    if (cmd === 'status') {
      const s = readSecrets();
      process.stdout.write(JSON.stringify({
        clientKey: peek(s.clientKey),
        redirectUri: s.redirectUri || '(empty)',
        scope: s.scope || '(not authorised)',
        openId: peek(s.openId),
        accessToken: peek(s.accessToken),
        refreshToken: peek(s.refreshToken),
        expiresInMinutes: s.expiresAt ? Math.round((s.expiresAt - Date.now()) / 60000) : null,
        authorised: Boolean(s.refreshToken),
      }));
      return;
    }
    if (cmd === 'exchange') {
      if (!arg) throw new Error('usage - tiktok_token.js exchange <code> [codeVerifier]');
      const saved = await exchangeCode(readSecrets(), arg, process.argv[4]);
      process.stdout.write(JSON.stringify({
        ok: true, scope: saved.scope, openId: peek(saved.openId),
        expiresInMinutes: Math.round((saved.expiresAt - Date.now()) / 60000),
      }));
      return;
    }
    if (cmd === 'refresh') {
      const { secrets } = await validSecrets({ force: true });
      process.stdout.write(JSON.stringify({
        ok: true, expiresInMinutes: Math.round((secrets.expiresAt - Date.now()) / 60000),
      }));
      return;
    }
    throw new Error('usage: tiktok_token.js status | exchange <code> | refresh');
  })().catch((err) => { console.error(err.message); process.exit(1); });
}
