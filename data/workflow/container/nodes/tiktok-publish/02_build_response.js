// Shapes the webhook reply. The upload node is set to continue on error so that
// a TikTok refusal comes back as a readable answer instead of a red node — the
// caller needs to know *which* step failed, since a failed init costs nothing
// but a failed poll may still have consumed a draft slot.
const node = $input.first().json;

// Two different failures arrive on this one input, and they must not be confused:
// Resolve Video's error output is wired straight here, and Upload To TikTok is set
// to continue on error, which passes its INPUT through with an `error` bolted on.
//
// Presence of `stdout` is what tells them apart. tiktok_publish.js reports its own
// failures as JSON on stdout and exits 0 precisely so that it always produces one;
// an item with no stdout therefore never got as far as the upload.
if (node.stdout === undefined) {
  const message = node.error?.message ?? node.error ?? `exit code ${node.exitCode ?? '?'}`;
  return [{ json: { ok: false, stage: 'resolve', error: String(message).slice(0, 400) } }];
}

// tiktok_publish.js echoes the plan back, so nothing here has to reach across
// nodes for it.
const r = JSON.parse(node.stdout);

if (r.ok === false) {
  return [{ json: { ok: false, stage: 'upload', runId: r.runId ?? null, error: r.error, hint: r.hint ?? null } }];
}

return [{
  json: {
    ok: r.ok === true,
    stage: 'upload',
    runId: r.runId ?? null,
    topic: r.topic ?? null,
    video: r.file,
    sizeBytes: r.sizeBytes,
    frame: r.width ? `${r.width}x${r.height}` : null,
    cover: r.cover ?? null,
    dryRun: r.dryRun === true,
    publishId: r.publishId ?? null,
    status: r.status ?? null,
    failReason: r.failReason ?? null,
    chunks: { size: r.chunkSize, count: r.totalChunkCount },
    tokenRefreshed: r.tokenRefreshed ?? null,
    // The step the API cannot do for you.
    caption: r.caption || null,
    captionFile: r.captionPath ?? null,
    nextStep: r.nextStep ?? null,
  },
}];
