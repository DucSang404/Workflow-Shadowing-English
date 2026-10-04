// Works out which file to send and refuses the ones that should not go.
//
// The refusals matter more than usual here: TikTok allows only about five
// pending inbox drafts per 24 hours, so a draft spent on the wrong file is a
// draft you cannot get back for a day.
const fs = require('fs');
const ROOT = '/data/workflow';
const OUTPUT = `${ROOT}/output`;

const raw = $input.first().json;
const body = raw.body ?? raw ?? {};

const runId = String(body.runId ?? '').trim();
const explicit = String(body.video ?? '').trim();
const allowLandscape = body.allowLandscape === true;
const dryRun = body.dryRun === true;

// Error text here carries no colons on purpose. n8n truncates a Code node's error
// message at its LAST colon, so "x is not 9:16, rebuild it" reaches the caller as
// "16, rebuild it" - the half that does not say what went wrong.
if (!runId && !explicit) {
  throw new Error('request body needs runId or video - e.g. runId = 20261003154722_0aim82');
}
if (runId && !/^[0-9]{14}_[a-z0-9]{6}$/.test(runId)) {
  throw new Error(`runId does not look like a run id - ${runId}`);
}

// Portrait first: it is what TikTok is for, and a run that made both wrote the
// 9:16 file under the _portrait suffix.
function resolveVideo() {
  if (explicit) {
    if (!explicit.startsWith(`${OUTPUT}/`)) {
      throw new Error(`video must be a path under ${OUTPUT}`);
    }
    if (!fs.existsSync(explicit)) throw new Error(`no such video - ${explicit}`);
    return explicit;
  }
  const candidates = [`${OUTPUT}/${runId}_portrait.mp4`, `${OUTPUT}/${runId}.mp4`];
  const found = candidates.find((f) => fs.existsSync(f));
  if (!found) throw new Error(`no video for run ${runId} — looked for ${candidates.join(' and ')}`);
  return found;
}

const videoPath = resolveVideo();

// The run record knows the real frame size, which beats guessing from the name.
let record = null;
const recordPath = `${OUTPUT}/${(runId || '')}.json`;
if (runId && fs.existsSync(recordPath)) {
  try {
    record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  } catch (err) {
    console.log(`[tiktok] run ${runId}: unreadable record (${err.message})`);
  }
}

const shape = (record?.outputs ?? []).find((o) => o.path === videoPath);
if (shape && shape.height <= shape.width && !allowLandscape) {
  throw new Error(
    `${videoPath} is ${shape.width}x${shape.height}, which is not vertical. TikTok allows about `
    + '5 pending drafts per 24h, so this refuses rather than spend one on a letterboxed '
    + 'upload. Rebuild the run with orientation = portrait, or resend with '
    + 'allowLandscape = true.',
  );
}

// Written by the shadowing run for pasting into the app — the inbox-draft route
// cannot carry it over the wire.
const captionPath = runId ? `${OUTPUT}/${runId}_caption.txt` : '';
let caption = '';
if (captionPath && fs.existsSync(captionPath)) {
  caption = fs.readFileSync(captionPath, 'utf8').trim();
}

// Everything the CLI and the reply need goes into one plan file, the same
// contract build_video.js works to.
//
// Not passed through n8n item data: this node has a second output for its own
// refusals, and once a node branches, `$('Resolve Video')` no longer resolves
// from downstream — it returns undefined and the response node dies on a
// property read. A file sidesteps the expression system entirely, and it is what
// the rest of this project already does for anything a CLI step needs.
const planPath = `${ROOT}/work/tiktok_${runId || 'adhoc'}.json`;
const plan = {
  runId: runId || null,
  videoPath,
  sizeBytes: fs.statSync(videoPath).size,
  width: shape?.width ?? null,
  height: shape?.height ?? null,
  topic: record?.topic ?? null,
  cover: (record?.covers ?? [])[0]?.path ?? null,
  caption,
  captionPath: caption ? captionPath : null,
  dryRun,
};

fs.mkdirSync(`${ROOT}/work`, { recursive: true });
fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8');

return [{ json: { planPath, ...plan } }];
