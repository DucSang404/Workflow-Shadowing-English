// Chooses the topic for this run and the time its video should go out.
//
// Least recently used, not random: random repeats itself far sooner than people
// expect, and a learning channel that posts the same situation twice in a week
// looks abandoned. The pool cycles on its own and can be edited at any time
// without touching this file.
const fs = require('fs');
const ROOT = '/data/workflow';
const FILE = `${ROOT}/topics.json`;

// The slots a video can be scheduled into, in ICT. Two a day.
const POST_HOURS = [8, 20];
const ICT_OFFSET_HOURS = 7;

const cfg = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const pool = (cfg.pool ?? []).filter((t) => typeof t === 'string' && t.trim());
if (!pool.length) throw new Error('topics.json has an empty pool');

// ---------------------------------------------------------------- topic ----
// `history` is newest-first, so a SMALL index means recently used and a LARGE
// index means long ago. Ranking by the index itself therefore picks the topic
// used most recently - which, once every topic has run once, is whichever one
// ran last, forever. Negating it puts the oldest first, which is the whole
// point of the pool.
//
// Never-run topics outrank everything (nothing is less recent than never), and
// they are picked from at random rather than in file order, so a freshly
// appended batch does not go out as a visibly contiguous block.
const history = (cfg.history ?? []).map((h) => h.topic);
const rank = (t) => {
  const i = history.indexOf(t);
  return i === -1 ? -Infinity : -i;
};

const best = pool.reduce((lowest, t) => Math.min(lowest, rank(t)), Infinity);
const candidates = pool.filter((t) => rank(t) === best);
const topic = candidates[Math.floor(Math.random() * candidates.length)];

// ----------------------------------------------------------------- when ----
// Aim at the next slot that has not already passed. The build runs about an
// hour ahead of its slot, but a late or retried build must not hand Buffer a
// time in the past, so the slot is chosen from the clock rather than from which
// schedule trigger happened to fire.
const SAFETY_MS = 5 * 60_000;
const nowIct = new Date(Date.now() + ICT_OFFSET_HOURS * 3600_000);

const slotFor = (hour, dayOffset) => new Date(Date.UTC(
  nowIct.getUTCFullYear(), nowIct.getUTCMonth(), nowIct.getUTCDate() + dayOffset,
  hour - ICT_OFFSET_HOURS, 0, 0,
));

const dueAt = [...POST_HOURS.map((h) => slotFor(h, 0)), slotFor(POST_HOURS[0], 1)]
  .find((d) => d.getTime() >= Date.now() + SAFETY_MS);

const slotIct = new Date(dueAt.getTime() + ICT_OFFSET_HOURS * 3600_000);
const pad = (n) => String(n).padStart(2, '0');

return [{
  json: {
    topic,
    dueAt: dueAt.toISOString(),
    postsAtIct: `${slotIct.getUTCFullYear()}-${pad(slotIct.getUTCMonth() + 1)}-${pad(slotIct.getUTCDate())}`
      + ` ${pad(slotIct.getUTCHours())}:00 ICT`,
    everRun: history.length,
    poolSize: pool.length,
    // How many topics are tied for "least recently used" right now. While this
    // is large the pool is still being worked through for the first time.
    freshCandidates: candidates.length,
  },
}];
