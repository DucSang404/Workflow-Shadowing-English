/**
 * Sends a finished run to the TikTok account's inbox as a draft.
 *
 *   POST /webhook/tiktok-publish  {"runId":"20261003154722_0aim82"}
 *   POST /webhook/tiktok-publish  {"runId":"...","dryRun":true}   # no TikTok call
 *
 * Deliberately a second workflow rather than extra nodes on `shadowing`. Making
 * a video and publishing it fail for unrelated reasons and recover differently:
 * a TikTok token expires, a draft slot runs out (about five per 24h), a video is
 * worth keeping but not worth posting. Separated, a publish can be retried on
 * its own without spending Groq quota to rebuild a video that is already correct.
 *
 * Why inbox draft and not Direct Post: Direct Post needs the Content Posting API
 * audit, and until that passes TikTok forces every direct post to SELF_ONLY, so
 * nobody can see it. The inbox route is not gated, because a human presses
 * publish. See docs.md, roadmap B.
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../lib/config');

const IN_CONTAINER = '/data/workflow';

const nodeCode = (file) =>
  fs.readFileSync(path.join(ROOT, 'container', 'nodes', 'tiktok-publish', file), 'utf8');

const CHAIN = ['Webhook', 'Resolve Video', 'Upload To TikTok', 'Build Response', 'Respond to Webhook'];

const to = (node) => [{ node, type: 'main', index: 0 }];

/**
 * Not linear, unlike the shadowing workflow: `Resolve Video` has a second output
 * for its own refusals, wired straight to Build Response.
 *
 * Without it a refusal throws, the Respond node never runs, and the caller gets
 * an empty 200 - the worst possible answer for a publish endpoint, because
 * "nothing came back" and "it posted" look identical from outside.
 */
const CONNECTIONS = {
  Webhook: { main: [to('Resolve Video')] },
  'Resolve Video': { main: [to('Upload To TikTok'), to('Build Response')] },
  'Upload To TikTok': { main: [to('Build Response')] },
  'Build Response': { main: [to('Respond to Webhook')] },
};

function definition() {
  const at = (name) => [-420 + CHAIN.indexOf(name) * 220, 0];

  const nodes = [
    {
      id: 'tk-webhook',
      name: 'Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2.1,
      position: at('Webhook'),
      webhookId: 'c2f8a1b4-6d93-4e27-bf15-70a3c9d2e481',
      parameters: { httpMethod: 'POST', path: 'tiktok-publish', responseMode: 'responseNode', options: {} },
    },
    {
      id: 'tk-resolve',
      name: 'Resolve Video',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: at('Resolve Video'),
      // Its refusals are answers, not crashes — see CONNECTIONS.
      onError: 'continueErrorOutput',
      parameters: { mode: 'runOnceForAllItems', jsCode: nodeCode('01_resolve_video.js') },
    },
    {
      id: 'tk-upload',
      name: 'Upload To TikTok',
      type: 'n8n-nodes-base.executeCommand',
      typeVersion: 1,
      position: at('Upload To TikTok'),
      // Continues on error so Build Response can turn a TikTok refusal into a
      // readable reply. Not retried: a retry after a half-finished upload would
      // spend a second draft slot out of the five a day.
      onError: 'continueRegularOutput',
      parameters: {
        executeOnce: true,
        command: `=node ${IN_CONTAINER}/container/cli/tiktok_publish.js '{{ $json.planPath }}'`,
      },
    },
    {
      id: 'tk-response',
      name: 'Build Response',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: at('Build Response'),
      parameters: { mode: 'runOnceForAllItems', jsCode: nodeCode('02_build_response.js') },
    },
    {
      id: 'tk-respond',
      name: 'Respond to Webhook',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1.5,
      position: at('Respond to Webhook'),
      parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json) }}', options: {} },
    },
  ];

  return {
    name: 'TikTok Publish (inbox draft)',
    slug: 'tiktok-publish',
    webhookPath: 'tiktok-publish',
    nodes,
    connections: CONNECTIONS,
    settings: { executionOrder: 'v1', saveManualExecutions: true, timezone: 'Asia/Ho_Chi_Minh' },
  };
}

module.exports = { definition, CHAIN };
