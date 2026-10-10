// Topic bookkeeping for the daily workflow, as pure functions.
//
// Kept out of the Code nodes so the rules can be tested on the host with
// `node --test`: which topic runs next, when the pool counts as used up, and what
// Claude's suggestions must pass before they join the pool. The picker has been
// wrong once already (it ranked by history position the wrong way round and would
// have repeated the last topic forever), which is why this is tested at all.
//
// Code nodes cannot `require` project files, so host/workflows/daily.js prepends
// everything above the exports marker at the bottom to each Code node that needs
// it. Keep this file free of `require` and of top-level side effects.

const HISTORY_CAP = 200;
const REFILLS_CAP = 50;
const DEFAULT_THRESHOLD = 0.9;
const DEFAULT_BATCH = 30;
const MIN_WORDS = 3;
const MAX_WORDS = 12;
const ICT_OFFSET_MS = 7 * 3600_000;

function emptyState() {
  return { used: {}, history: [], refills: [] };
}

/** The comparison key for "is this the same topic": case, punctuation and spacing folded away. */
function normalizeTopic(s) {
  return String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** pool.refill with anything missing or out of range replaced by the defaults. */
function refillSettings(pool) {
  const r = pool?.refill ?? {};
  const threshold = Number(r.threshold);
  const batch = Number(r.batch);
  return {
    threshold: threshold > 0 && threshold <= 1 ? threshold : DEFAULT_THRESHOLD,
    batch: Number.isInteger(batch) && batch >= 1 && batch <= 100 ? batch : DEFAULT_BATCH,
  };
}

/** The topic strings of pool.json, ignoring malformed entries rather than failing on them. */
function poolTopics(pool) {
  return (pool?.topics ?? [])
    .map((t) => (typeof t?.topic === 'string' ? t.topic.trim() : ''))
    .filter(Boolean);
}

/**
 * Least recently used, never-used first.
 *
 * Never-used topics are picked at random among themselves, so a freshly appended
 * batch does not go out as a visibly contiguous block. Once every topic has run,
 * the one with the oldest lastAt goes next; a tie keeps pool order.
 */
function pickTopic(topics, used, random = Math.random) {
  if (!topics.length) return { topic: null, fresh: 0 };
  const fresh = topics.filter((t) => !used?.[t]);
  if (fresh.length) return { topic: fresh[Math.floor(random() * fresh.length)], fresh: fresh.length };

  const at = (t) => Date.parse(used[t]?.lastAt) || 0;
  let best = topics[0];
  for (const t of topics) if (at(t) < at(best)) best = t;
  return { topic: best, fresh: 0 };
}

/**
 * Share of the pool that has run at least once. Topics in `used` that were since
 * deleted from the pool do not count. An empty pool counts as fully used, so it
 * asks for a refill rather than dividing by zero.
 */
function usageRatio(topics, used) {
  if (!topics.length) return 1;
  return topics.filter((t) => used?.[t]).length / topics.length;
}

/** A new state with this run counted against its topic and logged, newest first. */
function recordUse(state, entry) {
  const prev = state.used?.[entry.topic] ?? { count: 0, lastAt: null };
  return {
    ...state,
    used: { ...(state.used ?? {}), [entry.topic]: { count: prev.count + 1, lastAt: entry.at } },
    history: [entry, ...(state.history ?? [])].slice(0, HISTORY_CAP),
  };
}

function addRefill(state, refill) {
  return { ...state, refills: [refill, ...(state.refills ?? [])].slice(0, REFILLS_CAP) };
}

/**
 * Claude's suggestions, filtered and appended to the pool.
 *
 * Claude is told the whole pool and asked not to repeat it, but the code does
 * not take that on trust: anything that normalises to an existing topic, repeats
 * an earlier suggestion, is not 3-12 words, or is not a string at all is
 * rejected. At most `batch` are added.
 */
function mergeTopics(pool, candidates, { batch, today }) {
  const seen = new Set(poolTopics(pool).map(normalizeTopic));
  const added = [];
  const rejected = [];

  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (typeof c !== 'string') {
      rejected.push(c);
      continue;
    }
    const topic = c.trim().replace(/\s+/g, ' ').toLowerCase();
    const key = normalizeTopic(topic);
    const words = key ? key.split(' ').length : 0;
    if (words < MIN_WORDS || words > MAX_WORDS || seen.has(key) || added.length >= batch) {
      rejected.push(c);
      continue;
    }
    seen.add(key);
    added.push(topic);
  }

  return {
    pool: {
      ...pool,
      topics: [...(pool.topics ?? []), ...added.map((topic) => ({ topic, addedAt: today, source: 'claude' }))],
    },
    added,
    rejected,
  };
}

/** The calendar date in Asia/Ho_Chi_Minh, which is the date the channel lives in. */
function todayIct(now = Date.now()) {
  return new Date(now + ICT_OFFSET_MS).toISOString().slice(0, 10);
}

// --- exports (stripped when embedded) ---
module.exports = {
  HISTORY_CAP, REFILLS_CAP, emptyState, normalizeTopic, refillSettings, poolTopics,
  pickTopic, usageRatio, recordUse, addRefill, mergeTopics, todayIct,
};
