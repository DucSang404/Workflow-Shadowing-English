// Validates the webhook payload and stakes out a per-run work directory.
// Everything downstream reads its paths from here, so a run never collides
// with a concurrent one.
const fs = require('fs');
const ROOT = '/data/workflow';

const raw = $input.first().json;
const body = raw.body ?? raw ?? {};

const topic = String(body.topic ?? '').trim();
if (!topic) {
  throw new Error('`topic` is required — POST e.g. {"topic":"ordering coffee"}');
}
if (topic.length > 120) {
  throw new Error('`topic` must be 120 characters or fewer');
}

const clamp = (value, lo, hi, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
const runId = `${stamp}_${Math.random().toString(36).slice(2, 8)}`;
const workDir = `${ROOT}/work/${runId}`;
fs.mkdirSync(workDir, { recursive: true });

return [{
  json: {
    runId,
    workDir,
    manifestPath: `${workDir}/manifest.json`,
    srtPath: `${workDir}/subtitle.srt`,
    planPath: `${workDir}/plan.json`,
    outputPath: `${ROOT}/output/${runId}.mp4`,
    topic,
    sentenceCount: Math.round(clamp(body.sentenceCount, 5, 8, 6)),
    gapSeconds: clamp(body.gapSeconds, 1, 10, 2.5),
    voice: String(body.voice ?? 'en-US-AvaNeural'),
    speed: clamp(body.speed, 0.5, 1.5, 0.9),
    background: String(body.background ?? ''),
    width: 1280,
    height: 720,
  },
}];
