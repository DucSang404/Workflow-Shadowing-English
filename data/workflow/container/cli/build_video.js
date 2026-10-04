#!/usr/bin/env node
/**
 * usage: node build_video.js <planPath>
 *
 * Pads each sentence with the shadowing gap, concatenates, optionally lays a
 * music bed underneath, puts the result over a background and burns the SRT in.
 * The audio is built once and reused for every requested aspect ratio, so asking
 * for both orientations costs one extra video encode rather than a second full run.
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

// Anything handed to an ffmpeg filter has to survive its own parser: `:` separates
// options and `'` quotes them, so every path that reaches one is escaped here.
const escapeFilterPath = (p) => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");

/**
 * Sample count, not seconds. This is the number the burned subtitles actually
 * depend on: two files can round to the same duration in seconds and still
 * differ by samples, and only the sample count proves nothing moved.
 */
function sampleCount(file) {
  const raw = ffprobe(['-select_streams', 'a:0', '-show_entries', 'stream=duration_ts',
    '-of', 'default=nw=1:nk=1', file]);
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/** ebur128 prints its summary to stderr even on success, so this needs spawnSync. */
function measureLoudness(file) {
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

// --- 1. voice: pad each sentence with the gap, then concat -------------------
const voicePath = path.join(workDir, 'voice.wav');
const voiceInputs = segs.flatMap((s) => ['-i', s.wav]);
const pads = segs.map((_, i) => `[${i}:a]apad=pad_dur=${gapSeconds},aresample=${SR}[a${i}]`).join(';');
const chain = segs.map((_, i) => `[a${i}]`).join('');
// The title card goes in front of the whole video, so the speech starts that much
// later. `adelay` takes whole milliseconds and at 24 kHz a millisecond is exactly
// 24 samples, which is what keeps this in lockstep with the identical shift
// 03_build_srt.js applied to every cue. A fractional offset here would be the
// start of exactly the drift this pipeline is built to prevent.
const introMs = plan.introMs ?? 0;
const delay = introMs ? `,adelay=${introMs}` : '';

ffmpeg([...voiceInputs, '-filter_complex',
  `${pads};${chain}concat=n=${segs.length}:v=0:a=1${delay}[aout]`,
  '-map', '[aout]', '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_s16le', voicePath]);

// Cheap, and it catches the one mistake that matters: if adelay ever rounded,
// every subtitle would be off by that much for the whole video.
if (introMs) {
  const want = Math.round((introMs / 1000) * SR);
  const got = sampleCount(voicePath) - segs.reduce((n, sg) => n + Math.round(sg.duration * SR)
    + Math.round(gapSeconds * SR), 0);
  if (Math.abs(got - want) > SR / 100) {
    console.error(`intro silence is ${got} samples, expected about ${want}`);
    process.exit(3);
  }
}

const durationSec = parseFloat(ffprobe(
  ['-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', voicePath]));
const voiceSamples = sampleCount(voicePath);
const voiceLoudness = measureLoudness(voicePath);

// --- 2. music bed ------------------------------------------------------------
// The bed is mixed in BEFORE loudness is measured, so the number the platform
// sees is the number that was targeted.
//
// The one property this pipeline cannot lose is that the audio stays exactly as
// long as the arithmetic the SRT was built from. So the bed is rendered to its
// own file, `amix` is told to end with the voice (`duration=first`), and the
// result's sample count is compared with the voice's. A mismatch means the mix
// moved something, and the mix is thrown away rather than shipped: silent
// subtitle drift is a far worse outcome than a video with no music.
//
// `normalize=0` matters. amix normalises by default, which would divide the
// speech by the number of inputs - a 6 dB cut to the voice to make room for a
// bed sitting 30 dB below it.
const MUSIC_FADE_IN = 2.0;
const MUSIC_FADE_OUT = 2.5;

const requestedMusic = plan.music && plan.music.file && fs.existsSync(plan.music.file)
  ? plan.music
  : null;

let audioPath = voicePath;
let music = null;

if (requestedMusic) {
  const musicDb = Number.isFinite(requestedMusic.db) ? requestedMusic.db : -24;
  try {
    const bedLoudness = measureLoudness(requestedMusic.file);
    // Programme loudness, not peak: the bed ends up `musicDb` under the speech as
    // the ear averages it, which is what "N dB under the voice" means.
    const bedGainDb = (Number.isFinite(bedLoudness.integrated) && Number.isFinite(voiceLoudness.integrated))
      ? Math.round(((voiceLoudness.integrated + musicDb) - bedLoudness.integrated) * 10) / 10
      : musicDb;

    const bedPath = path.join(workDir, 'music_bed.wav');
    const fadeOutStart = Math.max(0, durationSec - MUSIC_FADE_OUT);
    ffmpeg([
      // A bed shorter than the video simply repeats. At this level the seam is
      // inaudible, which is why no crossfade is spent on it.
      '-stream_loop', '-1', '-i', requestedMusic.file, '-t', durationSec.toFixed(6),
      '-af', [
        `volume=${bedGainDb}dB`,
        `afade=t=in:st=0:d=${MUSIC_FADE_IN}`,
        `afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${MUSIC_FADE_OUT}`,
      ].join(','),
      '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_s16le', bedPath,
    ]);

    const mixPath = path.join(workDir, 'full_audio.wav');
    ffmpeg(['-i', voicePath, '-i', bedPath,
      '-filter_complex', '[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]',
      '-map', '[aout]', '-ar', String(SR), '-ac', '1', '-c:a', 'pcm_s16le', mixPath]);

    const mixSamples = sampleCount(mixPath);
    if (voiceSamples !== null && mixSamples !== voiceSamples) {
      throw new Error(`mix changed the audio length (${voiceSamples} -> ${mixSamples} samples)`);
    }

    audioPath = mixPath;
    music = {
      used: true,
      source: requestedMusic.source ?? null,
      title: requestedMusic.title ?? null,
      creator: requestedMusic.creator ?? null,
      license: requestedMusic.license ?? null,
      attribution: requestedMusic.attribution ?? null,
      db: musicDb,
      bedGainDb,
      bedLufs: bedLoudness.integrated,
      loopedFrom: requestedMusic.durationSec ?? null,
      sampleExact: true,
    };
  } catch (err) {
    audioPath = voicePath;
    music = { used: false, reason: err.message, db: musicDb, sampleExact: null };
  }
}

// --- 3. loudness: measure, then apply a static gain plus a peak limiter ------
// Deliberately NOT the `loudnorm` filter. loudnorm resamples internally and can
// return a different number of samples than it was given, which would slide the
// burned subtitles out of sync with the audio they were computed from. Measuring
// once and applying a constant gain cannot do that, and `alimiter` was checked on
// this ffmpeg build to return byte-identical PCM length.
//
// -14 LUFS is what TikTok and YouTube normalise to, so hitting it means the
// platform leaves the audio alone.
const { integrated, truePeak } = audioPath === voicePath ? voiceLoudness : measureLoudness(audioPath);
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

// --- 4. scenes: one still per sentence, crossfaded -------------------------
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

const COVER_FONT_BOLD = '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf';
const COVER_FONT = '/usr/share/fonts/dejavu/DejaVuSans.ttf';
// DejaVu Sans Bold in capitals averages this much of the font size per glyph.
// Measured off a rendered cover, then rounded up: drawtext cannot report the width
// it produced, so a long title is shrunk against this estimate and erring high
// means erring towards text that fits.
const CAPS_ADVANCE_RATIO = 0.76;
const COVER_TEXT_WIDTH = 0.88; // fraction of the frame a title may occupy

/**
 * Writes a drawtext `textfile`, padded past an ffmpeg bug.
 *
 * drawtext measures each line of a textfile in BYTES and then renders that many
 * CHARACTERS, so every non-ASCII character silently costs one character off the
 * end of its own line. "SHADOWING · 6 LINES · 0:38" came out as "...0:", and a
 * Vietnamese topic lost a word per line. Padding each line with one trailing space
 * per extra UTF-8 byte feeds the truncation exactly what it wants to eat; the
 * spaces are what gets cut, so nothing is rendered that was not asked for.
 *
 * Verified against DejaVu Sans Bold at both frame sizes. `text=` was the other
 * option and is worse: the topic is user input and would need escaping through two
 * levels of ffmpeg parser.
 */
function writeTextFile(file, lines) {
  const padded = lines.map((line) => {
    const deficit = Buffer.byteLength(line, 'utf8') - [...line].length;
    return line + ' '.repeat(Math.max(0, deficit));
  });
  fs.writeFileSync(file, padded.join('\n'), 'utf8');
}

/** Greedy wrap, then an ellipsis if the title simply will not fit in `maxLines`. */
function wrapTitle(text, maxChars, maxLines) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (!line || next.length <= maxChars) line = next;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;

  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = `${kept[maxLines - 1].slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
  return kept;
}

/**
 * When to freeze. Default is early in the first scene but past the point where a
 * transition could be halfway through, so the cover is one clean picture rather
 * than two dissolved together.
 */

/**
 * Renders the branded title card to a png.
 *
 * Flat background rather than a dimmed photo, on purpose: the point of the card
 * is that every cover on the profile grid has the SAME structure, and a photo
 * behind it reintroduces exactly the variation it was added to remove. Only the
 * topic line changes between videos.
 *
 * Everything sits inside the middle of the frame. A profile grid crops a 9:16
 * cover towards a squarer shape, so anything near the top or bottom edge is the
 * first thing to be cut off.
 */
function renderCard(width, height) {
  const portrait = height > width;
  const brand = plan.brand ?? {};
  const accent = String(brand.accent ?? '#F5B544').replace('#', '0x');
  const cardPath = path.join(workDir, `card_${width}x${height}.png`);

  // Nothing may come within this much of an edge. A profile grid crops a 9:16
  // cover towards a squarer shape and TikTok's own chrome eats the rest, so the
  // card is laid out as if the frame were narrower and shorter than it is.
  const SAFE_W = 0.84;

  /** Largest size at which `chars` characters still fit inside the safe width. */
  const fit = (chars, cap) => Math.max(14, Math.floor(Math.min(cap, (width * SAFE_W) / (chars * CAPS_ADVANCE_RATIO))));

  // Letter-spaced by hand: drawtext has no tracking, and the channel name has to
  // read as a wordmark rather than as one more line of copy. The spacing doubles
  // the character count, which is why it gets fitted too - unfitted it ran off
  // both edges at 1080 wide.
  const wordmark = String(brand.name ?? '').toUpperCase().split('').join(' ');
  const namePx = fit([...wordmark].length, width * (portrait ? 0.042 : 0.032));

  // Wrapped short on purpose. Fewer characters per line means a bigger type size
  // for the same safe width, and at the size a profile grid actually renders,
  // three big lines beat two small ones.
  const titleLines = wrapTitle(String(plan.topic ?? '').toUpperCase() || 'SHADOWING', portrait ? 13 : 20, 3);
  const titlePx = fit(Math.max(...titleLines.map((l) => [...l].length), 1), width * (portrait ? 0.105 : 0.075));

  const kickerPx = Math.round(width * (portrait ? 0.026 : 0.020));
  const lineGap = Math.round(titlePx * 0.22);

  const nameFile = path.join(workDir, `card_name_${width}.txt`);
  const kickerFile = path.join(workDir, `card_kicker_${width}.txt`);
  const runtimeFile = path.join(workDir, `card_runtime_${width}.txt`);

  const mins = Math.floor(durationSec / 60);
  const secs = String(Math.round(durationSec % 60)).padStart(2, '0');

  writeTextFile(nameFile, [wordmark]);
  // One file per line, so each can be centred on its own. A single multi-line
  // drawtext centres the BLOCK and left-aligns the lines inside it, which left
  // a short last line hanging off to one side of an otherwise symmetric card.
  const titleFiles = titleLines.map((line, i) => {
    const file = path.join(workDir, `card_title_${width}_${i}.txt`);
    writeTextFile(file, [line]);
    return file;
  });
  writeTextFile(kickerFile, [String(brand.kicker ?? '').toUpperCase()]);
  // Through a textfile, not `text=`: a colon inside `text=` ends the option and
  // ffmpeg rejects the entire filter graph. "0:39" is enough to do it.
  writeTextFile(runtimeFile, [`${mins}:${secs}`]);

  // The block is measured in JS and centred as a whole, because drawtext can only
  // see its own text_h - stacking by eye leaves a different gap every time the
  // title wraps to a different number of lines.
  const LINE = 1.18;
  const ruleH = Math.max(3, Math.round(height * 0.0035));
  const ruleW = Math.round(width * 0.14);
  const titleStep = Math.round(titlePx * LINE + lineGap);
  const titleH = titleLines.length * titleStep - lineGap;

  const gapAfterName = Math.round(height * 0.022);
  const gapAfterRule = Math.round(height * 0.030);
  const gapBeforeKicker = Math.round(height * 0.038);
  const gapAfterKicker = Math.round(height * 0.016);

  const blockH = namePx * LINE + gapAfterName + ruleH + gapAfterRule + titleH
    + gapBeforeKicker + kickerPx * LINE + gapAfterKicker + kickerPx * LINE;

  // Slightly above centre: the lower half of a 9:16 frame is where TikTok puts
  // the caption and the button rail.
  let y = Math.round(height * 0.44 - blockH / 2);
  const nameY = y;
  y += Math.round(namePx * LINE) + gapAfterName;
  const ruleY = y;
  y += ruleH + gapAfterRule;
  const titleY = y;
  y += Math.round(titleH) + gapBeforeKicker;
  const kickerY = y;
  y += Math.round(kickerPx * LINE) + gapAfterKicker;
  const runtimeY = y;

  // An outline on every line, because the backdrop is now a photograph rather
  // than a flat slab: without it a title crossing a bright window or a pale wall
  // loses its edges exactly where it matters. Cheap insurance, and it lets the
  // backdrop stay light enough to actually be seen.
  const text = (file, px, colour, top, bold = true) => [
    `drawtext=fontfile='${escapeFilterPath(bold ? COVER_FONT_BOLD : COVER_FONT)}'`,
    `textfile='${escapeFilterPath(file)}'`,
    `fontcolor=${colour}`,
    `fontsize=${px}`,
    `line_spacing=${lineGap}`,
    `borderw=${Math.max(1, Math.round(px * 0.045))}`,
    'bordercolor=0x0E1014@0.9',
    'x=(w-text_w)/2',
    `y=${top}`,
  ].join(':');

  // A backdrop of the place the conversation happens in, rather than a flat slab.
  // The layout above does not change - only what sits behind it - so the profile
  // grid still reads as one series.
  //
  // It has to be pushed well down before any text goes on it, in two stages: `eq`
  // takes the brightness and colour out of the picture, then a full-frame wash in
  // the brand background colour floors the contrast. Either alone left the title
  // fighting with whatever happened to be behind it.
  const backdrop = plan.coverBackground && fs.existsSync(plan.coverBackground)
    ? plan.coverBackground
    : null;

  const base = backdrop
    ? ['-i', backdrop]
    : ['-f', 'lavfi', '-i', `color=c=0x0E1014:s=${width}x${height}`];

  const dim = backdrop
    ? [
      `scale=${width}:${height}:force_original_aspect_ratio=increase`,
      `crop=${width}:${height}`,
      'eq=brightness=-0.22:saturation=0.62',
      `drawbox=x=0:y=0:w=${width}:h=${height}:color=0x0E1014@0.42:t=fill`,
    ]
    : [];

  ffmpeg([
    ...base,
    '-frames:v', '1',
    '-vf', [
      ...dim,
      text(nameFile, namePx, accent, nameY),
      // x is computed here, not as `(w-${ruleW})/2`. drawbox evaluates its
      // geometry ONCE at configuration time, where `w` is not yet known and
      // reads as 0 - the rule silently lands against the left edge. Same trap as
      // the animated box in CLAUDE.md.
      `drawbox=x=${Math.round((width - ruleW) / 2)}:y=${ruleY}:w=${ruleW}:h=${ruleH}:color=${accent}:t=fill`,
      ...titleFiles.map((file, i) => text(file, titlePx, 'white', titleY + i * titleStep)),
      text(kickerFile, kickerPx, 'white@0.5', kickerY, false),
      text(runtimeFile, kickerPx, 'white@0.4', runtimeY, false),
    ].join(','),
    cardPath,
  ]);

  return cardPath;
}

const sceneTimeline = sceneForEachSegment();
const introSec = introMs / 1000;

/**
 * The flat fallback, as a still, so that a run with no usable photos takes the
 * same code path as one with them instead of a second branch that is almost
 * never exercised.
 */
function flatBackground(width, height) {
  const file = path.join(workDir, `bg_${width}x${height}.png`);
  if (hasBg) {
    ffmpeg(['-i', background, '-frames:v', '1', '-vf',
      `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`, file]);
  } else {
    ffmpeg(['-f', 'lavfi', '-i', `color=c=0x14161A:s=${width}x${height}`, '-frames:v', '1', file]);
  }
  return file;
}

/** Card first, then the scenes - or the flat still if there were none. */
function timelineFor(width, height) {
  const body = sceneTimeline
    ?? [{ file: flatBackground(width, height), hold: durationSec - introSec }];
  if (!introMs) return body;
  return [{ file: renderCard(width, height), hold: introSec, raw: true }, ...body];
}

/**
 * Builds the inputs and filter chain for the scene slideshow.
 *
 * xfade consumes `XFADE_SEC` of overlap per transition, so each still is decoded
 * for its hold plus one transition and the k-th transition is offset to the sum
 * of every earlier hold. That puts each cut exactly on a cue boundary and makes
 * the chain output one transition longer than the audio, which `-t` then trims.
 */
function sceneChain(timeline, width, height) {
  const inputs = [];
  const filters = [];

  timeline.forEach(({ file, hold, raw }, i) => {
    inputs.push('-loop', '1', '-framerate', String(FPS), '-t', (hold + XFADE_SEC).toFixed(3), '-i', file);
    // A photograph behind white text is far busier than a flat background, so
    // each scene is dimmed and gets a scrim under the subtitle band. Applied per
    // scene rather than to the whole chain because the title card must NOT be
    // touched - it is already designed, and dimming it would mute the accent.
    const { scrimH } = frameMetrics(width, height);
    const dress = raw ? '' : `,eq=brightness=-0.10:saturation=0.92`
      + `,drawbox=x=0:y=${height - scrimH}:w=${width}:h=${scrimH}:color=black@0.38:t=fill`;
    filters.push(
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=increase`
      + `,crop=${width}:${height},setsar=1,fps=${FPS},format=yuv420p${dress}[s${i}]`,
    );
  });

  let label = '[s0]';
  let offset = 0;
  for (let i = 1; i < timeline.length; i += 1) {
    offset += timeline[i - 1].hold;
    const out = i === timeline.length - 1 ? '[scenes]' : `[x${i}]`;
    filters.push(`${label}[s${i}]xfade=transition=fade:duration=${XFADE_SEC}:offset=${offset.toFixed(3)}${out}`);
    label = out;
  }
  if (timeline.length === 1) filters.push('[s0]null[scenes]');

  return { inputs, filters, label: '[scenes]' };
}

