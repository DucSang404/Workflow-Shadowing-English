/**
 * Choosing one still per scene from the candidates Claude has scored.
 *
 * Kept apart from fetch_scenes.js because it is the one piece of that script with
 * a rule worth pinning down in a test: the bar, the fallback below it, and no
 * photo appearing twice in a video. Pure - no I/O - so it runs under `node --test`
 * on the host.
 */

/** Identity of a candidate across scenes: the same photo found by two searches is one photo. */
function candidateKey(c) {
  return `${c.source}:${c.id ?? c.url}`;
}

/**
 * Best-scoring candidate not already used elsewhere in the video.
 *
 * The best is returned even below `passScore`: a weak picture beats a hole in the
 * video, and `pass: false` lets the run record say so. A tie goes to the earlier
 * candidate, which is the one the source ranked higher.
 *
 * @param {Array<{key: string, score: number}>} scored - in source order
 * @param {number} passScore - 0-100
 * @param {Set<string>} used - candidateKey() of every still already chosen
 * @returns {{choice: object|null, pass: boolean|null}}
 */
function pickBest(scored, passScore, used) {
  let choice = null;
  for (const c of scored) {
    if (used.has(c.key) || !Number.isFinite(c.score)) continue;
    if (!choice || c.score > choice.score) choice = c;
  }
  return choice ? { choice, pass: choice.score >= passScore } : { choice: null, pass: null };
}

module.exports = { pickBest, candidateKey };
