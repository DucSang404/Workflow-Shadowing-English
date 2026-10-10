// Lists the Unsplash photos this run actually used, so the next node can report
// each one to Unsplash. Their API guidelines require that request for every
// photo an app uses; the HTTP node after this one holds the key.
//
// This sits on a side branch off Fetch Scenes, not on the main chain. Returning
// nothing ends the branch and touches nothing else - which is why "no Unsplash
// photo was used" is an empty list here rather than a placeholder item.
let chosen = [];
try {
  chosen = JSON.parse($('Fetch Scenes').first().json.stdout || '{}').unsplashChosen ?? [];
} catch {
  chosen = [];
}

return chosen
  .filter((c) => c?.downloadLocation)
  .map((c) => ({ json: { idx: c.idx, downloadLocation: c.downloadLocation } }));
