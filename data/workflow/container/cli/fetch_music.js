#!/usr/bin/env node
/**
 * usage: node fetch_music.js <sentenceDir>
 *
 * Resolves ONE background-music bed for the run and reports it on stdout.
 * Finding nothing is a normal outcome, not an error: the script still exits 0
 * with `music: null` and build_video.js simply ships speech-only audio.
 *
 * Two sources, in the same order as the scene fetcher, for the same reason —
 * a local file you chose beats a lottery on a public index:
 *
 *   1. assets/music/  - whatever you dropped in there. No network, no licence
 *                       question, and the same bed every run if you keep one file.
 *   2. Openverse      - keyless CC0 audio. Only `cc0,pdm` is accepted here, never
 *                       `by`: a photo credit fits in a JSON record, but a credit
 *                       obligation attached to the *soundtrack* of an upload is a
 *                       promise this pipeline cannot keep on the platform side.
 *
 * Downloads are kept in assets/music/.openverse/ and reused. Fetching one costs
 * about 35 seconds against a 15-second pipeline, which is not a price worth paying
 * on every run for audio that sits 30 dB down. So the first few runs build a small
 * library and every run after that picks from it instantly, with the variety that
 * several beds gives. Delete the folder to start again.
 *
 * The query is about MOOD, not the topic. A bed under "asking for directions"
 * should not be traffic noise; it should be something quiet that stays out of the
 * way, so the topic is deliberately not searched for.
 *
 * Whatever comes back is decoded by ffprobe before it is believed — the same rule
 * fetch_scenes.js learned the hard way: HTTP 200 does not prove it is audio.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = process.argv[2];
const ASSETS_DIR = '/data/workflow/assets/music';
const CACHE_DIR = path.join(ASSETS_DIR, '.openverse');
// Stop downloading once the library is this big: past here a random pick already
// gives enough variety, and a run should not pay 35s for one more.
const CACHE_TARGET = 3;

const AUDIO_EXT = ['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus'];
const MIN_BYTES = 32 * 1024;
const MAX_BYTES = 24 * 1024 * 1024;
// Shorter than this and the loop seam comes round often enough to notice even at
// -30 dB; longer than this is a slow download for audio nobody listens to.
const MIN_BED_SEC = 20;
const MAX_BED_SEC = 900;
const SEARCH_TIMEOUT_MS = 15000;
const DOWNLOAD_TIMEOUT_MS = 45000;

// Wikimedia and Flickr answer a bare fetch() with HTTP 429; Openverse is friendlier
// but asks the same. Identify the client everywhere.
const UA = 'shadowing-video/1.0 (self-hosted n8n pipeline; +https://github.com/n8n-io/n8n)';

// Verified against the live API: each of these returns actual instrumental music
// under cc0, not field recordings. Order is preference; they are tried in turn.
const MOOD_QUERIES = [
  'soft piano background music',
  'ambient music loop',
  'lofi hip hop beat',
  'calm guitar instrumental',
  'relaxing ambient pad',
];

const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const cfg = manifest.music ?? {};

// writeSync, not process.stdout.write: stdout is a pipe here and process.exit()
// can cut an asynchronous write off mid-JSON, which the Code node downstream
// would report as a parse error on a run that actually succeeded.
const done = (music, reason, trace) => {
  fs.writeSync(1, JSON.stringify({ music, reason, trace: (trace ?? []).slice(-6) }));
  process.exit(0);
};

/**
 * ffprobe is the arbiter of "is this really audio". A download that decodes to
 * nothing, a HTML error page saved with an .mp3 name, a 3-second sting — all of
 * them fail here rather than halfway through the video build.
 */
function probeAudio(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_type', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' });
  const lines = out.trim().split('\n').map((l) => l.trim());
  if (!lines.includes('audio')) throw new Error('no audio stream');
  const duration = parseFloat(lines[lines.length - 1]);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('bad duration');
  return duration;
}

/** Audio files sitting directly in a directory, sorted for a stable listing. */
function audioFilesIn(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((f) => AUDIO_EXT.includes(path.extname(f).toLowerCase()))
    .sort()
    .map((f) => path.join(directory, f));
}

/** Several files means variety between runs rather than the same bed every time. */
const pickOne = (files) => files[Math.floor(Math.random() * files.length)];

function explicitFile(trace) {
  if (!cfg.file) return null;
  // A bare name resolves inside assets/music/; an absolute path is taken as given.
  const file = cfg.file.startsWith('/') ? cfg.file : path.join(ASSETS_DIR, cfg.file);
  if (fs.existsSync(file)) return file;
  trace.push(`music file not found: ${file}`);
  return null;
}

/** Whatever was written beside a cached download, so a cache hit still has a title. */
function cachedMeta(file) {
  try {
    return JSON.parse(fs.readFileSync(`${file}.json`, 'utf8'));
  } catch {
    return {};
  }
}

const withTimeout = async (url, opts = {}, ms = SEARCH_TIMEOUT_MS) => {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: control.signal });
  } finally {
    clearTimeout(timer);
  }
};

