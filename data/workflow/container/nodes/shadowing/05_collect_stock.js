// Collects the Unsplash and Pexels search results into stock.json, which
// fetch_scenes.js reads as each scene's candidate list.
//
// The indirection exists so the API keys stay in the n8n credential store: the
// HTTP nodes hold the credentials, this node only ever sees what they returned,
// and the CLI script never touches a key at all.
//
// Both searches are optional. With no key, a bad key or an exhausted quota a
// search node passes its error through instead of failing, that library is just
// absent here, and fetch_scenes.js falls back to Openverse.
//
// Item 0 is the title card's slot: its query is the manifest's coverQuery.
const fs = require('fs');
const cfg = $('Prepare Run').first().json;

// Unsplash asks for these on every link back to a photographer or to Unsplash.
const UTM = 'utm_source=shadowing_video&utm_medium=referral';

function fromUnsplash(json) {
  return (json?.results ?? []).filter((p) => p?.urls?.raw).map((p) => ({
    source: 'unsplash',
    id: String(p.id),
    // raw plus an explicit width: `regular` is fixed at 1080, short of a 1920 frame.
    url: `${p.urls.raw}&w=1920&fm=jpg&q=80`,
    photographer: p.user?.name ?? null,
    link: p.user?.links?.html ? `${p.user.links.html}?${UTM}` : null,
    // Unsplash's API guidelines require a request to this for every photo used.
    downloadLocation: p.links?.download_location ?? null,
  }));
}

function fromPexels(json) {
  return (json?.photos ?? []).filter((p) => p?.src?.large2x || p?.src?.large).map((p) => ({
    source: 'pexels',
    id: String(p.id),
    // large2x is ~1880px wide: plenty for a 1920 frame, far smaller than original.
    url: p.src.large2x ?? p.src.large,
    photographer: p.photographer ?? null,
    link: p.url ?? null,
  }));
}

/** u1, p1, u2, p2 ... so the first batch Claude sees has both libraries in it. */
function interleave(a, b) {
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i]) out.push(a[i]);
    if (b[i]) out.push(b[i]);
  }
  return out;
}

const pexels = $input.all();
const unsplash = $('Search Unsplash').all();
const byIdx = {};
let unsplashHits = 0;
let pexelsHits = 0;
let failed = 0;

for (let i = 0; i < pexels.length; i += 1) {
  // The paired item, not .all()[i]: Keep Successful Audio drops sentences whose
  // TTS failed, so positions here do not line up with Parse & Normalize's.
  let idx;
  try {
    idx = $('Parse & Normalize').itemMatching(i)?.json?.idx;
  } catch {
    idx = undefined;
  }
  if (idx === undefined || idx === null) continue;

  const u = unsplash[i]?.json ?? {};
  const p = pexels[i]?.json ?? {};
  if (u.error) failed += 1;
  if (p.error) failed += 1;

  const fromU = u.error ? [] : fromUnsplash(u);
  const fromP = p.error ? [] : fromPexels(p);
  unsplashHits += fromU.length;
  pexelsHits += fromP.length;
  byIdx[idx] = interleave(fromU, fromP);
}

fs.writeFileSync(cfg.stockPath, JSON.stringify(byIdx), 'utf8');

if (failed) {
  console.log(`[shadowing] run ${cfg.runId}: ${failed} stock lookup(s) failed, those scenes lean on Openverse`);
}

return [{
  json: { stockPath: cfg.stockPath, unsplashHits, pexelsHits, failed },
}];
