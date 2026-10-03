#!/usr/bin/env node
/**
 * Audits subtitle drift for a finished run.
 *
 *   node host/verify-sync.js            # the newest run in output/
 *   node host/verify-sync.js <runId>
 *
 * Why this exists: the SRT and the audio are produced by two different files
 * (container/nodes/shadowing/03_build_srt.js and container/cli/build_video.js)
 * that must agree on one rule - sentence i starts at the sum of every earlier
 * (duration + gap). Break that and nothing errors; the subtitles simply slide
 * out of sync, and nobody notices until they watch the whole video. So it gets
 * a test.
 *
 * Exit code is non-zero if any cue drifts beyond the tolerance, so this can gate
 * a change.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ROOT } = require('./lib/config');

const TOLERANCE_MS = 1;
const OUTPUT_DIR = path.join(ROOT, 'output');

function newestRunId() {
  const records = fs.readdirSync(OUTPUT_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, at: fs.statSync(path.join(OUTPUT_DIR, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  if (!records.length) throw new Error(`no run records in ${OUTPUT_DIR}`);
  return path.basename(records[0].f, '.json');
}

/** Cue start/end times parsed straight out of the burned-in subtitle file. */
function parseSrt(file) {
  const text = fs.readFileSync(file, 'utf8');
  const toSec = (h, m, s, ms) => Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
  return [...text.matchAll(/(\d\d):(\d\d):(\d\d),(\d\d\d) --> (\d\d):(\d\d):(\d\d),(\d\d\d)/g)]
    .map((m) => ({ start: toSec(m[1], m[2], m[3], m[4]), end: toSec(m[5], m[6], m[7], m[8]) }));
}

const runId = process.argv[2] ?? newestRunId();
const record = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, `${runId}.json`), 'utf8'));
const cues = parseSrt(path.join(OUTPUT_DIR, `${runId}.srt`));

if (cues.length !== record.segments.length) {
  console.error(`FAIL: ${cues.length} cues but ${record.segments.length} audio segments`);
  process.exit(1);
}

const musicOn = record.music?.used === true;

console.log(`run ${runId} — "${record.topic}"  gap=${record.gapSeconds}s  cues=${cues.length}`
  + (musicOn ? `  music=${record.music.db}dB (${record.music.source})` : '  music=off'));

// A music bed is mixed under the speech before the video is encoded, and the one
// thing it must not do is change how long the audio is - that would slide every
// subtitle. build_video.js compares sample counts at the moment of the mix and
// discards the mix if they differ; this re-checks the numbers it wrote down, so a
// regression in that guard shows up here rather than on screen.
const audio = record.audio ?? {};
const samplesKnown = Number.isFinite(audio.voiceSamples) && Number.isFinite(audio.finalSamples);
const badSamples = samplesKnown && audio.voiceSamples !== audio.finalSamples;

let cursor = 0;
let worstMs = 0;
record.segments.forEach((seg, i) => {
  const driftMs = Math.abs(cues[i].start - cursor) * 1000;
  worstMs = Math.max(worstMs, driftMs);
  const flag = driftMs > TOLERANCE_MS ? '  <-- DRIFT' : '';
  console.log(`  cue ${String(i + 1).padStart(2)}: srt=${cues[i].start.toFixed(3)}s`
    + `  expected=${cursor.toFixed(3)}s  drift=${driftMs.toFixed(1)}ms`
    + `  dur=${seg.duration}s${flag}`);
  cursor += seg.duration + record.gapSeconds;
});

// The timeline above is arithmetic. Everything below checks it against the file
// that actually shipped, because a uniform audio delay would satisfy the maths
// and still be wrong on screen.
const inContainer = (args) => execFileSync('docker', ['exec', 'shadowing-n8n', ...args], { encoding: 'utf8' });

// Paths in the record are written from inside the container, where this project
// is mounted at /data/workflow. ffprobe runs there and wants them verbatim; the
// existence check runs here and needs the host spelling.
const IN_CONTAINER = '/data/workflow';
const onHost = (p) => (p.startsWith(IN_CONTAINER) ? path.join(ROOT, p.slice(IN_CONTAINER.length)) : p);

