#!/usr/bin/env node
/**
 * Calibration check for the reviewer's scoring scale.
 *
 *   node host/imagereview/check.js [fixtureDir]     # default: fixtures/latte
 *
 * Sends the fixture's photos as one batch to a running server and checks that the
 * ones that fit the line score at or above 72 and the ones that do not score below
 * 50. Run it after any change to the prompt or the model: a pass score of 72 only
 * means something while this still holds.
 *
 * Exits non-zero on any miss, so it can gate a change.
 */
const fs = require('fs');
const path = require('path');

const dir = process.argv[2] ?? path.join(__dirname, 'fixtures', 'latte');
const PORT = Number(process.env.IMAGEREVIEW_PORT ?? 7861);
const PASS_AT = 72;
const FAIL_BELOW = 50;

(async () => {
  const { expect, ...req } = JSON.parse(fs.readFileSync(path.join(dir, 'case.json'), 'utf8'));
  const images = Object.keys(expect).map((id) => ({
    id,
    mediaType: 'image/jpeg',
    data: fs.readFileSync(path.join(dir, `${id}.jpg`)).toString('base64'),
  }));

  const res = await fetch(`http://127.0.0.1:${PORT}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...req, images }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`http ${res.status} ${JSON.stringify(body)}`);

  let ok = true;
  for (const s of body.scores) {
    const want = expect[s.id];
    const good = want === 'pass' ? s.score >= PASS_AT : s.score < FAIL_BELOW;
    if (!good) ok = false;
    console.log(`${good ? 'ok ' : 'BAD'} ${s.id} want=${want} score=${s.score} `
      + `missing=${JSON.stringify(s.missing)} issues=${JSON.stringify(s.issues)}`);
  }
  console.log(`required=${JSON.stringify(body.required)} model=${body.model} ${body.ms ?? '?'}ms`);
  process.exit(ok ? 0 : 1);
})().catch((err) => { console.error(err.message); process.exit(1); });
