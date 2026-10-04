#!/usr/bin/env node
/**
 * usage: node fetch_scenes.js <sentenceDir>
 *
 * Finds one still per sentence and downloads it to <dir>/scene_NNN.jpg.
 *
 * Three sources, in order:
 *   0. Local generator - SD 1.5 + LCM on the HOST at host.docker.internal:7860.
 *                    Docker on macOS cannot reach the GPU, so it cannot live in
 *                    compose. Tried first because it is the only source that
 *                    always matches the sentence: limitation #13 in docs.md
 *                    measured 2 usable photos out of 8 from the CC0 archives on
 *                    an office topic.
 *   1. Pexels      - polished stock, needs a key. The key never reaches this
 *                    script: the workflow's Pexels node (which holds the n8n
 *                    credential) writes its results to pexels.json first, and
 *                    this script only reads those. See CLAUDE.md, "Secrets".
 *   2. Openverse   - Creative Commons photos, keyless, so scenes still work with
 *                    no Pexels key configured at all.
 *
 * The generator is a preference, not a dependency: if it does not answer, the
 * run falls through to the stock tiers and nothing fails.
 *
 * The important design point is that a search yields *candidates*, not an answer.
 * Openverse indexes many providers and some of them (Wikimedia in particular)
 * answer this host with HTTP 429 while others serve happily, so taking only the
 * top hit lost 4 of 6 scenes. Every candidate is tried until one downloads and
 * decodes.
 *
 * A sentence with no usable image is reported in `missing`; build_video.js falls
 * back to the plain background for it rather than failing the run.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = process.argv[2];

const MIN_BYTES = 8 * 1024;
const MAX_BYTES = 12 * 1024 * 1024;   // a 6000x4000 original is not worth waiting for
const SEARCH_TIMEOUT_MS = 15000;
const DOWNLOAD_TIMEOUT_MS = 45000;
const MAX_PARALLEL = 3;               // be a polite guest on a keyless public API
const NORMALISE_WIDTH = 1920;         // every scene is downscaled to this at most
const MAX_CANDIDATES = 10;

const IMAGEGEN_URL = 'http://host.docker.internal:7860';
// Short: this only asks whether the service is up, and that answer decides
// whether six generate calls are worth attempting at all.
const IMAGEGEN_HEALTH_MS = 1500;
// Generous: four LCM steps on an M2 is seconds, but the first call of a session
// also pays for the model being paged in.
const IMAGEGEN_MS = 120000;

// Wikimedia and Flickr both reject clients that do not identify themselves, and
// Wikimedia asks for a contact. A bare fetch() gets HTTP 429.
const UA = 'shadowing-video/1.0 (self-hosted n8n pipeline; +https://github.com/n8n-io/n8n)';

// Licences in order of how little they oblige the uploader: cc0/pdm need no
// credit, `by` needs a credit line. by-sa is excluded on purpose - its
// share-alike terms would reach the whole upload.
const LICENCE_TIERS = ['cc0,pdm', 'by'];

const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));

// Written by the workflow's Pexels node when a key is configured; absent otherwise.
let pexelsByIdx = {};
const pexelsFile = path.join(dir, 'pexels.json');
if (fs.existsSync(pexelsFile)) {
  try {
    pexelsByIdx = JSON.parse(fs.readFileSync(pexelsFile, 'utf8'));
  } catch {
    pexelsByIdx = {};
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

/**
 * A phrase like "passport and key card" returns nothing while "passport" returns
 * plenty, so the query is relaxed in steps.
 */
function queryTiers(query, topic) {
  const words = query.split(/\s+/).filter(Boolean);
  const tiers = [query];

  // Drop words from the FRONT, not the back. English puts the head noun last, so
  // "printed hotel invoice" relaxes to "hotel invoice" and then "invoice".
  // Trimming the other way gave "printed hotel", which returned an 18th-century
  // engraving of the Hotel des Invalides.
  //
  // Stop while at least two words remain: a lone generic noun matches anything.
  // "handover" returned a soldier holding a microphone, "March" an engraved
  // silver plate. The topic is a better bet than a single word, so it goes ahead
  // of them and the one-word forms are the last resort.
  for (let drop = 1; words.length - drop >= 2; drop += 1) {
    tiers.push(words.slice(drop).join(' '));
  }
  if (topic && topic !== query) tiers.push(topic);
  if (words.length > 1) tiers.push(words[words.length - 1]);

  return [...new Set(tiers)];
}

