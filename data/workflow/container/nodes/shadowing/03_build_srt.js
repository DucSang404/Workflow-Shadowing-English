// Lays the probed sentences on a timeline and writes both the .srt and the
// ffmpeg plan. This node and build_video.js must agree on the arithmetic, so
// the single rule is: sentence i starts at the sum of every earlier
// (duration + gap). build_video.js realises exactly that with apad+concat.
//
// Timing comes from the PCM durations probe_durations.js measured, not from the
// mp3 headers - see the comment there for why that matters.
const fs = require('fs');
const cfg = $('Prepare Run').first().json;

const probeRaw = $input.first().json.stdout;
if (!probeRaw) {
  throw new Error('duration probe produced no output - '
    + JSON.stringify($input.first().json).slice(0, 300).replace(/:/g, '='));
}
const probe = JSON.parse(probeRaw);

const segments = (probe.segments ?? []).sort((a, b) => a.idx - b.idx);
const skipped = probe.missing ?? [];
if (!segments.length) {
  throw new Error('every sentence failed TTS - nothing to build a video from');
}

const gap = cfg.gapSeconds;
const CUE_GUARD = 0.08; // keeps consecutive cues from touching

/** seconds -> SRT timestamp (HH:MM:SS,mmm) */
function srtTime(sec) {
  const total = Math.max(0, Math.round(sec * 1000));
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return [
    pad(Math.floor(total / 3600000)),
    pad(Math.floor((total % 3600000) / 60000)),
    pad(Math.floor((total % 60000) / 1000)),
  ].join(':') + ',' + pad(total % 1000, 3);
}

// The title card sits in front of everything, so every cue starts that much
// later. This is the ONE place the offset is decided for the subtitles, and
// build_video.js prepends exactly the same number of milliseconds of silence to
// the audio - see the note on `introMs` in 01_prepare_run.js.
const introSec = cfg.intro ? cfg.introMs / 1000 : 0;

let cursor = introSec;
const cues = segments.map((seg, i) => {
  const start = cursor;
  // The cue deliberately stays up through the silence: the learner is repeating
  // the line during that gap and still needs to read it.
  const end = start + seg.duration + gap - CUE_GUARD;
  cursor = start + seg.duration + gap;
  return { index: i + 1, idx: seg.idx, start, end, en: seg.en, vi: seg.vi };
});

const srt = cues
  .map((c) => `${c.index}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.en}${c.vi ? `\n${c.vi}` : ''}\n`)
  .join('\n');

fs.writeFileSync(cfg.srtPath, srt, 'utf8');

// Scenes are optional: the Fetch Scenes node exits 0 with an empty list when no
// image could be found, and build_video.js falls back to the flat background.
let scenes = [];
let scenesMissing = [];
let coverBackground = null;
try {
  const raw = $('Fetch Scenes').first().json.stdout;
  if (raw) {
    const parsed = JSON.parse(raw);
    scenes = parsed.scenes ?? [];
    scenesMissing = parsed.missing ?? [];
    coverBackground = parsed.coverBackground ?? null;
  }
} catch (err) {
  console.log(`[shadowing] run ${cfg.runId}: no scenes (${err.message})`);
}

// Music is optional in exactly the same way scenes are: the fetcher exits 0 with
// `music: null` when it found nothing, and build_video.js ships speech only.
let music = null;
let musicReason = null;
try {
  const raw = $('Fetch Music').first().json.stdout;
  if (raw) {
    const parsed = JSON.parse(raw);
    music = parsed.music ?? null;
    musicReason = parsed.reason ?? null;
  }
} catch (err) {
  musicReason = err.message;
  console.log(`[shadowing] run ${cfg.runId}: no music (${err.message})`);
}

const plan = {
  runId: cfg.runId,
  topic: cfg.topic,
  workDir: cfg.workDir,
  srtPath: cfg.srtPath,
  outputs: cfg.outputs,
  gapSeconds: gap,
  introSec,
  introMs: cfg.intro ? cfg.introMs : 0,
  brand: cfg.brand,
  coverBackground,
  scenes: scenes.map((sc) => ({ idx: sc.idx, file: sc.file })),
  // `db` travels with the file so build_video.js needs no second source of config.
  music: music ? { ...music, db: cfg.music.db } : null,
  thumbnail: cfg.thumbnail,
  thumbnailTime: cfg.thumbnailTime,
  targetLufs: cfg.targetLufs,
  background: cfg.background,
  segments: segments.map((s) => ({ idx: s.idx, wav: s.wav, duration: s.duration })),
};
fs.writeFileSync(cfg.planPath, JSON.stringify(plan, null, 2), 'utf8');

if (skipped.length) {
  console.log(`[shadowing] run ${cfg.runId}: skipped ${skipped.length} sentence(s):`,
    JSON.stringify(skipped));
}

return [{
  json: {
    planPath: cfg.planPath,
    srtPath: cfg.srtPath,
    cueCount: cues.length,
    skipped,
    scenes,
    scenesMissing,
    music,
    musicReason,
    introSec,
    expectedDurationSec: Math.round(cursor * 100) / 100,
  },
}];
