// Collects the Unsplash search results into stock.json, which fetch_scenes.js
// reads as each scene's candidate list.
//
// The indirection exists so the API key stays in the n8n credential store: the
// HTTP node holds the credential, this node only ever sees what it returned, and
// the CLI script never touches a key at all.
//
// The search is optional. With no key, a bad key or an exhausted quota the
// search node passes its error through instead of failing, the scene simply has
// no stock list here, and fetch_scenes.js falls back to Openverse.
//
// Pexels used to be searched alongside. Removed 2026-10-10: the key was never
// valid, every run spent 14 requests on 401s, and Pexels had stopped issuing new
// keys. Unsplash alone passed 5 of 6 scenes on the first run.
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

const unsplash = $input.all();
const byIdx = {};
let unsplashHits = 0;
let failed = 0;

for (let i = 0; i < unsplash.length; i += 1) {
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
  if (u.error) {
    failed += 1;
    continue;
  }
  byIdx[idx] = fromUnsplash(u);
  unsplashHits += byIdx[idx].length;
}

fs.writeFileSync(cfg.stockPath, JSON.stringify(byIdx), 'utf8');

if (failed) {
  console.log(`[shadowing] run ${cfg.runId}: ${failed} Unsplash lookup(s) failed, those scenes lean on Openverse`);
}

return [{
  json: { stockPath: cfg.stockPath, unsplashHits, failed },
}];