async function openverseSearch(query, licence) {
  const url = 'https://api.openverse.org/v1/images/'
    + `?q=${encodeURIComponent(query)}&license=${licence}`
    + '&aspect_ratio=wide&size=large&page_size=8&mature=false';
  const res = await withTimeout(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return [];

  const body = await res.json();
  return (body.results ?? [])
    // Skip giant originals: a 6000x4000 scan is a slow download and gets scaled
    // down to 1920 immediately anyway.
    .filter((r) => r.url && (r.width ?? 0) >= 900 && (r.width ?? 0) <= 5000)
    .map((r) => ({
      url: r.url,
      source: 'openverse',
      license: r.license,
      matchedQuery: query,
      // Only a `by` image obliges the uploader to print a credit.
      attribution: r.license === 'by'
        ? `"${r.title ?? 'untitled'}" by ${r.creator ?? 'unknown'} (CC BY) - ${r.foreign_landing_url ?? r.url}`
        : null,
    }));
}

/** Candidates across every licence and query tier, best first, deduped. */
async function openverseCandidates(query, topic, trace) {
  const out = [];
  const seen = new Set();

  for (const licence of LICENCE_TIERS) {
    for (const term of queryTiers(query, topic)) {
      if (out.length >= MAX_CANDIDATES) return out;
      try {
        const hits = await openverseSearch(term, licence);
        if (!hits.length) trace.push(`${licence}/"${term}": no result`);
        for (const hit of hits) {
          if (seen.has(hit.url)) continue;
          seen.add(hit.url);
          out.push(hit);
        }
      } catch (err) {
        trace.push(`${licence}/"${term}": ${err.message}`);
      }
    }
  }
  return out;
}

async function download(url, dest) {
  let res;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    res = await withTimeout(url, {
      redirect: 'follow',
      headers: { 'User-Agent': UA },
    }, DOWNLOAD_TIMEOUT_MS);
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 600 * 2 ** attempt));
  }
  if (!res.ok) throw new Error(`http ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < MIN_BYTES) throw new Error(`too small (${buf.length} bytes)`);
  if (buf.length > MAX_BYTES) throw new Error(`too large (${Math.round(buf.length / 1048576)} MB)`);

  const raw = `${dest}.raw`;
  fs.writeFileSync(raw, buf);

  // Re-encode rather than trust the download: a 200 response is not proof of an
  // image (error pages save happily), and normalising the size here keeps work/
  // small and the later video encode predictable. ffmpeg failing is the check.
  try {
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', raw,
      '-vf', `scale='min(${NORMALISE_WIDTH},iw)':-2`, '-q:v', '4', dest], { stdio: 'pipe' });
  } catch {
    throw new Error('not a decodable image');
  } finally {
    fs.rmSync(raw, { force: true });
  }
}

/**
 * Asks the host generator for one scene. Returns null when it is not running,
 * which is the normal case for anyone who has not started it.
 */
async function generateScene(sentence, dest, trace) {
  try {
    const res = await withTimeout(`${IMAGEGEN_URL}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // imagePrompt, NOT imageQuery. The query is keywords for a stock index and
      // a diffusion model reads it as noise - measured, it returned a Persian
      // manuscript for "team standup meeting office whiteboard". The prompt is
      // the same scene written as a sentence, which works.
      body: JSON.stringify({
        prompt: sentence.imagePrompt || sentence.imageQuery || manifest.topic,
        // Which of the two recurring characters is speaking this line. The
        // dialogue already alternates A and B, so the series gets a consistent
        // cast for free - the generator looks up assets/characters/<A|B>.png and
        // conditions on it.
        character: sentence.speaker ?? null,
      }),
    }, IMAGEGEN_MS);

    if (!res.ok) {
      throw new Error(`http ${res.status} ${(await res.text().catch(() => '')).slice(0, 120)}`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < MIN_BYTES) throw new Error(`too small (${buf.length} bytes)`);

    const raw = `${dest}.raw`;
    fs.writeFileSync(raw, buf);
    try {
      // Same rule as a download: let ffmpeg decode it before believing it.
      execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', raw,
        '-vf', `scale='min(${NORMALISE_WIDTH},iw)':-2`, '-q:v', '4', dest], { stdio: 'pipe' });
    } finally {
      fs.rmSync(raw, { force: true });
    }

    return {
      idx: sentence.idx,
      file: dest,
      query: sentence.imagePrompt || sentence.imageQuery,
      matchedQuery: sentence.imagePrompt || sentence.imageQuery,
      source: 'generated',
      license: null,
      attribution: null,
      generateSeconds: Number(res.headers.get('x-generate-seconds')) || null,
    };
  } catch (err) {
    trace.push(`imagegen: ${err.message}`);
    return null;
  }
}