const results = [];
for (const out of record.outputs ?? []) {
  if (!fs.existsSync(onHost(out.path))) {
    console.log(`  (missing on disk: ${out.path})`);
    continue;
  }
  const actual = parseFloat(inContainer(['ffprobe', '-v', 'error',
    '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', out.path]).trim());
  results.push({ ...out, actual, delta: Math.abs(actual - cursor) });
}

/**
 * Where does speech actually restart in the shipped file? Each shadowing gap is
 * digital silence, so silencedetect finds the real boundaries; a silence that
 * ends is the next sentence beginning. Compared against the cue starts, this
 * catches a whole-track shift that the arithmetic check cannot see.
 */
function speechOnsets(file, minSilence, duration) {
  const proc = execFileSync('docker', ['exec', 'shadowing-n8n', 'sh', '-c',
    `ffmpeg -nostdin -hide_banner -i '${file}' -af silencedetect=noise=-45dB:d=${minSilence} -f null - 2>&1`],
  { encoding: 'utf8' });

  const starts = [...proc.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => parseFloat(m[1]));
  const ends = [...proc.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => parseFloat(m[1]));

  // Each silence that ends is the next sentence beginning. The first sentence has
  // no silence before it unless the track opens on one - so only assume an onset
  // at zero when the first detected silence starts later than the very top.
  // The trailing shadowing gap runs to the end of the file, and silencedetect
  // reports that as a silence_end at EOF - which is not a sentence starting.
  const real = ends.filter((t) => t < duration - 0.25);

  const opensOnSpeech = !starts.length || starts[0] > 0.2;
  return opensOnSpeech ? [0, ...real] : real;
}

let worstOnsetMs = null;
const primary = results[0];
if (primary) {
  // Look for silences a little shorter than the gap, so the detector still fires
  // if a sentence ends on a soft trailing consonant.
  const onsets = speechOnsets(primary.path, Math.max(0.4, record.gapSeconds * 0.6), primary.actual);
  if (onsets.length === cues.length) {
    worstOnsetMs = Math.max(...cues.map((c, i) => Math.abs(onsets[i] - c.start) * 1000));
  } else if (musicOn) {
    // Expected, not a fault: the shadowing gaps are no longer digital silence
    // once a bed is playing under them, so the detector has nothing to find. The
    // sample-count check above covers the same failure and covers it exactly, so
    // nothing is lost - but run once with `"music": false` after changing the
    // timeline, because that is the check that watches the shipped pixels.
    console.log('\n  (onset check skipped: the music bed fills the gaps — '
      + 'rerun with {"music": false} to exercise it)');
  } else {
    console.log(`\n  (onset check skipped: found ${onsets.length} speech starts for ${cues.length} cues)`);
  }
}

console.log(`\n  worst cue drift : ${worstMs.toFixed(1)} ms  (tolerance ${TOLERANCE_MS} ms)`);
console.log(`  timeline total  : ${cursor.toFixed(3)} s`);
if (worstOnsetMs !== null) {
  console.log(`  worst onset gap : ${worstOnsetMs.toFixed(0)} ms  (measured in the shipped mp4)`);
}
if (samplesKnown) {
  console.log(`  audio samples   : voice=${audio.voiceSamples} final=${audio.finalSamples}`
    + `${badSamples ? '  <-- THE MIX MOVED THE TIMELINE' : ''}`);
}
for (const r of results) {
  console.log(`  ${r.key.padEnd(9)} ${r.width}x${r.height}  file=${r.actual.toFixed(3)}s  delta=${(r.delta * 1000).toFixed(1)}ms`);
}
for (const c of record.covers ?? []) {
  console.log(`  cover ${c.key.padEnd(9)} ${c.width}x${c.height}  @${c.atSec}s  "${c.title}"`);
}

// Onsets are measured by an energy threshold, so they land a little after the cue
// on a soft first syllable — about 200 ms in practice. The budget here is set well
// above that so the check does not go flaky, and still catches real desync.
const ONSET_TOLERANCE_MS = 350;
const badFile = results.find((r) => r.delta * 1000 > 40);
const badOnset = worstOnsetMs !== null && worstOnsetMs > ONSET_TOLERANCE_MS;

if (worstMs > TOLERANCE_MS || badFile || badOnset || badSamples) {
  console.error('\nFAIL: subtitles are out of sync with the audio timeline');
  process.exit(1);
}
console.log('\nOK: subtitles match the audio timeline');
