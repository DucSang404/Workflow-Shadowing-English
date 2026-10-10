// Works out which file to post, and refuses the ones that should not go.
//
// Never throws. It returns `ok false` with a reason and lets the IF node after it
// route that straight to the reply. That is deliberate and not just style: a node
// with two outputs (which is what `onError: continueErrorOutput` makes) stops
// resolving by name from downstream - `$('Resolve Video')` comes back undefined -
// and every node below here needs to read exactly that. Keeping this node
// single-output is what lets the rest of the graph refer to it.
const fs = require('fs');
const ROOT = '/data/workflow';
const OUTPUT = `${ROOT}/output`;

const raw = $input.first().json;
const body = raw.body ?? raw ?? {};
const fail = (error) => [{ json: { ok: false, stage: 'resolve', error } }];

const runId = String(body.runId ?? '').trim();
const explicit = String(body.video ?? '').trim();
const allowLandscape = body.allowLandscape === true;
const dueAt = String(body.dueAt ?? '').trim();

if (!runId && !explicit) {
  return fail('request body needs runId or video - e.g. runId = 20261003160036_3tk7w2');
}
if (runId && !/^[0-9]{14}_[a-z0-9]{6}$/.test(runId)) {
  return fail(`runId does not look like a run id - ${runId}`);
}
// Buffer wants an ISO 8601 UTC instant; anything else is rejected far downstream.
if (dueAt && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(dueAt)) {
  return fail(`dueAt must be ISO 8601 UTC like 2026-10-05T09.00.00.000Z but was ${dueAt}`);
}

let videoPath;
if (explicit) {
  if (!explicit.startsWith(`${OUTPUT}/`)) return fail(`video must be a path under ${OUTPUT}`);
  if (!fs.existsSync(explicit)) return fail(`no such video - ${explicit}`);
  videoPath = explicit;
} else {
  const candidates = [`${OUTPUT}/${runId}_portrait.mp4`, `${OUTPUT}/${runId}.mp4`];
  videoPath = candidates.find((f) => fs.existsSync(f));
  if (!videoPath) return fail(`no video for run ${runId} - looked for ${candidates.join(' and ')}`);
}

// Bucket, region and channel are config, not secrets, so they live in a plain
// file. The ACCESS KEYS are not here and never reach this code - they sit in the
// n8n credential store and only the AWS S3 and Buffer nodes ever see them. Same
// split as the Unsplash search, see container/nodes/shadowing/05_collect_stock.js.
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(`${ROOT}/publish.config.json`, 'utf8'));
} catch (err) {
  return fail(`cannot read publish.config.json - ${err.message}`);
}
const s3 = cfg.s3 ?? {};
if (!s3.bucket || s3.bucket === 'FILL_ME_IN') {
  return fail('publish.config.json has no s3.bucket yet');
}

let record = null;
const recordPath = `${OUTPUT}/${runId || ''}.json`;
if (runId && fs.existsSync(recordPath)) {
  try {
    record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  } catch (err) {
    console.log(`[buffer] run ${runId} - unreadable record (${err.message})`);
  }
}

const shape = (record?.outputs ?? []).find((o) => o.path === videoPath);
if (shape && shape.height <= shape.width && !allowLandscape) {
  return fail(
    `${videoPath} is ${shape.width}x${shape.height}, which is not vertical. Posting that to `
    + 'TikTok wastes a slot on a letterboxed clip, so this refuses. Rebuild the run with '
    + 'orientation = portrait, or resend with allowLandscape = true.',
  );
}

// Buffer's own TikTok limits, checked before a 3 MB upload rather than after.
const sizeBytes = fs.statSync(videoPath).size;
const durationSec = Number(record?.durationSec ?? 0);
if (durationSec && (durationSec < 3 || durationSec > 600)) {
  return fail(`TikTok takes 3s to 10min, this run is ${durationSec}s`);
}
if (sizeBytes > 1024 * 1024 * 1024) {
  return fail(`TikTok caps video at 1 GB, this is ${Math.round(sizeBytes / 1048576)} MB`);
}

const fileName = videoPath.split('/').pop();
const s3Key = `${s3.prefix ?? ''}${fileName}`;

// Virtual-hosted style, except for a bucket whose name contains a dot - the
// wildcard certificate for *.s3.<region>.amazonaws.com does not match those, so
// they have to go path-style or TLS fails.
const encoded = s3Key.split('/').map(encodeURIComponent).join('/');
const publicUrl = s3.publicBaseUrl
  ? `${String(s3.publicBaseUrl).replace(/\/$/, '')}/${encoded}`
  : (s3.bucket.includes('.')
    ? `https://s3.${s3.region}.amazonaws.com/${s3.bucket}/${encoded}`
    : `https://${s3.bucket}.s3.${s3.region}.amazonaws.com/${encoded}`);

// Unlike the TikTok inbox-draft route, Buffer DOES carry the caption, so the text
// generated alongside the dialogue is what actually gets posted.
let caption = '';
const captionPath = runId ? `${OUTPUT}/${runId}_caption.txt` : '';
if (captionPath && fs.existsSync(captionPath)) {
  caption = fs.readFileSync(captionPath, 'utf8').trim();
}

const cover = (record?.covers ?? [])[0] ?? null;

return [{
  json: {
    ok: true,
    runId: runId || null,
    videoPath,
    sizeBytes,
    durationSec: durationSec || null,
    width: shape?.width ?? null,
    height: shape?.height ?? null,
    topic: record?.topic ?? null,
    bucket: s3.bucket,
    s3Key,
    publicUrl,
    caption,
    // Lines the TikTok thumbnail up with the cover jpg this run already made.
    thumbnailOffsetMs: Number.isFinite(cover?.atSec) ? Math.round(cover.atSec * 1000) : null,
    channelId: cfg.buffer?.channelId ?? '',
    dueAt: dueAt || null,
  },
}];