/**
 * Subtitle geometry for a frame size, in pixels.
 *
 * This is the single source of truth for where the text sits. The video burns it
 * in from here and the cover erases exactly this band - if the two ever computed
 * it separately, the cover would cut the subtitle in half and nothing would say so.
 */
function frameMetrics(width, height) {
  const portrait = height > width;
  const fontPx = Math.round(width * (portrait ? 0.052 : 0.041));
  // Portrait needs a far larger bottom margin than landscape: TikTok's caption
  // and button rail cover roughly the lower fifth of the screen.
  const marginPx = Math.round(height * (portrait ? 0.20 : 0.16));
  return { portrait, fontPx, marginPx, scrimH: Math.round(marginPx + fontPx * 4) };
}

// --- 5. one video encode per requested aspect ratio --------------------------
const escapedSrt = escapeFilterPath(srtPath);
const hasBg = background && fs.existsSync(background);

function renderVideo({ width, height, path: outputPath }) {
  const { portrait, fontPx, marginPx } = frameMetrics(width, height);

  // force_style numbers are ASS *script units*, not pixels. Converting an SRT
  // gives it the default PlayResY of 288, and libass then scales everything by
  // frameHeight/288. Feeding pixel values straight in therefore works by accident
  // at 720p and pushes the text clean off a 1920-tall frame - which renders as a
  // completely blank video, with no error. So metrics are chosen in pixels and
  // converted here.
  const scale = height / ASS_PLAY_RES_Y;
  const toScriptUnits = (px) => Math.max(1, Math.round(px / scale));
  // Outline and shadow are script units too, and they are small enough that
  // rounding to a whole unit doubles them. ASS takes decimals here.
  const toScriptUnitsFine = (px) => Math.max(0.1, Math.round((px / scale) * 10) / 10);

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

  const timeline = timelineFor(width, height);
  const { inputs, filters } = sceneChain(timeline, width, height);

  ffmpeg([...inputs, '-i', audioPath,
    '-filter_complex', [...filters, `[scenes]${subtitleFilter}[v]`].join(';'),
    '-map', '[v]', '-map', `${timeline.length}:a`, ...af, '-t', String(durationSec), ...encode]);

  return {
    key: portrait ? 'portrait' : 'landscape',
    path: outputPath,
    width,
    height,
    sizeBytes: fs.statSync(outputPath).size,
  };
}

