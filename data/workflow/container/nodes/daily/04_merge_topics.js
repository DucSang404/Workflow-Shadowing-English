// Adds Claude's suggested topics to topics/pool.json and logs the attempt.
//
// mergeTopics, addRefill, todayIct and emptyState come from lib/topics.js,
// prepended at deploy time.
//
// The HTTP node before this continues on error, so a reviewer that is down or
// slow arrives here as `{error}`. Then the pool is left alone and the failure is
// logged in state.refills; the next run still finds the pool low and asks again.
const fs = require('fs');
const POOL = '/data/workflow/topics/pool.json';
const STATE = '/data/workflow/topics/state.json';

const check = $('Check Topics').first().json;
const res = $input.first().json;

const writeJson = (file, data) => {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
};

// Read again rather than trusting Check Topics' copy: someone may have edited
// the pool while Claude was thinking.
const pool = JSON.parse(fs.readFileSync(POOL, 'utf8'));
const before = (pool.topics ?? []).length;

let refill;
let added = [];
if (res.error || !Array.isArray(res.topics)) {
  const why = res.error?.message ?? res.error ?? 'no topics in the response';
  refill = { at: new Date().toISOString(), before, added: 0, rejected: 0, error: String(why).slice(0, 300) };
} else {
  const merged = mergeTopics(pool, res.topics, { batch: check.batch, today: todayIct() });
  if (merged.added.length) writeJson(POOL, merged.pool);
  added = merged.added;
  refill = { at: new Date().toISOString(), before, added: added.length, rejected: merged.rejected.length, error: null };
}

try {
  let state = emptyState();
  try {
    state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    state = emptyState();
  }
  writeJson(STATE, addRefill(state, refill));
} catch (err) {
  console.log(`[daily] could not log the refill - ${err.message}`);
}

return [{ json: { ...refill, ratioBefore: check.ratio, addedTopics: added } }];
