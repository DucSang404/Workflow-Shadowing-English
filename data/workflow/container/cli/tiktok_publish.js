#!/usr/bin/env node
/**
 * usage: node tiktok_publish.js <planPath>
 *        node tiktok_publish.js <videoPath> [--dry-run]
 *
 * Sends one finished mp4 to the TikTok account's inbox as a draft, then waits
 * until TikTok says the notification has landed. You open the app, the draft is
 * waiting, you type the caption and press post. That last step is the whole point
 * of this route: because a human publishes, TikTok does not gate it behind the
 * Content Posting API audit, and the post is a normal public post rather than the
 * SELF_ONLY that an unaudited Direct Post is forced into.
 *
 * Consequence worth knowing: TikTok IGNORES every post_info field on an inbox
 * draft. Caption, hashtags, privacy and interaction settings are whatever you
 * type in the app. So this does not send a caption - the workflow writes one to
 * output/<runId>_caption.txt for you to paste.
 *
 * Prints one line of JSON, like every other script in container/cli/. The plan it
 * was handed is echoed back inside that line so the Code node after it does not
 * have to reach back across the graph for the run id, topic or caption.
 */
const fs = require('fs');
const path = require('path');
const { validSecrets } = require('./tiktok_token');

const API = 'https://open.tiktokapis.com/v2';
const INIT_URL = `${API}/post/publish/inbox/video/init/`;
const STATUS_URL = `${API}/post/publish/status/fetch/`;

const MIN_CHUNK = 5 * 1024 * 1024;        // TikTok rejects anything smaller
const MAX_CHUNK = 64 * 1024 * 1024;
const MAX_CHUNKS = 1000;
const MAX_VIDEO = 4 * 1024 * 1024 * 1024;

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * How to cut the file up.
 *
 * The trap here bites silently if you reach for the obvious arithmetic:
 * total_chunk_count is `floor(size / chunk_size)`, NOT ceil. The last chunk is
 * allowed to be LARGER than chunk_size - it swallows the remainder, up to 128MB.
 * Use ceil and you hand TikTok a final chunk under its 5MB floor, which it
 * rejects after you have already uploaded everything else.
 *
 * Under 5MB there is no cutting at all: TikTok requires such a file whole.
 */
function planChunks(size) {
  if (size < MIN_CHUNK) return { chunkSize: size, totalChunks: 1, whole: true };

  let chunkSize = MIN_CHUNK;
  // Defensive: 1000 chunks of 5MB is 5GB, past the 4GB file limit, so this cannot
  // trigger today. It is here so raising MAX_VIDEO later cannot silently break.
  if (Math.floor(size / chunkSize) > MAX_CHUNKS) {
    chunkSize = Math.min(MAX_CHUNK, Math.ceil(size / MAX_CHUNKS));
  }
  return { chunkSize, totalChunks: Math.max(1, Math.floor(size / chunkSize)), whole: false };
}

/** Byte range of chunk i. The last one runs to EOF, however long that makes it. */
function chunkRange(i, { chunkSize, totalChunks }, size) {
  const first = i * chunkSize;
  const last = i === totalChunks - 1 ? size - 1 : first + chunkSize - 1;
  return { first, last, length: last - first + 1 };
}

const withTimeout = async (url, opts, ms) => {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: control.signal });
  } finally {
    clearTimeout(timer);
  }
};

/** TikTok answers 200 with an `error.code != "ok"` as readily as it answers 4xx. */
async function tiktokJson(url, accessToken, body, ms = 30000) {
  const res = await withTimeout(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(body),
  }, ms);

  const json = await res.json().catch(() => ({}));
  const err = json.error ?? {};
  if (!res.ok || (err.code && err.code !== 'ok')) {
    throw new Error(`${url.replace(API, '')}: ${err.code ?? res.status} - ${err.message ?? ''} `
      + `(log_id ${err.log_id ?? 'n/a'})`.trim());
  }
  return json.data ?? {};
}

