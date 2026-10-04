// Checks that S3 really is serving the video publicly, then builds the Buffer
// mutation. Runs between the verification GET and the Buffer POST.
//
// The verification matters more than it looks. Buckets created since 2023 have
// ACLs disabled AND Block Public Access switched on by default, so the upload
// succeeds and the object is still unreachable. Buffer would then accept the post,
// fail hours later inside TikTok, and say nothing useful. Catching it here turns
// a silent dud into an error naming the bucket setting to change.
const cfg = $('Resolve Video').first().json;
const probe = $input.first().json;

const fail = (error, hint) => [{ json: { ok: false, stage: 's3', error, hint: hint ?? null } }];

// Read and Upload both continue on error, so their failures arrive as an `error`
// on the item they emitted. Checked by name before the verification result,
// because a failed upload makes the public URL 404 and the honest reason for
// that is upstream - reporting "not publicly readable" for a rejected access key
// would send you to the wrong setting entirely.
for (const step of ['Read Video File', 'Upload To S3']) {
  const err = $(step).first().json.error;
  if (!err) continue;
  const message = String(err.message ?? err);
  return fail(
    `${step} failed - ${message.slice(0, 220)}`,
    /InvalidAccessKeyId|SignatureDoesNotMatch|Forbidden|credentials/i.test(message)
      ? 'open http://localhost:5678 > Credentials > AWS S3 and fill in the key, secret and region'
      : /NoSuchBucket|not exist/i.test(message)
        ? 'check s3.bucket in publish.config.json, and that the credential region matches the bucket region'
        : null,
  );
}

// The verification node is set to continue on error, so a 403 arrives here as an
// error field rather than killing the run.
if (probe.error) {
  const msg = String(probe.error.message ?? probe.error);
  return fail(
    `the uploaded object is not publicly readable - ${msg.slice(0, 200)}`,
    'turn off Block Public Access on the bucket and add a bucket policy granting '
    + 's3:GetObject to "*". Modern buckets have ACLs disabled, so an ACL will not do it.',
  );
}

// An HTTP 200 is not proof it is the video: S3 answers a denied read with XML,
// and a 200 of XML looks identical to a 200 of mp4 from here. Every mp4 opens
// with a box whose type is "ftyp" at offset 4, and that is ASCII, so it survives
// being read as text.
const head = String(probe.data ?? probe.body ?? '');
if (!head.includes('ftyp')) {
  return fail(
    `${cfg.publicUrl} did not serve an mp4 - got ${JSON.stringify(head.slice(0, 80))}`,
    head.includes('<?xml') || head.includes('AccessDenied')
      ? 'that is an S3 error document, so the object is uploaded but not public'
      : null,
  );
}

const text = cfg.caption || `Luyen noi tieng Anh - ${cfg.topic ?? ''}`.trim();

// GraphQL string literals follow JSON's escaping rules, so JSON.stringify makes a
// correct one - including for Vietnamese captions, emoji and newlines. Variables
// would be the other way, but they need the exact input type name from the schema;
// this needs nothing.
const str = (v) => JSON.stringify(String(v ?? ''));

// `schedulingType` is required on EVERY post, not only the queued ones. Leaving
// it off a scheduled post returns GRAPHQL_VALIDATION_FAILED with
// "Field CreatePostInput.schedulingType of required type SchedulingType! was not
// provided" - which cost a whole scheduled run to discover, because the video
// built fine and only the publish failed.
//
// It is also not the field that sets the time: the enum is automatic (Buffer
// posts it) or notification (Buffer only reminds you). `mode` plus `dueAt` are
// what place the post at an exact moment.
const scheduling = cfg.dueAt
  ? `schedulingType: automatic\n      mode: customScheduled\n      dueAt: ${str(cfg.dueAt)}`
  : 'schedulingType: automatic\n      mode: addToQueue';

const thumb = cfg.thumbnailOffsetMs === null ? '' : `
            metadata: { thumbnailOffset: ${cfg.thumbnailOffsetMs} }`;

const query = `mutation CreatePost {
  createPost(
    input: {
      text: ${str(text)}
      channelId: ${str(cfg.channelId)}
      ${scheduling}
      assets: [
        {
          video: {
            url: ${str(cfg.publicUrl)}${thumb}
          }
        }
      ]
    }
  ) {
    __typename
    ... on PostActionSuccess { post { id text } }
    ... on MutationError { message }
  }
}`;

return [{ json: { ok: true, text, query } }];
