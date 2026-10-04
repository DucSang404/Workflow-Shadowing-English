// Collects whatever the Pexels search returned into pexels.json, which
// fetch_scenes.js then reads.
//
// The indirection exists so the Pexels key stays in the n8n credential store:
// the HTTP node holds the credential, this node only ever sees the URLs it
// returned, and the CLI script never touches a key at all.
//
// Pexels is entirely optional. With no key, a bad key, or an exhausted quota the
// search node passes its error through instead of failing, this node writes an
// empty map, and every scene falls back to Openverse.
const fs = require('fs');
const cfg = $('Prepare Run').first().json;

const byIdx = {};
let searched = 0;
let failed = 0;

for (let i = 0; i < $input.all().length; i += 1) {
  const item = $input.all()[i];

  let idx;
  try {
    idx = $('Parse & Normalize').all()[i]?.json?.idx;
  } catch {
    idx = undefined;
  }
  // idx 0 is the spoken brand line, which rides this path only to keep the item
  // indices aligned. It has no scene, so its search result is discarded.
  if (!idx) continue;

  if (item.json?.error) {
    failed += 1;
    continue;
  }

  searched += 1;
  // large2x is ~1880px wide: plenty for a 1920 frame, far smaller than original.
  const photo = (item.json?.photos ?? [])[0];
  const url = photo?.src?.large2x ?? photo?.src?.large ?? null;
  if (url) byIdx[idx] = url;
}

fs.writeFileSync(cfg.pexelsPath, JSON.stringify(byIdx), 'utf8');

if (failed) {
  console.log(`[shadowing] run ${cfg.runId}: ${failed} Pexels lookup(s) failed, those scenes fall back to Openverse`);
}

return [{
  json: {
    pexelsPath: cfg.pexelsPath,
    pexelsHits: Object.keys(byIdx).length,
    pexelsSearched: searched,
    pexelsFailed: failed,
  },
}];
