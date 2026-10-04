// Chooses the day's topic and the time it should go out.
//
// Least recently used, not random: random repeats itself far sooner than people
// expect, and a learning channel that posts the same situation twice in a week
// looks abandoned. The pool cycles on its own and can be edited at any time
// without touching this file.
const fs = require('fs');
const ROOT = '/data/workflow';
const FILE = `${ROOT}/topics.json`;

const cfg = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const pool = (cfg.pool ?? []).filter((t) => typeof t === 'string' && t.trim());
if (!pool.length) throw new Error('topics.json has an empty pool');

// history is newest-first, so position in it IS recency. A topic that has never
// run is not in the list at all and sorts ahead of everything that has.
const history = (cfg.history ?? []).map((h) => h.topic);
const rank = (t) => {
  const i = history.indexOf(t);
  return i === -1 ? -1 : i;
};
const topic = [...pool].sort((a, b) => rank(a) - rank(b))[0];

// 19:00 Asia/Ho_Chi_Minh, expressed as the UTC instant Buffer wants. ICT is
// UTC+7 all year - Vietnam has no daylight saving - so this is a fixed offset
// rather than a timezone library.
const ICT_OFFSET_HOURS = 7;
const POST_HOUR_ICT = Number($json.postHourIct ?? 19);

const nowIct = new Date(Date.now() + ICT_OFFSET_HOURS * 3600_000);
const y = nowIct.getUTCFullYear();
const m = String(nowIct.getUTCMonth() + 1).padStart(2, '0');
const d = String(nowIct.getUTCDate()).padStart(2, '0');
const dueAt = new Date(Date.UTC(y, nowIct.getUTCMonth(), nowIct.getUTCDate(),
  POST_HOUR_ICT - ICT_OFFSET_HOURS, 0, 0));

// If the build ran late and 19:00 has already gone, aim at tomorrow rather than
// handing Buffer a time in the past.
if (dueAt.getTime() < Date.now() + 5 * 60_000) dueAt.setUTCDate(dueAt.getUTCDate() + 1);

return [{
  json: {
    topic,
    dueAt: dueAt.toISOString(),
    postsAtIct: `${y}-${m}-${d} ${String(POST_HOUR_ICT).padStart(2, '0')}:00 ICT`,
    everRun: history.length,
  },
}];