async function uploadChunks(uploadUrl, file, size, cut) {
  const fd = fs.openSync(file, 'r');
  try {
    for (let i = 0; i < cut.totalChunks; i += 1) {
      const { first, last, length } = chunkRange(i, cut, size);
      const buf = Buffer.allocUnsafe(length);
      fs.readSync(fd, buf, 0, length, first);

      const res = await withTimeout(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(length),
          'Content-Range': `bytes ${first}-${last}/${size}`,
        },
        body: buf,
      }, UPLOAD_TIMEOUT_MS);

      // 201 ends the upload, 206 acknowledges a chunk and asks for the next.
      if (![200, 201, 206].includes(res.status)) {
        const text = await res.text().catch(() => '');
        throw new Error(`chunk ${i + 1}/${cut.totalChunks} (bytes ${first}-${last}): `
          + `http ${res.status} ${text.slice(0, 200)}`);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

async function pollStatus(accessToken, publishId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last = null;

  while (Date.now() < deadline) {
    const data = await tiktokJson(STATUS_URL, accessToken, { publish_id: publishId });
    last = data.status ?? null;

    // SEND_TO_USER_INBOX is the finish line for this route: the draft notification
    // is in the app. PUBLISH_COMPLETE only ever shows up on the Direct Post route.
    if (last === 'SEND_TO_USER_INBOX' || last === 'PUBLISH_COMPLETE') {
      return { status: last, failReason: null };
    }
    if (last === 'FAILED') {
      return { status: last, failReason: data.fail_reason ?? 'unknown' };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { status: last ?? 'TIMEOUT', failReason: `still ${last} after ${POLL_TIMEOUT_MS / 1000}s` };
}

/**
 * Takes either a plan written by the Resolve Video node, or a bare mp4 path so
 * the script stays runnable by hand for debugging.
 */
function readInput(arg, dryRunFlag) {
  if (!arg) {
    console.error('usage: tiktok_publish.js <planPath | videoPath> [--dry-run]');
    process.exit(2);
  }
  if (!fs.existsSync(arg)) throw new Error(`no such file: ${arg}`);
  if (!arg.endsWith('.json')) return { videoPath: arg, dryRun: dryRunFlag };

  const plan = JSON.parse(fs.readFileSync(arg, 'utf8'));
  if (!plan.videoPath) throw new Error(`plan ${arg} has no videoPath`);
  return { ...plan, dryRun: plan.dryRun === true || dryRunFlag };
}

(async () => {
  const plan = readInput(process.argv[2], process.argv.includes('--dry-run'));
  const { videoPath: file, dryRun } = plan;

  // Anything the plan carried travels back out untouched.
  const echo = {
    runId: plan.runId ?? null,
    topic: plan.topic ?? null,
    width: plan.width ?? null,
    height: plan.height ?? null,
    cover: plan.cover ?? null,
    caption: plan.caption ?? null,
    captionPath: plan.captionPath ?? null,
  };

  if (!fs.existsSync(file)) throw new Error(`no such video: ${file}`);

  const size = fs.statSync(file).size;
  if (size === 0) throw new Error('video is empty');
  if (size > MAX_VIDEO) throw new Error(`video is ${Math.round(size / 1048576)} MB, over TikTok's 4 GB limit`);

  const cut = planChunks(size);

  // --dry-run proves the chunk arithmetic and the file without touching TikTok,
  // and without needing credentials - which is what makes this testable at all.
  if (dryRun) {
    const ranges = Array.from({ length: cut.totalChunks }, (_, i) => chunkRange(i, cut, size));
    process.stdout.write(JSON.stringify({
      ...echo,
      ok: true,
      dryRun: true,
      file,
      sizeBytes: size,
      chunkSize: cut.chunkSize,
      totalChunkCount: cut.totalChunks,
      sentWhole: cut.whole,
      ranges: ranges.slice(0, 3),
      lastRange: ranges[ranges.length - 1],
      bytesCovered: ranges.reduce((n, r) => n + r.length, 0),
    }));
    return;
  }

  const { secrets, refreshed } = await validSecrets();

  const init = await tiktokJson(INIT_URL, secrets.accessToken, {
    source_info: {
      source: 'FILE_UPLOAD',
      video_size: size,
      chunk_size: cut.chunkSize,
      total_chunk_count: cut.totalChunks,
    },
  });

  if (!init.upload_url || !init.publish_id) {
    throw new Error(`init gave no upload_url/publish_id: ${JSON.stringify(init).slice(0, 200)}`);
  }

  await uploadChunks(init.upload_url, file, size, cut);
  const { status, failReason } = await pollStatus(secrets.accessToken, init.publish_id);

  process.stdout.write(JSON.stringify({
    ...echo,
    ok: status === 'SEND_TO_USER_INBOX' || status === 'PUBLISH_COMPLETE',
    file,
    sizeBytes: size,
    chunkSize: cut.chunkSize,
    totalChunkCount: cut.totalChunks,
    publishId: init.publish_id,
    status,
    failReason,
    tokenRefreshed: refreshed,
    // Not a formality: nothing is live until you do this.
    nextStep: status === 'SEND_TO_USER_INBOX'
      ? 'open TikTok, tap the inbox notification, type the caption, post'
      : null,
  }));
})().catch((err) => {
  // Deliberate exception to the container/cli rule of "stderr plus a non-zero
  // exit" (CLAUDE.md, "Thêm bước xử lý media"). n8n's Execute Command node throws
  // away stdout when the command exits non-zero, and hands the workflow an item
  // holding nothing but `error` - indistinguishable from the Resolve Video node's
  // own refusals, and stripped of which stage actually failed.
  //
  // These failures are answers the caller has to see: not authorised yet, draft
  // quota spent, TikTok rejected the chunk. So they travel as structured JSON on
  // stdout with exit 0, and the `ok` field carries the verdict.
  process.stdout.write(JSON.stringify({
    ok: false,
    stage: 'upload',
    error: String(err.message).slice(0, 400),
    hint: /refresh token|tiktok\.json not found/i.test(err.message)
      ? 'not authorised yet - run `node host/tiktok-auth.js` on the host'
      : null,
  }));
});