// --- 6. cover ----------------------------------------------------------------
// The frame is pulled from the file that actually shipped, so the cover can never
// advertise a video that was not made. What it must not show is the burned-in
// subtitle: a cover is read at thumbnail size and a line of dialogue there is
// noise. The subtitle band is erased using the same geometry that drew it, and
// the strip is reused as a footer so it reads as design rather than a redaction.
function coverTimestamp() {
  if (Number.isFinite(plan.thumbnailTime)) {
    return Math.min(Math.max(0, plan.thumbnailTime), Math.max(0, durationSec - 0.2));
  }
  // Mid-card. This number is what buffer-publish hands Buffer as thumbnailOffset,
  // so it decides what the profile grid shows - and the card is the only frame
  // that looks the same on every video. Half way in keeps clear of the xfade
  // that starts at the end of the card's hold.
  if (introMs) return introSec / 2;
  const firstHold = sceneTimeline ? sceneTimeline[0].hold : durationSec;
  return Math.max(0.4, Math.min(firstHold * 0.45, 3.0, Math.max(0.4, durationSec - 0.5)));
}

function renderCover(video) {
  const coverPath = video.path.replace(/\.mp4$/, '_cover.jpg');

  // With a title card in front, the cover is simply the frame Buffer will pick -
  // already branded, already free of burned-in subtitle. Nothing to erase and
  // nothing to caption, so this is a straight grab and the two can never
  // disagree about what the cover shows.
  if (introMs) {
    ffmpeg(['-ss', coverTimestamp().toFixed(3), '-i', video.path, '-frames:v', '1',
      '-q:v', '2', coverPath]);
    return {
      key: video.key,
      path: coverPath,
      width: video.width,
      height: video.height,
      atSec: Math.round(coverTimestamp() * 100) / 100,
      title: String(plan.topic ?? ''),
      fromCard: true,
      sizeBytes: fs.statSync(coverPath).size,
    };
  }

  const { portrait, scrimH } = frameMetrics(video.width, video.height);
  const topic = String(plan.topic ?? '').trim() || 'shadowing practice';

  const maxChars = portrait ? 16 : 24;
  const titleLines = wrapTitle(topic.toUpperCase(), maxChars, 3);
  const longest = Math.max(...titleLines.map((l) => [...l].length), 1);
  const titlePx = Math.max(20, Math.floor(Math.min(
    video.width * (portrait ? 0.095 : 0.070),
    (video.width * COVER_TEXT_WIDTH) / (longest * CAPS_ADVANCE_RATIO),
  )));

  const mins = Math.floor(durationSec / 60);
  const secs = String(Math.round(durationSec % 60)).padStart(2, '0');
  const footerPx = Math.max(12, Math.round(video.width * (portrait ? 0.024 : 0.020)));

  // Written to files rather than inlined: drawtext's `text=` would need every
  // colon, backslash, quote and percent sign escaped, and a topic is user input.
  const titleFile = path.join(workDir, `cover_title_${video.key}.txt`);
  const footerFile = path.join(workDir, `cover_footer_${video.key}.txt`);
  writeTextFile(titleFile, titleLines);
  writeTextFile(footerFile, [`SHADOWING · ${segs.length} LINES · ${mins}:${secs}`]);

  // Where the title goes depends on how much of the frame the strip eats, and that
  // is decided by the subtitle geometry rather than by taste. A 9:16 frame gives
  // the strip about a third and the picture keeps the rest, so the title sits in
  // the picture - which is also the only place TikTok will not crop it away in the
  // profile grid. A 16:9 frame gives the strip nearly half, and a title floating
  // above a near-empty black slab looks like an accident, so it moves into it.
  const footerBand = Math.round(footerPx * 2.6);
  const titleInBand = scrimH / video.height > 0.34;
  const titleY = titleInBand
    ? `${video.height - scrimH}+(${scrimH}-${footerBand}-text_h)/2`
    // Nudged above dead centre: at thumbnail size a title that sits high reads
    // faster, and it keeps clear of the strip.
    : `(h-${scrimH}-text_h)/2-${Math.round(video.height * 0.04)}`;
  const footerY = titleInBand
    ? `${video.height - footerBand}+(${footerBand}-text_h)/2`
    : `${video.height - scrimH}+(${scrimH}-text_h)/2`;

  const filters = [
    'eq=brightness=-0.18:saturation=0.90',
    // The burned-in subtitle has to go, and it has to go completely. White text
    // with a black outline stays legible through anything short of opaque: 0.92
    // left the whole line readable and even 0.985 left a ghost of it, because a
    // 1.5% white on a flat dark slab is still four levels of difference. So the
    // strip is solid, in the same colour as the flat background, with a hairline
    // along its top edge so it reads as a caption bar rather than a redaction.
    //
    // Its height is the video's own subtitle geometry, not a guess: whatever the
    // scrim was tall enough to sit behind, this is tall enough to cover.
    `drawbox=x=0:y=${video.height - scrimH}:w=${video.width}:h=${scrimH}:color=0x14161A:t=fill`,
    `drawbox=x=0:y=${video.height - scrimH}:w=${video.width}:h=${Math.max(2, Math.round(video.height * 0.002))}:color=white@0.16:t=fill`,
    [
      `drawtext=fontfile='${escapeFilterPath(COVER_FONT_BOLD)}'`,
      `textfile='${escapeFilterPath(titleFile)}'`,
      'fontcolor=white',
      `fontsize=${titlePx}`,
      `line_spacing=${Math.round(titlePx * 0.22)}`,
      `borderw=${Math.max(2, Math.round(titlePx * 0.055))}`,
      'bordercolor=black@0.85',
      'shadowx=0',
      `shadowy=${Math.max(2, Math.round(titlePx * 0.06))}`,
      'shadowcolor=black@0.5',
      'x=(w-text_w)/2',
      `y=${titleY}`,
    ].join(':'),
    [
      `drawtext=fontfile='${escapeFilterPath(COVER_FONT)}'`,
      `textfile='${escapeFilterPath(footerFile)}'`,
      'fontcolor=white@0.72',
      `fontsize=${footerPx}`,
      'x=(w-text_w)/2',
      `y=${footerY}`,
    ].join(':'),
  ].join(',');

  ffmpeg(['-ss', coverTimestamp().toFixed(3), '-i', video.path, '-frames:v', '1',
    '-vf', filters, '-q:v', '2', coverPath]);

  return {
    key: video.key,
    path: coverPath,
    width: video.width,
    height: video.height,
    atSec: Math.round(coverTimestamp() * 100) / 100,
    title: titleLines.join(' / '),
    sizeBytes: fs.statSync(coverPath).size,
  };
}

const rendered = outputs.map(renderVideo);

// A cover is packaging, not the product: a failure here is reported and the run
// still returns its videos.
const covers = [];
let coverError = null;
if (plan.thumbnail !== false) {
  for (const video of rendered) {
    try {
      covers.push(renderCover(video));
    } catch (err) {
      coverError = err.message.split('\n').slice(-3).join(' ').slice(0, 300);
    }
  }
}

process.stdout.write(JSON.stringify({
  ok: true,
  output: rendered[0].path,
  outputs: rendered,
  cover: covers[0]?.path ?? null,
  covers,
  coverError,
  srt: srtPath,
  segments: segs.length,
  durationSec: Math.round(durationSec * 100) / 100,
  sizeBytes: rendered[0].sizeBytes,
  introSec,
  audio: {
    sampleRate: SR,
    voiceSamples,
    finalSamples: sampleCount(audioPath),
  },
  music,
  loudness: {
    measuredLufs: integrated,
    measuredTruePeak: truePeak,
    voiceLufs: voiceLoudness.integrated,
    gainDb,
    targetLufs,
    limiter: audioFilter ? `${TRUE_PEAK_CEILING} dBTP` : null,
  },
}));
