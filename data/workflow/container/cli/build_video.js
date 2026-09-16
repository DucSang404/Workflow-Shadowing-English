#!/usr/bin/env node
/**
 * usage: node build_video.js <planPath>
 *
 * Pads each sentence with the shadowing gap, concatenates, lays the result over
 * a static background and burns the SRT in. The audio is built once and reused
 * for every requested aspect ratio, so asking for both orientations costs one
 * extra video encode rather than a second full run.
 *
 * apad+concat keeps the audio sample-exact so it matches the SRT the Build SRT
 * node computed from the same durations.
 */
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const { workDir, srtPath, outputs, gapSeconds, targetLufs, background } = plan;

const SR = 24000;
const TRUE_PEAK_CEILING = -1.5; // dBTP, leaves headroom for lossy re-encode
const ASS_PLAY_RES_Y = 288;     // ffmpeg's default PlayResY when it converts SRT to ASS
const segs = plan.segments;
if (!segs.length) { console.error('no usable audio segments'); process.exit(2); }

const ffmpeg = (args) => execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', ...args], { stdio: 'pipe' });
const ffprobe = (args) => execFileSync('ffprobe', ['-v', 'error', ...args], { encoding: 'utf8' }).trim();

// --- 1. audio: pad each sentence with the gap, then concat -------------------
const audioPath = path.join(workDir, 'full_audio.wav');
const inputs = segs.flatMap((s) => ['-i', s.wav]);
const pads = segs.map((_, i) => `[${i}:a]apad=pad_dur=${gapSeconds},aresample=${SR}[a${i}]`).join(';');
const chain = segs.map((_, i) => `[a${i}]`).join('');
ffmpeg([...inputs, '-filter_complex', `${pads};${chain}concat=n=${segs.length}:v=0:a=1[aout]`,
  '-map', '[aout]', '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_s16le', audioPath]);

const durationSec = parseFloat(ffprobe(
  ['-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', audioPath]));

// --- 2. loudness: measure, then apply a static gain plus a peak limiter ------
// Deliberately NOT the `loudnorm` filter. loudnorm resamples internally and can
// return a different number of samples than it was given, which would slide the
// burned subtitles out of sync with the audio they were computed from. Measuring
// once and applying a constant gain cannot do that, and `alimiter` was checked on
// this ffmpeg build to return byte-identical PCM length.
//
// -14 LUFS is what TikTok and YouTube normalise to, so hitting it means the
// platform leaves the audio alone.
function measureLoudness(file) {
  // ebur128 prints its summary to stderr even when the run succeeds, so this
  // needs spawnSync - execFileSync only hands back stdout.
  const proc = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-i', file,
    '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' });
  const out = proc.stderr ?? '';
  const summary = out.slice(out.lastIndexOf('Summary'));
  const num = (label) => {
    const m = summary.match(new RegExp(`${label}:\\s*(-?\\d+(?:\\.\\d+)?)`));
    return m ? parseFloat(m[1]) : null;
  };
  return { integrated: num('I'), truePeak: num('Peak') };
}

const { integrated, truePeak } = measureLoudness(audioPath);
const gainDb = integrated !== null && Number.isFinite(integrated)
  ? Math.round((targetLufs - integrated) * 10) / 10
  : 0;

// Speech has a high crest factor, so the gain that reaches -14 LUFS would push
// peaks past 0 dBFS. A limiter catches those. Verified on this ffmpeg build that
// alimiter returns byte-identical PCM length, so it cannot shift the audio out
// from under the subtitles - that is the one property this pipeline cannot lose.
const limitLinear = Math.pow(10, TRUE_PEAK_CEILING / 20).toFixed(4);
const audioFilter = gainDb
  ? `volume=${gainDb}dB,alimiter=limit=${limitLinear}:level=disabled`
  : '';

// --- 3. one video encode per requested aspect ratio --------------------------
const escapedSrt = srtPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
const hasBg = background && fs.existsSync(background);

function renderVideo({ width, height, path: outputPath }) {
  const bgInput = hasBg
    ? ['-loop', '1', '-framerate', '25', '-i', background]
    : ['-f', 'lavfi', '-i', `color=c=0x14161A:s=${width}x${height}:r=25`];
  const bgFilter = hasBg
    ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`
    : 'setsar=1';

  // force_style numbers are ASS *script units*, not pixels. Converting an SRT
  // gives it the default PlayResY of 288, and libass then scales everything by
  // frameHeight/288. Feeding pixel values straight in therefore works by accident
  // at 720p and pushes the text clean off a 1920-tall frame - which renders as a
  // completely blank video, with no error. So metrics are chosen in pixels and
  // converted here.
  //
  // Portrait needs a far larger bottom margin than landscape: TikTok's caption
  // and button rail cover roughly the lower fifth of the screen.
  const portrait = height > width;
  const scale = height / ASS_PLAY_RES_Y;
  const toScriptUnits = (px) => Math.max(1, Math.round(px / scale));
  // Outline and shadow are script units too, and they are small enough that
  // rounding to a whole unit doubles them. ASS takes decimals here.
  const toScriptUnitsFine = (px) => Math.max(0.1, Math.round((px / scale) * 10) / 10);

  const fontPx = Math.round(width * (portrait ? 0.052 : 0.041));
  const marginPx = Math.round(height * (portrait ? 0.20 : 0.16));

  const style = [
    'FontName=DejaVu Sans', `FontSize=${toScriptUnits(fontPx)}`,
    'PrimaryColour=&H00FFFFFF', 'OutlineColour=&H00000000',
    'BorderStyle=1',
    `Outline=${toScriptUnitsFine(5)}`, `Shadow=${toScriptUnitsFine(2)}`,
    'Alignment=2', `MarginV=${toScriptUnits(marginPx)}`,
  ].join(',');

  const vf = [
    bgFilter,
    `subtitles='${escapedSrt}':fontsdir=/usr/share/fonts:force_style='${style}'`,
  ].join(',');

  const af = audioFilter ? ['-af', audioFilter] : [];

  ffmpeg([...bgInput, '-i', audioPath, '-vf', vf, ...af, '-t', String(durationSec),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-shortest', outputPath]);

  return {
    key: portrait ? 'portrait' : 'landscape',
    path: outputPath,
    width,
    height,
    sizeBytes: fs.statSync(outputPath).size,
  };
}

const rendered = outputs.map(renderVideo);

process.stdout.write(JSON.stringify({
  ok: true,
  output: rendered[0].path,
  outputs: rendered,
  srt: srtPath,
  segments: segs.length,
  durationSec: Math.round(durationSec * 100) / 100,
  sizeBytes: rendered[0].sizeBytes,
  loudness: {
    measuredLufs: integrated,
    measuredTruePeak: truePeak,
    gainDb,
    targetLufs,
    limiter: audioFilter ? `${TRUE_PEAK_CEILING} dBTP` : null,
  },
}));
