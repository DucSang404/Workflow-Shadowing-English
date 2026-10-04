#!/usr/bin/env node
/**
 * usage: node probe_durations.js <sentenceDir>
 *
 * Normalises every sentence mp3 to sample-exact WAV and reports its duration.
 * mp3 carries encoder-delay padding, so container duration drifts a few ms per
 * file; concatenating 8 of those is enough to visibly desync burned subtitles.
 * PCM does not drift, so the SRT builder gets ground truth.
 *
 * Sentences whose TTS call failed simply have no mp3 — they are reported in
 * `missing` and never reach the video, instead of failing the whole run.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
const SR = 24000;

const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const segments = [];
const missing = [];

/** mp3 -> sample-exact WAV, and its true duration. Returns null if unusable. */
function toWav(idx) {
  const mp3 = path.join(dir, `sent_${String(idx).padStart(3, '0')}.mp3`);
  if (!fs.existsSync(mp3) || fs.statSync(mp3).size < 512) {
    return { error: fs.existsSync(mp3) ? 'empty audio' : 'no audio file' };
  }
  const wav = mp3.replace(/\.mp3$/, '.wav');
  try {
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', mp3,
      '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_s16le', wav], { stdio: 'pipe' });
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', wav], { encoding: 'utf8' });
    const duration = parseFloat(out.trim());
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('bad duration');
    return { wav, duration };
  } catch (err) {
    return { error: `decode failed: ${err.message}` };
  }
}

for (const s of manifest.sentences) {
  const probed = toWav(s.idx);
  if (probed.error) {
    missing.push({ idx: s.idx, reason: probed.error });
    continue;
  }
  segments.push({ idx: s.idx, en: s.en, vi: s.vi, wav: probed.wav, duration: probed.duration });
}

// The spoken brand line is probed the same way but kept out of `segments`: it is
// not a cue and must not become one. 03_build_srt.js turns its duration into the
// intro offset; if it is missing the card just stays silent.
let intro = null;
let introMissing = null;
if (manifest.intro) {
  const probed = toWav(manifest.intro.idx ?? 0);
  if (probed.error) introMissing = probed.error;
  else intro = { wav: probed.wav, duration: probed.duration, en: manifest.intro.en };
}

process.stdout.write(JSON.stringify({ segments, missing, intro, introMissing }));
