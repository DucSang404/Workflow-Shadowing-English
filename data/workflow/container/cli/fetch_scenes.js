#!/usr/bin/env node
/**
 * usage: node fetch_scenes.js <sentenceDir>
 *
 * Finds one stock photo per sentence, plus one for the title-card backdrop, and
 * saves them as <dir>/scene_NNN.jpg and <dir>/cover_bg.jpg.
 *
 * Candidates come from two places, in order:
 *   1. stock.json - Unsplash results. The workflow's HTTP node holds the API key
 *                   and Collect Stock writes this file; this script never sees a
 *                   key. See CLAUDE.md, "Secrets".
 *   2. Openverse  - Creative Commons photos, keyless. Searched only once the stock
 *                   list runs out, because it is the slow one: each query tier is
 *                   a separate request.
 *
 * Claude (host/imagereview, :7861) scores the candidates 0-100 against the line,
 * four per call. The best one at or above `manifest.passScore` (72 unless the
 * caller set it) is used. When none reaches it a second batch of four is tried,
 * and after that the highest score is used anyway and recorded as a fail: a weak
 * picture beats a hole in the video.
 *
 * No photo is used twice in one video. The reviewer is optional: down, switched
 * off or out of budget, a scene takes its first candidate that decodes.
 *
 * A search yields *candidates*, not an answer. Openverse indexes many providers
 * and some of them (Wikimedia in particular) answer this host with HTTP 429 while
 * others serve happily, so taking only the top hit lost 4 of 6 scenes. Every
 * candidate is tried until enough download and decode.
 *
 * A sentence with no usable image is reported in `missing`; build_video.js falls
 * back to the plain background for it rather than failing the run.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { pickBest, candidateKey } = require('./lib/pick_best');

const dir = process.argv[2];

const MIN_BYTES = 8 * 1024;
const MAX_BYTES = 12 * 1024 * 1024;   // a 6000x4000 original is not worth waiting for
const SEARCH_TIMEOUT_MS = 15000;
const DOWNLOAD_TIMEOUT_MS = 45000;
const MAX_PARALLEL = 3;               // be a polite guest on a keyless public API
const NORMALISE_WIDTH = 1920;         // every scene is downscaled to this at most
const MAX_CANDIDATES = 10;            // per Openverse search, across its tiers

// What Claude is shown. Four full 1920 px frames make a slow, token-heavy request
// and judge no better than 768 px does.
const THUMB_WIDTH = 768;
const BATCH_SIZE = 4;
// A second batch rescues scenes whose first four were near misses; past that the
// candidates are the search's long tail and rarely better.
const MAX_BATCHES = 2;

const IMAGEREVIEW_URL = 'http://host.docker.internal:7861';
// Short: this only asks whether the service is up.
const IMAGEREVIEW_HEALTH_MS = 1500;
// One four-image call is ~10 s; this also covers waiting behind the reviewer's
// two-call concurrency limit.
const IMAGEREVIEW_MS = 150000;
// No new batches after this long. The daily workflow gives the whole build 540 s
// and a normal one takes ~100 s, so a slow or rate-limited reviewer must not be
// able to spend the rest.
const REVIEW_BUDGET_MS = 180000;
const startedAt = Date.now();

// Wikimedia and Flickr both reject clients that do not identify themselves, and
// Wikimedia asks for a contact. A bare fetch() gets HTTP 429.
const UA = 'shadowing-video/1.0 (self-hosted n8n pipeline; +https://github.com/n8n-io/n8n)';

// Licences in order of how little they oblige the uploader: cc0/pdm need no
// credit, `by` needs a credit line. by-sa is excluded on purpose - its
// share-alike terms would reach the whole upload.
const LICENCE_TIERS = ['cc0,pdm', 'by'];

const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const passScore = Number.isFinite(manifest.passScore) ? manifest.passScore : 72;

// Written by the workflow's Collect Stock node; absent when it never ran.
let stock = {};
const stockFile = path.join(dir, 'stock.json');
if (fs.existsSync(stockFile)) {
  try {
    stock = JSON.parse(fs.readFileSync(stockFile, 'utf8'));
  } catch {
    stock = {};
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
      source: 'openverse',
      id: r.id ?? null,
      url: r.url,
      license: r.license,
      photographer: r.creator ?? null,
      link: r.foreign_landing_url ?? null,
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

let reviewerUp = false;
let reviewCalls = 0;
// candidateKey() of every still already chosen. Choosing and adding happen with
// no `await` in between, so scenes running side by side cannot take the same one.
const used = new Set();

/**
 * Stock results first, Openverse only once those run out. A generator, so the
 * slow Openverse search is never made for a scene the stock list already covered.
 */
