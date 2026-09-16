#!/usr/bin/env node
/**
 * usage: node fetch_scenes.js <sentenceDir>
 *
 * Finds one still per sentence and downloads it to <dir>/scene_NNN.jpg.
 *
 * Two sources, in order:
 *   1. Pexels      - polished stock, needs a key. The key never reaches this
 *                    script: the workflow's Pexels node (which holds the n8n
 *                    credential) writes its results to pexels.json first, and
 *                    this script only reads those. See CLAUDE.md, "Secrets".
 *   2. Openverse   - Creative Commons photos, keyless, so scenes still work with
 *                    no Pexels key configured at all.
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

async function resolveScene(sentence) {
  const tag = String(sentence.idx).padStart(3, '0');
  const dest = path.join(dir, `scene_${tag}.jpg`);
  const query = sentence.imageQuery || manifest.topic;
  const trace = [];

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

(async () => {
  // Sentences are independent and each may walk a cascade of searches, so running
  // them serially took 31s for six lines. Unbounded parallelism was faster but
  // tripped rate limits, so it is capped instead.
  const settled = await mapWithLimit(manifest.sentences, MAX_PARALLEL, async (sentence) => {
    try {
      return await resolveScene(sentence);
    } catch (err) {
      return { idx: sentence.idx, query: sentence.imageQuery, missing: true, reason: err.message };
    }
  });

  const scenes = settled.filter((r) => !r.missing).sort((a, b) => a.idx - b.idx);
  const missing = settled.filter((r) => r.missing).map(({ idx, query, reason }) => ({ idx, query, reason }));

  process.stdout.write(JSON.stringify({ scenes, missing }));
})().catch((err) => { console.error(err.message); process.exit(1); });
