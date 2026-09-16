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

// --- 3. scenes: one still per sentence, crossfaded -------------------------
// Each scene is held for exactly as long as its cue - the sentence plus the
// shadowing gap - so the picture always matches the line being repeated. The
// timeline comes from the same segment durations the SRT was computed from, so
// pictures and subtitles cannot drift apart.
//
// A sentence whose image could not be fetched reuses its neighbour's rather than
// leaving a hole.
const XFADE_SEC = 0.6;
const FPS = 25;

function sceneForEachSegment() {
  const byIdx = new Map((plan.scenes ?? []).map((s) => [s.idx, s.file]));
  const available = segs.map((s) => byIdx.get(s.idx)).filter(Boolean);
  if (!available.length) return null;

  let lastSeen = available[0];
  return segs.map((seg) => {
    const file = byIdx.get(seg.idx);
    if (file) lastSeen = file;
    return { file: lastSeen, hold: seg.duration + gapSeconds };
  });
}

const sceneTimeline = sceneForEachSegment();

/**
 * Builds the inputs and filter chain for the scene slideshow.
 *
 * xfade consumes `XFADE_SEC` of overlap per transition, so each still is decoded
 * for its hold plus one transition and the k-th transition is offset to the sum
 * of every earlier hold. That puts each cut exactly on a cue boundary and makes
 * the chain output one transition longer than the audio, which `-t` then trims.
 */
function sceneChain(width, height) {
  const inputs = [];
  const filters = [];

  sceneTimeline.forEach(({ file, hold }, i) => {
    inputs.push('-loop', '1', '-framerate', String(FPS), '-t', (hold + XFADE_SEC).toFixed(3), '-i', file);
    filters.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase`
      + `,crop=${width}:${height},setsar=1,fps=${FPS},format=yuv420p[s${i}]`,
    );
  });

  let label = '[s0]';
  let offset = 0;
  for (let i = 1; i < sceneTimeline.length; i += 1) {
    offset += sceneTimeline[i - 1].hold;
    const out = i === sceneTimeline.length - 1 ? '[scenes]' : `[x${i}]`;
    filters.push(`${label}[s${i}]xfade=transition=fade:duration=${XFADE_SEC}:offset=${offset.toFixed(3)}${out}`);
    label = out;
  }
  if (sceneTimeline.length === 1) filters.push('[s0]null[scenes]');

  return { inputs, filters, label: '[scenes]' };
}

// --- 4. one video encode per requested aspect ratio --------------------------
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

  const subtitleFilter = `subtitles='${escapedSrt}':fontsdir=/usr/share/fonts:force_style='${style}'`;
  const af = audioFilter ? ['-af', audioFilter] : [];
  const encode = [
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-shortest', outputPath,
  ];

  if (!sceneTimeline) {
    ffmpeg([...bgInput, '-i', audioPath, '-vf', [bgFilter, subtitleFilter].join(','),
      ...af, '-t', String(durationSec), ...encode]);
  } else {
    // A photograph behind white text is far busier than the flat background, so
    // the picture is dimmed and a scrim laid under the subtitle band. The text
    // already carries an outline; this is what keeps it readable over a bright
    // sky or a white wall.
    const scrimH = Math.round(marginPx + fontPx * 4);
    const { inputs, filters } = sceneChain(width, height);
    const audioIndex = sceneTimeline.length;

    const graph = [
      ...filters,
      `[scenes]eq=brightness=-0.10:saturation=0.92`
      + `,drawbox=x=0:y=${height - scrimH}:w=${width}:h=${scrimH}:color=black@0.38:t=fill`
      + `,${subtitleFilter}[v]`,
    ].join(';');

    ffmpeg([...inputs, '-i', audioPath, '-filter_complex', graph,
      '-map', '[v]', '-map', `${audioIndex}:a`, ...af, '-t', String(durationSec), ...encode]);
  }

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
