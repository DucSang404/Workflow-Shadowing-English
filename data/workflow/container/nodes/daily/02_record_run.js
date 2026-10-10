// Writes this run into topics/state.json and shapes a one-line summary.
//
// recordUse and emptyState come from lib/topics.js, prepended at deploy time.
//
// The run counts against its topic whether or not publishing succeeded - a topic
// whose video was built has been spent either way, and repeating it tomorrow
// because Buffer was down would be the wrong recovery. A dry run counts too: its
// video was built.
const fs = require('fs');
const STATE = '/data/workflow/topics/state.json';

const picked = $('Pick Topic').first().json;
const built = $('Build Video').first().json;
const node = $input.first().json;

// Both sub-calls are HTTP requests set to continue on error, so a failure shows
// up as an `error` on the item rather than killing the schedule. A dry run never
// called Buffer, so whatever arrived here is the build, not a publish result.
let published;
if (picked.dryRun) published = { ok: false, error: 'dry run' };
else if (node.error) published = { ok: false, error: String(node.error.message ?? node.error).slice(0, 300) };
else published = node;

const entry = {
  topic: picked.topic,
  runId: built?.runId ?? null,
  at: new Date().toISOString(),
  postsAt: picked.dueAt,
  published: published.ok === true,
  postId: published.postId ?? null,
  error: published.ok === true ? null : (published.error ?? 'unknown'),
  dryRun: picked.dryRun === true,
};

try {
  let state = emptyState();
  try {
    state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.log(`[daily] state.json unreadable, starting it again - ${err.message}`);
  }
  const tmp = `${STATE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(recordUse(state, entry), null, 2), 'utf8');
  fs.renameSync(tmp, STATE);
} catch (err) {
  console.log(`[daily] could not record the run - ${err.message}`);
}

return [{
  json: {
    ok: entry.published,
    dryRun: entry.dryRun,
    topic: entry.topic,
    runId: entry.runId,
    video: built?.video ?? null,
    postsAt: picked.postsAtIct,
    postId: entry.postId,
    error: entry.error,
  },
}];
