// Shapes the webhook response and clears the run's scratch space.
//
// Skipped sentences are surfaced rather than swallowed: the video is still valid,
// but the caller should know it is short a line and why.
const fs = require('fs');
const cfg = $('Prepare Run').first().json;
const srt = $('Build SRT').first().json;

const raw = $input.first().json.stdout;
if (!raw) {
  throw new Error('video assembly produced no output - '
    + JSON.stringify($input.first().json).slice(0, 300).replace(/:/g, '='));
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
// Plain text, next to the mp4, because the TikTok inbox-draft route IGNORES every
// post_info field - the caption is typed in the app, so what this run can usefully
// hand over is something to paste rather than something to send.
const keptCaption = `${cfg.outputDir}/${cfg.runId}_caption.txt`;
let cleaned = false;
// Hoisted out of the try because the response below reads the caption off it, and
// housekeeping failing must not take the caption down with it.
let manifest = null;

try {
  manifest = JSON.parse(fs.readFileSync(cfg.manifestPath, 'utf8'));
  const plan = JSON.parse(fs.readFileSync(cfg.planPath, 'utf8'));

  fs.copyFileSync(cfg.srtPath, keptSrt);

  const tags = (manifest.hashtags ?? []).map((t) => `#${t}`).join(' ');
  fs.writeFileSync(keptCaption, `${manifest.caption ?? ''}\n\n${tags}\n`, 'utf8');

  fs.writeFileSync(keptRecord, JSON.stringify({
    runId: cfg.runId,
    topic: cfg.topic,
    createdAt: new Date().toISOString(),
    gapSeconds: cfg.gapSeconds,
    // The title card shifts every cue by this much; host/verify-sync.js needs it
    // to know where cue 1 is supposed to start.
    introSec: srt.introSec ?? 0,
    // host/verify-sync.js needs these: a spoken brand line runs straight into the
    // first sentence, so cue 1 has no detectable silence in front of it.
    introLine: srt.introLine ?? null,
    introMs: srt.introMs ?? 0,
    introVoiced: Boolean(srt.introLine),
    // The end card lengthens the file without moving any cue; host/verify-sync.js
    // adds it back when it compares the timeline with the shipped mp4.
    outroSec: srt.outroSec ?? 0,
    brand: cfg.brand,
    voices: { A: cfg.voiceA, B: cfg.voiceB },
    speed: cfg.speed,
    orientation: cfg.orientation,
    sentences: manifest.sentences,
    segments: plan.segments.map((s) => ({ idx: s.idx, duration: s.duration })),
    scenes: srt.scenes,
    // Claude's score for the title-card backdrop; each scene carries its own.
    coverReview: srt.coverReview ?? null,
    passScore: srt.passScore ?? cfg.passScore,
    caption: manifest.caption ?? null,
    hashtags: manifest.hashtags ?? [],
    outputs: built.outputs,
    covers: built.covers ?? [],
    durationSec: built.durationSec,
    // host/verify-sync.js reads `audio` to prove the music bed did not move the
    // timeline the subtitles were built from.
    audio: built.audio ?? null,
    music: built.music ?? null,
    loudness: built.loudness,
    skippedSentences: srt.skipped,
    intro: {
      line: srt.introLine,
      ms: srt.introMs,
      // Present only when the brand line failed TTS and the card fell back to silence.
      missing: srt.introMissing ?? null,
    },
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
    cover: built.cover ?? null,
    covers: built.covers ?? [],
    subtitle: keptSrt,
    caption: manifest?.caption ?? null,
    captionFile: keptCaption,
    record: keptRecord,
    sentences: built.segments,
    gapSeconds: cfg.gapSeconds,
    voices: { A: cfg.voiceA, B: cfg.voiceB },
    orientation: cfg.orientation,
    durationSec: built.durationSec,
    sizeBytes: built.sizeBytes,
    audio: built.audio ?? null,
    loudness: built.loudness,
    // `music: null` means none was asked for or none was found; `used: false`
    // means one was found and then rejected - the reason says which.
    music: built.music
      ? { ...built.music, lookup: srt.musicReason ?? null }
      : { used: false, reason: srt.musicReason ?? 'no music' },
    skippedSentences: srt.skipped,
    intro: {
      line: srt.introLine,
      ms: srt.introMs,
      // Present only when the brand line failed TTS and the card fell back to silence.
      missing: srt.introMissing ?? null,
    },
    outroSec: srt.outroSec ?? 0,
    scenes: {
      used: (srt.scenes ?? []).length,
      missing: srt.scenesMissing ?? [],
      // Only CC BY images oblige a credit line; cc0 and Unsplash do not.
      attributions: (srt.scenes ?? []).map((sc) => sc.attribution).filter(Boolean),
      // `off` means no reviewer answered, so every scene took its first candidate.
      reviewer: srt.reviewer ?? 'off',
      passScore: srt.passScore ?? cfg.passScore,
      reviewCalls: srt.reviewCalls ?? 0,
      passed: (srt.scenes ?? []).filter((sc) => sc.review?.pass === true).length,
      failed: (srt.scenes ?? []).filter((sc) => sc.review?.pass === false)
        .map((sc) => ({ idx: sc.idx, score: sc.review.score, missing: sc.review.missing })),
      sources: (srt.scenes ?? []).reduce((n, sc) => ({ ...n, [sc.source]: (n[sc.source] ?? 0) + 1 }), {}),
      credits: (srt.scenes ?? [])
        .filter((sc) => sc.source === 'unsplash')
        .map(({ idx, source, photographer, link }) => ({ idx, source, photographer, link })),
      imageSourceWarning: cfg.imageSourceWarning ?? null,
    },
    coverError: built.coverError ?? null,
    workDirCleaned: cleaned,
  },
}];
