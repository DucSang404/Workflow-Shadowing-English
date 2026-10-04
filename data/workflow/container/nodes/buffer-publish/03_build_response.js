// Shapes the webhook reply, from whichever step spoke last.
//
// Three shapes reach this node:
//   - Resolve Video's refusal, routed here by the IF node
//   - Build Buffer Request's refusal, when S3 did not serve the file
//   - the Buffer POST's response
const node = $input.first().json;

// The two refusals already carry their own shape.
if (node.ok === false) {
  return [{ json: { ok: false, stage: node.stage, error: node.error, hint: node.hint ?? null } }];
}

const cfg = $('Resolve Video').first().json;

// Buffer is "always 200" only for GraphQL-level outcomes. A bad API key is a flat
// HTTP 401, which the HTTP node - set to continue on error - hands over as an
// `error` whose message is the status plus the raw body. Measured, not assumed.
if (node.error) {
  const message = String(node.error.message ?? node.error);
  let code = '';
  try {
    code = JSON.parse(message.slice(message.indexOf('{'), message.lastIndexOf('}') + 1))
      .errors?.[0]?.extensions?.code ?? '';
  } catch { /* not JSON; the raw message still says enough */ }
  return [{
    json: {
      ok: false,
      stage: 'buffer',
      error: `${code || 'request failed'} - ${message.slice(0, 220)}`,
      hint: /UNAUTHENTICATED|UNAUTHORIZED|401/.test(`${code} ${message}`)
        ? 'open http://localhost:5678 > Credentials > Buffer API. Header name Authorization, '
          + 'value must include the word Bearer followed by the key'
        : null,
    },
  }];
}

// And it fails in TWO more places once the request itself is accepted:
// `errors[]` for the transport-level refusals, and a MutationError inside `data`
// for a rejected post. A response can be 200, have an empty `errors`, and still
// have posted nothing - so both are checked.
if (Array.isArray(node.errors) && node.errors.length) {
  const first = node.errors[0];
  const code = first.extensions?.code ?? '';
  const hint = code === 'UNAUTHORIZED' ? 'check the Buffer API credential in n8n - it must be the whole value, Bearer included'
    : code === 'NOT_FOUND' ? 'check buffer.channelId in publish.config.json'
    : code === 'RATE_LIMIT_EXCEEDED' ? 'the Buffer Free plan allows 100 requests per 24h'
    : null;
  return [{ json: { ok: false, stage: 'buffer', error: `${code || 'error'} - ${first.message}`, hint } }];
}

const result = node.data?.createPost ?? {};
if (result.__typename !== 'PostActionSuccess' || !result.post?.id) {
  return [{
    json: {
      ok: false,
      stage: 'buffer',
      error: `Buffer refused the post - ${result.message ?? JSON.stringify(result).slice(0, 200)}`,
      hint: null,
    },
  }];
}

return [{
  json: {
    ok: true,
    stage: 'buffer',
    runId: cfg.runId,
    topic: cfg.topic,
    postId: result.post.id,
    channelId: cfg.channelId,
    scheduled: cfg.dueAt ?? 'next queue slot',
    videoUrl: cfg.publicUrl,
    s3Key: cfg.s3Key,
    bucket: cfg.bucket,
    thumbnailOffsetMs: cfg.thumbnailOffsetMs,
    text: result.post.text,
    // Nothing is live until Buffer's queue fires; this is where to watch it.
    queueUrl: `https://publish.buffer.com/channels/${cfg.channelId}/schedule`,
  },
}];
