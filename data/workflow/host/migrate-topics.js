#!/usr/bin/env node
/**
 * One-off: splits topics.json into topics/pool.json and topics/state.json.
 *
 *   node host/migrate-topics.js            # this project's data/workflow
 *   node host/migrate-topics.js <dir>      # any directory holding a topics.json
 *
 * pool.json is the list people (and Claude) add to and lives in git; state.json
 * is what the daily workflow writes on every run and is gitignored, so two runs
 * a day stop showing up as changes. See the topic-refill spec for the shapes.
 *
 * Refuses to run if either output already exists, so it cannot clobber state
 * that the workflow has been writing since.
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./lib/config');

const dir = path.resolve(process.argv[2] ?? ROOT);
const src = path.join(dir, 'topics.json');
const outDir = path.join(dir, 'topics');
const poolFile = path.join(outDir, 'pool.json');
const stateFile = path.join(outDir, 'state.json');

for (const f of [poolFile, stateFile]) {
  if (fs.existsSync(f)) {
    console.error(`${f} already exists - not migrating twice`);
    process.exit(1);
  }
}

const old = JSON.parse(fs.readFileSync(src, 'utf8'));
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

const seen = new Set();
const topics = [];
for (const t of old.pool ?? []) {
  if (typeof t !== 'string' || !t.trim() || seen.has(t.trim())) continue;
  seen.add(t.trim());
  topics.push({ topic: t.trim(), addedAt: today, source: 'manual' });
}

const history = (old.history ?? []).map((h) => ({ ...h, dryRun: false }));
const used = {};
// Oldest first, so the newest `at` is the one left in lastAt.
for (const h of [...history].reverse()) {
  if (!h.topic) continue;
  const prev = used[h.topic] ?? { count: 0, lastAt: null };
  used[h.topic] = { count: prev.count + 1, lastAt: h.at ?? prev.lastAt };
}

const pool = {
  _comment: 'Topic pool for the daily run. Edit freely. Claude appends to `topics` when most of it has been used; review its additions in git diff.',
  refill: { threshold: 0.9, batch: 30 },
  topics,
};
const state = { used, history, refills: [] };

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(poolFile, `${JSON.stringify(pool, null, 2)}\n`, 'utf8');
fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  topics: topics.length,
  history: history.length,
  used: Object.keys(used).length,
  pool: path.relative(process.cwd(), poolFile),
  state: path.relative(process.cwd(), stateFile),
}));
