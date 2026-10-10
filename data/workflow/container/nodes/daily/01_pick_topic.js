// Chooses the topic for this run and the time its video should go out.
//
// pickTopic, poolTopics and emptyState come from lib/topics.js, which
// host/workflows/daily.js prepends to this node at deploy time.
//
// Least recently used, not random: random repeats itself far sooner than people
// expect, and a learning channel that posts the same situation twice in a week
// looks abandoned. topics/pool.json can be edited at any time without touching
// this file; topics/state.json records what has run.
const fs = require('fs');
const POOL = '/data/workflow/topics/pool.json';
const STATE = '/data/workflow/topics/state.json';

// The slots a video can be scheduled into, in ICT. Two a day.
const POST_HOURS = [8, 20];
const ICT_OFFSET_HOURS = 7;

const topics = poolTopics(JSON.parse(fs.readFileSync(POOL, 'utf8')));
if (!topics.length) throw new Error('topics/pool.json has no topics');

let state = emptyState();
try {
  state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
} catch (err) {
  // Missing on a fresh checkout; unreadable means every topic looks unused for
  // one cycle, which is a repeat, not a failure.
  if (err.code !== 'ENOENT') console.log(`[daily] state.json unreadable, treating as empty - ${err.message}`);
}

const { topic, fresh } = pickTopic(topics, state.used ?? {});

// Only the dry-run webhook delivers a `body`; the schedule trigger does not. A
// dry run builds and records but never reaches Buffer - see the Built? node.
const dryRun = $input.first().json.body !== undefined;

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
    dryRun,
    dueAt: dueAt.toISOString(),
    postsAtIct: `${slotIct.getUTCFullYear()}-${pad(slotIct.getUTCMonth() + 1)}-${pad(slotIct.getUTCDate())}`
      + ` ${pad(slotIct.getUTCHours())}:00 ICT`,
    poolSize: topics.length,
    // How many topics have never run. While this is large the pool is still
    // being worked through for the first time.
    freshCandidates: fresh,
  },
}];
