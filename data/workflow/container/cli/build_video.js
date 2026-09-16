#!/usr/bin/env node
/**
 * usage: node build_video.js <planPath>
 *
 * Pads each sentence with the shadowing gap, concatenates, lays the result over
 * a static background and burns the SRT in. One ffmpeg pass for audio, one for
 * video — apad+concat keeps the audio sample-exact so it matches the SRT the
 * Build SRT node computed from the same durations.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { workDir, srtPath, outputPath, gapSeconds, background, width, height } = plan;
const SR = 24000;
const segs = plan.segments;
if (!segs.length) { console.error('no usable audio segments'); process.exit(2); }

const run = (args) => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], { stdio: 'pipe' });

// --- 1. audio: pad each sentence with the gap, then concat -------------------
const audioPath = path.join(workDir, 'full_audio.wav');
const inputs = segs.flatMap((s) => ['-i', s.wav]);
const pads = segs.map((_, i) => `[${i}:a]apad=pad_dur=${gapSeconds},aresample=${SR}[a${i}]`).join(';');
const chain = segs.map((_, i) => `[a${i}]`).join('');
run([...inputs, '-filter_complex', `${pads};${chain}concat=n=${segs.length}:v=0:a=1[aout]`,
  '-map', '[aout]', '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_s16le', audioPath]);

const durationSec = parseFloat(execFileSync('ffprobe',
  ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', audioPath],
  { encoding: 'utf8' }).trim());

// --- 2. background: user-supplied still, else a plain dark canvas ------------
const hasBg = background && fs.existsSync(background);
const bgInput = hasBg
  ? ['-loop', '1', '-framerate', '25', '-i', background]
  : ['-f', 'lavfi', '-i', `color=c=0x14161A:s=${width}x${height}:r=25`];
const bgFilter = hasBg
  ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`
  : 'setsar=1';

// --- 3. burn subtitles -------------------------------------------------------
// fontsdir + an explicit FontName avoids depending on a fontconfig cache, which
// the hardened n8n image does not ship.
const style = [
  'FontName=DejaVu Sans', 'FontSize=21',
  'PrimaryColour=&H00FFFFFF', 'OutlineColour=&H00000000',
  'BorderStyle=1', 'Outline=2', 'Shadow=1', 'Alignment=2', 'MarginV=46',
].join(',');
const escapedSrt = srtPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
const vf = `${bgFilter},subtitles='${escapedSrt}':fontsdir=/usr/share/fonts:force_style='${style}'`;

run([...bgInput, '-i', audioPath, '-vf', vf, '-t', String(durationSec),
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-shortest', outputPath]);

process.stdout.write(JSON.stringify({
  ok: true,
  output: outputPath,
  srt: srtPath,
  segments: segs.length,
  durationSec: Math.round(durationSec * 100) / 100,
  sizeBytes: fs.statSync(outputPath).size,
}));
