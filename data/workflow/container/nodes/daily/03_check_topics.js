// Decides whether the pool is running low enough to ask Claude for more.
//
// poolTopics, refillSettings, usageRatio and emptyState come from lib/topics.js,
// prepended at deploy time.
//
// "Low" is the share of pool topics that have run at least once, against
// pool.json's refill.threshold (0.9 by default). Refilling before the pool is
// used up means the channel never has to repeat a topic.
const fs = require('fs');
const POOL = '/data/workflow/topics/pool.json';
const STATE = '/data/workflow/topics/state.json';
const RECENT = 30;

const pool = JSON.parse(fs.readFileSync(POOL, 'utf8'));
let state = emptyState();
try {
  state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
} catch {
  state = emptyState();
}

const topics = poolTopics(pool);
const { threshold, batch } = refillSettings(pool);
const ratio = usageRatio(topics, state.used ?? {});
const recent = [...new Set((state.history ?? []).map((h) => h.topic).filter(Boolean))].slice(0, RECENT);

return [{
  json: {
    need: ratio >= threshold,
    ratio: Math.round(ratio * 1000) / 1000,
    threshold,
    batch,
    poolSize: topics.length,
    existing: topics,
    recent,
  },
}];