async function resolveScene(sentence) {
  const tag = String(sentence.idx).padStart(3, '0');
  const dest = path.join(dir, `scene_${tag}.jpg`);
  const query = sentence.imageQuery || manifest.topic;
  const trace = [];

  if (generatorUp) {
    const made = await generateScene(sentence, dest, trace);
    if (made) return made;
  }
  if (wantsOnlyAi) {
    return {
      idx: sentence.idx, query, missing: true,
      reason: trace.slice(-2).join(' | ') || 'generator produced nothing',
    };
  }

  const candidates = [];
  if (pexelsByIdx[sentence.idx]) {
    candidates.push({ url: pexelsByIdx[sentence.idx], source: 'pexels', license: 'pexels', attribution: null });
  }
  candidates.push(...await openverseCandidates(query, manifest.topic, trace));

  for (const candidate of candidates) {
    try {
      await download(candidate.url, dest);
      return {
        idx: sentence.idx,
        file: dest,
        query,
        matchedQuery: candidate.matchedQuery ?? query,
        source: candidate.source,
        license: candidate.license ?? null,
        attribution: candidate.attribution ?? null,
      };
    } catch (err) {
      trace.push(`${new URL(candidate.url).host}: ${err.message}`);
    }
  }

  return {
    idx: sentence.idx,
    query,
    missing: true,
    reason: trace.slice(-4).join(' | ') || 'no candidates',
  };
}

/** Runs tasks with a ceiling on how many are in flight at once. */
async function mapWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await worker(items[i]);
    }
  }));
  return results;
}

const wantsStock = (manifest.imageSource ?? 'auto') === 'stock';
const wantsOnlyAi = (manifest.imageSource ?? 'auto') === 'ai';
let generatorUp = false;

/** One probe for the whole run, rather than a dead connection per sentence. */
async function generatorAvailable() {
  if (wantsStock) return false;
  try {
    return (await withTimeout(`${IMAGEGEN_URL}/health`, {}, IMAGEGEN_HEALTH_MS)).ok;
  } catch {
    return false;
  }
}

(async () => {
  generatorUp = await generatorAvailable();
  if (wantsOnlyAi && !generatorUp) {
    // Asked for generated pictures only, and the generator is not running. Say
    // so rather than quietly shipping a video with no scenes at all.
    console.error('imageSource=ai but the generator at host.docker.internal:7860 is not answering');
    process.exit(1);
  }

  // Sentences are independent and each may walk a cascade of searches, so running
  // them serially took 31s for six lines. Unbounded parallelism was faster but
  // tripped rate limits, so it is capped instead.
  //
  // One at a time once the generator is in play: there is a single GPU, so
  // concurrent requests only queue behind each other while multiplying peak
  // memory - on 16 GB that is how you get a swap storm instead of a speedup.
  const limit = generatorUp ? 1 : MAX_PARALLEL;
  const settled = await mapWithLimit(manifest.sentences, limit, async (sentence) => {
    try {
      return await resolveScene(sentence);
    } catch (err) {
      return { idx: sentence.idx, query: sentence.imageQuery, missing: true, reason: err.message };
    }
  });

  // Backdrop for the title card. Generated rather than borrowed from scene 1,
  // which has a character standing in the middle of exactly where the title goes.
  // No `character` is passed, so the adapter stays at zero and nobody appears.
  let coverBackground = null;
  if (generatorUp && manifest.coverPrompt) {
    const dest = path.join(dir, 'cover_bg.jpg');
    const made = await generateScene(
      { idx: 0, imagePrompt: manifest.coverPrompt, imageQuery: manifest.topic },
      dest, [],
    );
    if (made) coverBackground = made.file;
  }

  const scenes = settled.filter((r) => !r.missing).sort((a, b) => a.idx - b.idx);
  const missing = settled.filter((r) => r.missing).map(({ idx, query, reason }) => ({ idx, query, reason }));

  process.stdout.write(JSON.stringify({
    scenes, missing, coverBackground,
    generator: generatorUp ? 'up' : 'off',
    imageSource: manifest.imageSource ?? 'auto',
  }));
})().catch((err) => { console.error(err.message); process.exit(1); });
