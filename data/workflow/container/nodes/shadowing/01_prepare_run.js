// Validates the webhook payload and stakes out a per-run work directory.
// Everything downstream reads its paths from here, so a run never collides
// with a concurrent one.
const fs = require('fs');
const ROOT = '/data/workflow';

// TikTok / Shorts / Reels want 9:16. Landscape stays the default because it is
// what you actually watch while practising at a desk.
const FORMATS = {
  landscape: { key: 'landscape', width: 1280, height: 720 },
  portrait: { key: 'portrait', width: 1080, height: 1920 },
};

const raw = $input.first().json;
const body = raw.body ?? raw ?? {};

// n8n truncates a Code node's error message at its LAST colon, so anything before
// one never reaches the caller. Hence ` - ` instead of `: ` throughout, and the
// colon-stripping in `brief()` - a raw JSON dump is full of colons and would eat
// the sentence explaining it.
const topic = String(body.topic ?? '').trim();
if (!topic) {
  throw new Error('topic is required - POST e.g. topic = ordering coffee');
}
if (topic.length > 120) {
  throw new Error('`topic` must be 120 characters or fewer');
}

const clamp = (value, lo, hi, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

const orientation = String(body.orientation ?? 'landscape').toLowerCase();
if (!['landscape', 'portrait', 'both'].includes(orientation)) {
  throw new Error(`\`orientation\` must be landscape, portrait or both — got "${orientation}"`);
}
const formats = orientation === 'both'
  ? [FORMATS.landscape, FORMATS.portrait]
  : [FORMATS[orientation]];

const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
const runId = `${stamp}_${Math.random().toString(36).slice(2, 8)}`;
const workDir = `${ROOT}/work/${runId}`;
fs.mkdirSync(workDir, { recursive: true });

// Background music. `music` accepts three shapes so the common cases stay short:
//   omitted / true  -> use assets/music/ if anything is in there, else look for a
//                      CC0 bed on Openverse
//   false / "off"   -> speech only, exactly as before this existed
//   "<name or path>" -> that file; a bare name resolves inside assets/music/
// Everything is optional by design: no bed found is a normal run, not a failure.
const musicRaw = body.music;
const musicWord = typeof musicRaw === 'string' ? musicRaw.trim().toLowerCase() : '';
const musicEnabled = !(musicRaw === false || musicWord === 'off' || musicWord === 'false');
const musicFile = typeof musicRaw === 'string' && !['', 'on', 'off', 'auto', 'true', 'false'].includes(musicWord)
  ? musicRaw.trim()
  : '';

// The dialogue is a two-person exchange, so it gets two voices. `voice` is kept
// as a legacy escape hatch: pass it and both speakers use that single voice.
const singleVoice = body.voice ? String(body.voice) : '';

// The first format keeps the plain <runId>.mp4 name so existing callers and the
// spec's /data/workflow/output/ contract still hold; extras get a suffix.
const outputs = formats.map((f, i) => ({
  ...f,
  path: `${ROOT}/output/${runId}${i === 0 ? '' : `_${f.key}`}.mp4`,
}));

return [{
  json: {
    runId,
    workDir,
    manifestPath: `${workDir}/manifest.json`,
    srtPath: `${workDir}/subtitle.srt`,
    planPath: `${workDir}/plan.json`,
    pexelsPath: `${workDir}/pexels.json`,
    musicPath: `${workDir}/music.json`,
    outputPath: outputs[0].path,
    outputs,
    outputDir: `${ROOT}/output`,
    topic,
    sentenceCount: Math.round(clamp(body.sentenceCount, 5, 8, 6)),
    gapSeconds: clamp(body.gapSeconds, 1, 10, 2.5),
    voiceA: singleVoice || String(body.voiceA ?? 'en-US-AvaNeural'),
    voiceB: singleVoice || String(body.voiceB ?? 'en-US-AndrewNeural'),
    speed: clamp(body.speed, 0.5, 1.5, 0.9),
    background: String(body.background ?? ''),
    orientation,
    // Target loudness. -14 LUFS is what TikTok/YouTube normalise to, so hitting it
    // means the platform leaves the audio alone.
    targetLufs: clamp(body.targetLufs, -30, -8, -14),
    music: {
      enabled: musicEnabled,
      file: musicFile,
      query: String(body.musicQuery ?? '').trim().slice(0, 80),
      // How far the bed sits under the speech, in LUFS. -24 is background you can
      // actually hear: present through the shadowing gaps without competing with
      // the line being repeated. Started at -30, which measured correct but played
      // as near-silence on a phone speaker.
      db: clamp(body.musicDb, -60, -6, -24),
    },
    // The TikTok cover. Off by request only - it costs one extra frame decode.
    thumbnail: body.thumbnail !== false,
    // Where to freeze. Left null, build_video.js picks a point inside the first
    // scene that no transition is passing through.
    thumbnailTime: Number.isFinite(Number(body.thumbnailTime))
      ? clamp(body.thumbnailTime, 0, 3600, 0)
      : null,
    keepWorkDir: body.keepWorkDir === true,
  },
}];
