/**
 * Posts a finished run to TikTok through Buffer.
 *
 *   POST /webhook/buffer-publish  {"runId":"20261003160036_3tk7w2"}
 *   POST /webhook/buffer-publish  {"runId":"...","dueAt":"2026-10-05T09:00:00.000Z"}
 *
 * Buffer instead of TikTok's own Content Posting API because Buffer is an
 * approved TikTok partner: the post publishes PUBLICLY on a schedule, with no
 * audit to pass and nothing to tap in the app.
 *
 * Every step that touches a key is a stock n8n node, so the keys live in the
 * encrypted credential store and are edited in the UI - never in a file, never on
 * a command line, never visible to the Code nodes. Bucket, region and channel id
 * are not keys, so they stay in publish.config.json where they can be diffed.
 *
 * The S3 hop exists because Buffer has no upload endpoint: the asset must be
 * "reachable over the public internet without authentication" and must "stay
 * reachable until the post publishes", and a queued post can fire hours later.
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../lib/config');

const nodeCode = (file) =>
  fs.readFileSync(path.join(ROOT, 'container', 'nodes', 'buffer-publish', file), 'utf8');

const CHAIN = ['Webhook', 'Resolve Video', 'Resolved?', 'Read Video File', 'Upload To S3',
  'Verify Public URL', 'Build Buffer Request', 'Uploaded?', 'Create Buffer Post',
  'Build Response', 'Respond to Webhook'];

const to = (node) => [{ node, type: 'main', index: 0 }];

/**
 * `Resolved?` is an IF node rather than an error output on Resolve Video, and
 * that is load-bearing: a two-output node stops resolving by name from
 * downstream, and three nodes below here read `$('Resolve Video')`. Branching on
 * a separate IF keeps Resolve Video single-output.
 */
const CONNECTIONS = {
  Webhook: { main: [to('Resolve Video')] },
  'Resolve Video': { main: [to('Resolved?')] },
  // IF emits true on output 0, false on output 1.
  'Resolved?': { main: [to('Read Video File'), to('Build Response')] },
  'Read Video File': { main: [to('Upload To S3')] },
  'Upload To S3': { main: [to('Verify Public URL')] },
  'Verify Public URL': { main: [to('Build Buffer Request')] },
  'Build Buffer Request': { main: [to('Uploaded?')] },
  // Without this gate the S3 refusal would still be posted to Buffer - with an
  // undefined query - burning one of the 100 requests a day the Free plan allows
  // and replacing a precise error with a meaningless one from Buffer.
  'Uploaded?': { main: [to('Create Buffer Post'), to('Build Response')] },
  'Create Buffer Post': { main: [to('Build Response')] },
  'Build Response': { main: [to('Respond to Webhook')] },
};

function definition({ credentials }) {
  const at = (name) => [-760 + CHAIN.indexOf(name) * 200, 0];
  const resolved = (field) => `={{ $('Resolve Video').first().json.${field} }}`;

  const code = (id, name, file) => ({
    id,
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: at(name),
    parameters: { mode: 'runOnceForAllItems', jsCode: nodeCode(file) },
  });

  const nodes = [
    {
      id: 'bp-webhook',
      name: 'Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2.1,
      position: at('Webhook'),
      webhookId: 'd4b9c2e7-1a56-4f83-9e21-5c7d0a3b8f64',
      parameters: { httpMethod: 'POST', path: 'buffer-publish', responseMode: 'responseNode', options: {} },
    },
    code('bp-resolve', 'Resolve Video', '01_resolve_video.js'),
    {
      id: 'bp-if',
      name: 'Resolved?',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: at('Resolved?'),
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
          conditions: [{
            id: 'is-ok',
            leftValue: '={{ $json.ok }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          }],
          combinator: 'and',
        },
        looseTypeValidation: true,
        options: {},
      },
    },
    {
      id: 'bp-read',
      name: 'Read Video File',
      type: 'n8n-nodes-base.readWriteFile',
      typeVersion: 1.1,
      position: at('Read Video File'),
      // Continues on error for the same reason every other step here does: a dead
      // node means the Respond node never runs and the caller gets an empty 200,
      // which from outside is indistinguishable from a post that went out.
      onError: 'continueRegularOutput',
      parameters: {
        operation: 'read',
        fileSelector: '={{ $json.videoPath }}',
        options: { dataPropertyName: 'data' },
      },
    },
    {
      id: 'bp-s3',
      name: 'Upload To S3',
      type: 'n8n-nodes-base.awsS3',
      typeVersion: 2,
      position: at('Upload To S3'),
      parameters: {
        resource: 'file',
        operation: 'upload',
        bucketName: resolved('bucket'),
        fileName: resolved('s3Key'),
        binaryData: true,
        binaryPropertyName: 'data',
        // No ACL on purpose. Buckets created since 2023 have ACLs disabled and
        // reject `public-read` outright with AccessControlListNotSupported -
        // public reads come from a bucket policy instead.
        additionalFields: {},
        tagsUi: {},
      },
      // A rejected key, a missing bucket or a denied PutObject all land here, and
      // all of them have to reach the caller as an answer rather than as silence.
      onError: 'continueRegularOutput',
      credentials: { aws: credentials.aws },
    },
    {
      id: 'bp-verify',
      name: 'Verify Public URL',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.5,
      position: at('Verify Public URL'),
      // Anonymous on purpose: this has to prove what Buffer's servers will see,
      // so it must carry no credential at all.
      onError: 'continueRegularOutput',
      parameters: {
        method: 'GET',
        url: resolved('publicUrl'),
        sendHeaders: true,
        specifyHeaders: 'keypair',
        // Only the head of the file is needed to recognise an mp4.
        headerParameters: { parameters: [{ name: 'Range', value: 'bytes=0-63' }] },
        options: { timeout: 20000, response: { response: { responseFormat: 'text' } } },
      },
    },
    code('bp-request', 'Build Buffer Request', '02_build_buffer_request.js'),
    {
      id: 'bp-gate',
      name: 'Uploaded?',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: at('Uploaded?'),
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
          conditions: [{
            id: 'built-ok',
            leftValue: '={{ $json.ok }}',
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          }],
          combinator: 'and',
        },
        looseTypeValidation: true,
        options: {},
      },
    },
    {
      id: 'bp-post',
      name: 'Create Buffer Post',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.5,
      position: at('Create Buffer Post'),
      // Buffer answers 200 even when it refuses, so a non-2xx here is a genuine
      // transport problem and still needs to reach the caller as an answer.
      onError: 'continueRegularOutput',
      parameters: {
        method: 'POST',
        url: 'https://api.buffer.com',
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ query: $json.query }) }}',
        options: { timeout: 60000 },
      },
      credentials: { httpHeaderAuth: credentials.buffer },
    },
    code('bp-response', 'Build Response', '03_build_response.js'),
    {
      id: 'bp-respond',
      name: 'Respond to Webhook',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1.5,
      position: at('Respond to Webhook'),
      parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json) }}', options: {} },
    },
  ];

  return {
    name: 'TikTok Publish (via Buffer)',
    slug: 'buffer-publish',
    webhookPath: 'buffer-publish',
    nodes,
    connections: CONNECTIONS,
    settings: { executionOrder: 'v1', saveManualExecutions: true, timezone: 'Asia/Ho_Chi_Minh' },
  };
}

module.exports = { definition, CHAIN };
