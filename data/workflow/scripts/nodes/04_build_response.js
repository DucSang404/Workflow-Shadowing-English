// Shapes the webhook response. Skipped sentences are surfaced rather than
// swallowed: the video is still valid, but the caller should know it is short
// a line and why.
const cfg = $('Prepare Run').first().json;
const srt = $('Build SRT').first().json;

const raw = $input.first().json.stdout;
if (!raw) {
  throw new Error(`video assembly produced no output: ${JSON.stringify($input.first().json).slice(0, 300)}`);
}
const built = JSON.parse(raw);

return [{
  json: {
    ok: true,
    runId: cfg.runId,
    topic: cfg.topic,
    video: built.output,
    subtitle: built.srt,
    sentences: built.segments,
    gapSeconds: cfg.gapSeconds,
    voice: cfg.voice,
    durationSec: built.durationSec,
    sizeBytes: built.sizeBytes,
    skippedSentences: srt.skipped,
  },
}];