async function* candidatesFor(job, trace) {
  yield* (stock[job.idx] ?? []);
  yield* await openverseCandidates(job.query, manifest.topic, trace);
}

/** Downloads candidates from `it` until `pool` holds `target` decodable stills. */
async function fill(pool, it, target, prefix, trace) {
  while (pool.length < target) {
    const { value: c, done } = await it.next();
    if (done) return;
    const key = candidateKey(c);
    if (used.has(key) || pool.some((p) => p.key === key)) continue;
    const file = path.join(dir, `${prefix}_c${pool.length + 1}.jpg`);
    try {
      await download(c.url, file);
      pool.push({ ...c, key, file });
    } catch (err) {
      trace.push(`${new URL(c.url).host}: ${err.message}`);
    }
  }
}

/** Claude's scores for one batch, in batch order. Throws when it cannot give them. */
async function reviewBatch(job, batch) {
  const images = batch.map((c, n) => {
    const thumb = c.file.replace(/\.jpg$/, '_thumb.jpg');
    try {
      execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', c.file,
        '-vf', `scale='min(${THUMB_WIDTH},iw)':-2`, '-q:v', '5', thumb], { stdio: 'pipe' });
      return { id: `c${n + 1}`, mediaType: 'image/jpeg', data: fs.readFileSync(thumb).toString('base64') };
    } finally {
      fs.rmSync(thumb, { force: true });
    }
  });

  reviewCalls += 1;
  const res = await withTimeout(`${IMAGEREVIEW_URL}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: job.cover ? 'cover' : 'scene',
      topic: manifest.topic,
      line: job.cover ? null : { idx: job.idx, en: job.en, vi: job.vi },
      // The whole exchange, so "that" in "any syrup with that?" can be resolved.
      dialogue: manifest.sentences.map(({ idx, speaker, en }) => ({ idx, speaker, en })),
      images,
    }),
  }, IMAGEREVIEW_MS);
  if (!res.ok) throw new Error(`http ${res.status} ${(await res.text().catch(() => '')).slice(0, 160)}`);

  const body = await res.json();
  const byId = Object.fromEntries((body.scores ?? []).map((s) => [s.id, s]));
  return {
    required: body.required ?? [],
    model: body.model ?? null,
    scores: batch.map((c, n) => {
      const s = byId[`c${n + 1}`];
      if (!s) throw new Error(`reviewer returned no score for c${n + 1}`);
      return { score: s.score, present: s.present ?? [], missing: s.missing ?? [], issues: s.issues ?? [] };
    }),
  };
}

/** One scene (or the cover): gather, review in batches, choose, keep one file. */
async function resolveJob(job) {
  const trace = [];
  const prefix = job.cover ? 'cover' : `scene_${String(job.idx).padStart(3, '0')}`;
  const dest = path.join(dir, job.cover ? 'cover_bg.jpg' : `${prefix}.jpg`);
  const it = candidatesFor(job, trace);
  const pool = [];
  const scored = [];
  let batches = 0;
  let required = [];
  let model = null;
  let skipped = reviewerUp ? null : 'reviewer off';

  await fill(pool, it, BATCH_SIZE, prefix, trace);
  while (!skipped && batches < MAX_BATCHES && scored.length < pool.length) {
    if (Date.now() - startedAt > REVIEW_BUDGET_MS) {
      skipped = 'review budget spent';
      break;
    }
    const batch = pool.slice(scored.length, scored.length + BATCH_SIZE);
    try {
      const verdict = await reviewBatch(job, batch);
      batches += 1;
      required = verdict.required;
      model = verdict.model;
      batch.forEach((c, n) => scored.push({ ...c, ...verdict.scores[n] }));
    } catch (err) {
      // A reviewer that cannot answer is not a reason to lose the picture.
      trace.push(`review: ${err.message}`);
      if (!scored.length) skipped = err.message;
      break;
    }
    if (pickBest(scored, passScore, used).pass) break;
    if (batches < MAX_BATCHES) await fill(pool, it, pool.length + BATCH_SIZE, prefix, trace);
  }

  let choice = null;
  let pass = null;
  if (scored.length) ({ choice, pass } = pickBest(scored, passScore, used));
  if (!choice) {
    choice = pool.find((c) => !used.has(c.key)) ?? null;
    pass = null;
    if (scored.length && !skipped) skipped = 'every scored candidate was taken by another scene';
  }

  // By file, not identity: a scored choice is a copy of its pool entry.
  for (const c of pool) if (!choice || c.file !== choice.file) fs.rmSync(c.file, { force: true });
  if (!choice) {
    return {
      idx: job.idx, cover: job.cover || undefined, query: job.query, missing: true,
      reason: trace.slice(-4).join(' | ') || 'no candidates',
    };
  }
  used.add(choice.key);
  fs.renameSync(choice.file, dest);

  const review = Number.isFinite(choice.score)
    ? {
      score: choice.score, pass, passScore, required,
      missing: choice.missing, issues: choice.issues,
      batches, reviewed: scored.length, model,
      // Every candidate Claude saw, so a scene that failed shows what was on offer.
      candidates: scored.map(({ source, id, score }) => ({ source, id, score })),
    }
    : { pass: null, skipped: skipped ?? 'not reviewed', passScore };

  return {
    idx: job.idx,
    cover: job.cover || undefined,
    file: dest,
    query: job.query,
    matchedQuery: choice.matchedQuery ?? job.query,
    source: choice.source,
    id: choice.id ?? null,
    photographer: choice.photographer ?? null,
    link: choice.link ?? null,
    license: choice.license ?? choice.source,
    attribution: choice.attribution ?? null,
    ...(choice.downloadLocation ? { downloadLocation: choice.downloadLocation } : {}),
    review,
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

/** One probe for the whole run, rather than a dead connection per scene. */
async function reviewerAvailable() {
  if (manifest.reviewImages === false) return false;
  try {
    return (await withTimeout(`${IMAGEREVIEW_URL}/health`, {}, IMAGEREVIEW_HEALTH_MS)).ok;
  } catch {
    return false;
  }
}

(async () => {
  reviewerUp = await reviewerAvailable();

  // The cover is the title card's backdrop and the cover on the profile grid, so
  // it goes FIRST: queued last, it reached the reviewer after the budget was spent.
  // Its stock results are filed under idx 0, the slot the spoken brand line rides.
  const jobs = [
    { cover: true, idx: 0, query: manifest.coverQuery || manifest.topic },
    ...manifest.sentences.map((s) => ({ ...s, query: s.imageQuery || manifest.topic })),
  ];

  const settled = await mapWithLimit(jobs, MAX_PARALLEL, async (job) => {
    try {
      return await resolveJob(job);
    } catch (err) {
      return { idx: job.idx, cover: job.cover || undefined, query: job.query, missing: true, reason: err.message };
    }
  });

  const cover = settled.find((r) => r.cover);
  const coverOk = cover && !cover.missing;
  const rest = settled.filter((r) => !r.cover);
  const scenes = rest.filter((r) => !r.missing).sort((a, b) => a.idx - b.idx);
  const missing = rest.filter((r) => r.missing).map(({ idx, query, reason }) => ({ idx, query, reason }));

  process.stdout.write(JSON.stringify({
    scenes,
    missing,
    coverBackground: coverOk ? cover.file : null,
    coverReview: coverOk
      ? { ...cover.review, source: cover.source, id: cover.id, photographer: cover.photographer, link: cover.link }
      : null,
    reviewer: reviewerUp ? 'up' : 'off',
    passScore,
    reviewCalls,
    imageSource: manifest.imageSource ?? 'auto',
    // The workflow reports each of these to Unsplash; its API guidelines require it.
    unsplashChosen: [...(coverOk ? [cover] : []), ...scenes]
      .filter((r) => r.downloadLocation)
      .map((r) => ({ idx: r.idx, downloadLocation: r.downloadLocation })),
  }));
})().catch((err) => { console.error(err.message); process.exit(1); });
