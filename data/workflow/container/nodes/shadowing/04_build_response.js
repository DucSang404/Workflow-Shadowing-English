// Shapes the webhook response and clears the run's scratch space.
//
// Skipped sentences are surfaced rather than swallowed: the video is still valid,
// but the caller should know it is short a line and why.
const fs = require('fs');
const cfg = $('Prepare Run').first().json;
const srt = $('Build SRT').first().json;

const raw = $input.first().json.stdout;
if (!raw) {
  throw new Error(`video assembly produced no output: ${JSON.stringify($input.first().json).slice(0, 300)}`);
}
const built = JSON.parse(raw);

// Everything worth keeping moves next to the mp4, so output/ holds the complete
// deliverable and work/ is pure scratch that can be wiped without thought.
// A run of eight sentences leaves ~4 MB of mp3 and wav behind otherwise.
//
// The record is composed rather than copied: it folds the manifest together with
// the measured durations and gap windows, which is what host/verify-sync.js needs
// to re-audit subtitle drift once the work directory is gone.
const keptSrt = `${cfg.outputDir}/${cfg.runId}.srt`;
const keptRecord = `${cfg.outputDir}/${cfg.runId}.json`;
let cleaned = false;

try {
  const manifest = JSON.parse(fs.readFileSync(cfg.manifestPath, 'utf8'));
  const plan = JSON.parse(fs.readFileSync(cfg.planPath, 'utf8'));

  fs.copyFileSync(cfg.srtPath, keptSrt);
  fs.writeFileSync(keptRecord, JSON.stringify({
    runId: cfg.runId,
    topic: cfg.topic,
    createdAt: new Date().toISOString(),
    gapSeconds: cfg.gapSeconds,
    voices: { A: cfg.voiceA, B: cfg.voiceB },
    speed: cfg.speed,
    orientation: cfg.orientation,
    sentences: manifest.sentences,
    segments: plan.segments.map((s) => ({ idx: s.idx, duration: s.duration })),
    scenes: srt.scenes,
    outputs: built.outputs,
    durationSec: built.durationSec,
    loudness: built.loudness,
    skippedSentences: srt.skipped,
  }, null, 2), 'utf8');

  if (!cfg.keepWorkDir) {
    fs.rmSync(cfg.workDir, { recursive: true, force: true });
    cleaned = true;
  }
} catch (err) {
  // Housekeeping must never fail a run that already produced a video.
  console.log(`[shadowing] run ${cfg.runId}: cleanup skipped - ${err.message}`);
}

return [{
  json: {
    ok: true,
    runId: cfg.runId,
    topic: cfg.topic,
    video: built.output,
    videos: built.outputs,
    subtitle: keptSrt,
    record: keptRecord,
    sentences: built.segments,
    gapSeconds: cfg.gapSeconds,
    voices: { A: cfg.voiceA, B: cfg.voiceB },
    orientation: cfg.orientation,
    durationSec: built.durationSec,
    sizeBytes: built.sizeBytes,
    loudness: built.loudness,
    skippedSentences: srt.skipped,
    scenes: {
      used: (srt.scenes ?? []).length,
      missing: srt.scenesMissing ?? [],
      // Only CC BY images oblige a credit line; cc0 and Pexels do not.
      attributions: (srt.scenes ?? []).map((sc) => sc.attribution).filter(Boolean),
    },
    workDirCleaned: cleaned,
  },
}];
