// Writes the day's result into topics.json and shapes a one-line summary.
//
// The history entry is what stops the picker repeating itself, so it is written
// whether or not publishing succeeded - a topic whose video was built has been
// spent either way, and repeating it tomorrow because Buffer was down would be
// the wrong recovery.
const fs = require('fs');
const FILE = '/data/workflow/topics.json';

const picked = $('Pick Topic').first().json;
const built = $('Build Video').first().json;
const node = $input.first().json;

// Both sub-calls are HTTP requests set to continue on error, so a failure shows
// up as an `error` on the item rather than killing the schedule.
const published = node.error
  ? { ok: false, error: String(node.error.message ?? node.error).slice(0, 300) }
  : node;

const entry = {
  topic: picked.topic,
  runId: built?.runId ?? null,
  at: new Date().toISOString(),
  postsAt: picked.dueAt,
  published: published.ok === true,
  postId: published.postId ?? null,
  error: published.ok === true ? null : (published.error ?? 'unknown'),
};

try {
  const cfg = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  // Newest first, and capped: the picker only cares about order, and an
  // unbounded log would grow forever in a file that is read on every run.
  cfg.history = [entry, ...(cfg.history ?? [])].slice(0, 200);
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
} catch (err) {
  console.log(`[daily] could not record history - ${err.message}`);
}

return [{
  json: {
    ok: entry.published,
    topic: entry.topic,
    runId: entry.runId,
    video: built?.video ?? null,
    postsAt: picked.postsAtIct,
    postId: entry.postId,
    error: entry.error,
  },
}];