async function openverseSearch(query) {
  const url = 'https://api.openverse.org/v1/audio/'
    + `?q=${encodeURIComponent(query)}&license=cc0,pdm&page_size=8&mature=false`;
  const res = await withTimeout(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`search http ${res.status}`);

  const body = await res.json();
  return (body.results ?? [])
    // `duration` is milliseconds here, unlike everything else in this pipeline.
    .filter((r) => r.url && (r.duration ?? 0) >= MIN_BED_SEC * 1000
      && (r.duration ?? 0) <= MAX_BED_SEC * 1000)
    .map((r) => ({
      id: r.id,
      url: r.url,
      title: r.title ?? 'untitled',
      creator: r.creator ?? 'unknown',
      license: r.license,
      provider: r.provider ?? 'openverse',
      landingUrl: r.foreign_landing_url ?? null,
      matchedQuery: query,
    }));
}

async function download(url, dest) {
  let res;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    res = await withTimeout(url, { redirect: 'follow', headers: { 'User-Agent': UA } },
      DOWNLOAD_TIMEOUT_MS);
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 600 * 2 ** attempt));
  }
  if (!res.ok) throw new Error(`http ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < MIN_BYTES) throw new Error(`too small (${buf.length} bytes)`);
  if (buf.length > MAX_BYTES) throw new Error(`too large (${Math.round(buf.length / 1048576)} MB)`);

  fs.writeFileSync(dest, buf);
  return probeAudio(dest);
}

(async () => {
  const trace = [];

  if (cfg.enabled === false) done(null, 'music disabled for this run', trace);

  /** Shared shape for a bed that came off the disk, wherever the disk got it. */
  const fromDisk = (file, source, reason) => {
    const meta = source === 'cache' ? cachedMeta(file) : {};
    return done({
      file,
      source: meta.source ?? source,
      title: meta.title ?? path.basename(file),
      creator: meta.creator ?? null,
      license: meta.license ?? null,
      // cc0 and pdm oblige nobody, so there is no credit line to print — the names
      // are kept in the run record as a courtesy, not a requirement.
      attribution: null,
      matchedQuery: meta.matchedQuery ?? null,
      landingUrl: meta.landingUrl ?? null,
      durationSec: Math.round(probeAudio(file) * 100) / 100,
    }, reason, trace);
  };

  const explicit = explicitFile(trace);
  if (explicit) {
    try {
      fromDisk(explicit, 'local', 'explicit file');
    } catch (err) {
      trace.push(`${path.basename(explicit)}: ${err.message}`);
    }
  }

  // Your own files beat anything downloaded, always.
  const own = audioFilesIn(ASSETS_DIR);
  if (own.length) {
    const file = pickOne(own);
    try {
      fromDisk(file, 'local', 'local asset');
    } catch (err) {
      trace.push(`${path.basename(file)}: ${err.message}`);
    }
  }

  const cached = audioFilesIn(CACHE_DIR);
  if (cached.length >= CACHE_TARGET) {
    try {
      fromDisk(pickOne(cached), 'cache', 'cached download');
    } catch (err) {
      trace.push(`cache: ${err.message}`);
    }
  }

  const queries = cfg.query ? [cfg.query, ...MOOD_QUERIES] : MOOD_QUERIES;
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  for (const query of [...new Set(queries)]) {
    let hits = [];
    try {
      hits = await openverseSearch(query);
    } catch (err) {
      trace.push(`"${query}": ${err.message}`);
      continue;
    }
    if (!hits.length) {
      trace.push(`"${query}": no usable result`);
      continue;
    }

    for (const hit of hits.slice(0, 3)) {
      const dest = path.join(CACHE_DIR, `${hit.id}.mp3`);
      if (fs.existsSync(dest)) continue;
      try {
        const duration = await download(hit.url, dest);
        const meta = {
          source: hit.provider,
          title: hit.title,
          creator: hit.creator,
          license: hit.license,
          matchedQuery: hit.matchedQuery,
          landingUrl: hit.landingUrl,
        };
        fs.writeFileSync(`${dest}.json`, JSON.stringify(meta, null, 2), 'utf8');
        done({
          file: dest,
          ...meta,
          attribution: null,
          durationSec: Math.round(duration * 100) / 100,
        }, `openverse "${query}"`, trace);
      } catch (err) {
        fs.rmSync(dest, { force: true });
        trace.push(`${new URL(hit.url).host}: ${err.message}`);
      }
    }
  }

  // Nothing new downloaded - but a half-full cache is still a bed.
  if (cached.length) {
    try {
      fromDisk(pickOne(cached), 'cache', 'cached download (search found nothing new)');
    } catch (err) {
      trace.push(`cache: ${err.message}`);
    }
  }

  done(null, 'no usable music found', trace);
})().catch((err) => {
  // A missing bed must never cost a finished video, so even an unexpected throw
  // reports "no music" and exits clean.
  done(null, `music lookup failed: ${err.message}`, [err.message]);
});
