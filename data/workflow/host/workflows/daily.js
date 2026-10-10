/**
 * Two videos a day, posted to TikTok at 08:00 and 20:00 Asia/Ho_Chi_Minh.
 *
 * Builds an hour ahead of each slot and hands Buffer the slot as an explicit
 * `dueAt`. The hour of slack is deliberate: a build takes about 100 seconds when
 * everything behaves, but it reaches out to Groq, the stock-photo search, Claude
 * and S3, and any of those can be slow. Posting is handed to Buffer with an
 * explicit `dueAt`, so even a build that overruns still goes out on time.
 *
 * It drives the two existing webhooks rather than duplicating their nodes. Those
 * endpoints are the ones that have been exercised by hand all along; a scheduled
 * run that takes a different path through the code would be a second thing to
 * trust.
 *
 * After the post is handed over it housekeeps: output/ is pruned to the newest
 * KEEP_RUNS runs, and once most of topics/pool.json has been used Claude (on the
 * host, :7861/topics) is asked for more topics. Both come after publishing on
 * purpose - neither may hold up a post.
 *
 * POST /webhook/daily-dry-run runs the whole chain except Buffer. It takes no
 * parameters and cannot publish, so exposing it adds no way to post.
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../lib/config');

const NODES_DIR = path.join(ROOT, 'container', 'nodes', 'daily');
const nodeCode = (file) => fs.readFileSync(path.join(NODES_DIR, file), 'utf8');

// Code nodes cannot `require` project files, so the tested topic functions are
// prepended to each node that uses them. Everything from the marker down is the
// `module.exports` the host-side tests need and a Code node must not see.
const EXPORTS_MARKER = '// --- exports (stripped when embedded) ---';
function nodeCodeWithLib(file) {
  const lib = nodeCode(path.join('lib', 'topics.js'));
  const cut = lib.indexOf(EXPORTS_MARKER);
  if (cut < 0) throw new Error('container/nodes/daily/lib/topics.js has lost its exports marker');
  return `${lib.slice(0, cut)}\n// ---- ${file} ----\n${nodeCode(file)}`;
}

// Local, because n8n is calling its own webhooks from inside the same container.
const SELF = 'http://localhost:5678/webhook';
const IN_CONTAINER = '/data/workflow';

// One build per slot, each an hour before it. The slots themselves live in
// container/nodes/daily/01_pick_topic.js (POST_HOURS) because that is what
// computes `dueAt`; change them together.
const BUILD_HOURS_ICT = [7, 19];

// How many runs output/ keeps. Older ones are deleted after each scheduled build.
const KEEP_RUNS = 10;

const CHAIN = ['Twice Daily', 'Pick Topic', 'Build Video', 'Built?', 'Publish To Buffer',
  'Record Run', 'Prune Output', 'Check Topics', 'Topics Low?', 'Refill Topics', 'Merge Topics'];
const to = (node) => [{ node, type: 'main', index: 0 }];

const CONNECTIONS = {
  'Twice Daily': { main: [to('Pick Topic')] },
  'Dry Run Hook': { main: [to('Pick Topic')] },
  'Pick Topic': { main: [to('Build Video')] },
  'Build Video': { main: [to('Built?')] },
  // A failed build must not reach Buffer: posting nothing is better than posting
  // a half-made video, and the history entry still records the attempt. A dry
  // run takes the same branch.
  'Built?': { main: [to('Publish To Buffer'), to('Record Run')] },
  'Publish To Buffer': { main: [to('Record Run')] },
  'Record Run': { main: [to('Prune Output')] },
  'Prune Output': { main: [to('Check Topics')] },
  'Check Topics': { main: [to('Topics Low?')] },
  // False goes nowhere: most runs end here.
  'Topics Low?': { main: [to('Refill Topics'), []] },
  'Refill Topics': { main: [to('Merge Topics')] },
};

const ifTrue = (id, expression) => ({
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [{
      id,
      leftValue: expression,
      rightValue: true,
      operator: { type: 'boolean', operation: 'true', singleValue: true },
    }],
    combinator: 'and',
  },
  looseTypeValidation: true,
  options: {},
});

function definition() {
  const at = (name) => [-560 + CHAIN.indexOf(name) * 210, 0];

  const nodes = [
    {
      id: 'dy-cron',
      name: 'Twice Daily',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: at('Twice Daily'),
      // The workflow's own timezone setting is Asia/Ho_Chi_Minh, so this hour is
      // local and does not drift with daylight saving anywhere else.
      parameters: {
        rule: {
          interval: BUILD_HOURS_ICT.map((hour) => ({
            field: 'days', daysInterval: 1, triggerAtHour: hour, triggerAtMinute: 0,
          })),
        },
      },
    },
    {
      id: 'dy-dryrun',
      name: 'Dry Run Hook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2.1,
      position: [at('Twice Daily')[0], 200],
      webhookId: 'c3e9a1d2-7f40-4b6e-9a18-5d2c0b7e4f61',
      // Answers at once: the build behind it takes minutes. Watch the run with
      // `node host/inspect-execution.js`.
      parameters: { httpMethod: 'POST', path: 'daily-dry-run', responseMode: 'onReceived', options: {} },
    },
    {
      id: 'dy-topic',
      name: 'Pick Topic',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: at('Pick Topic'),
      parameters: { mode: 'runOnceForAllItems', jsCode: nodeCodeWithLib('01_pick_topic.js') },
    },
    {
      id: 'dy-build',
      name: 'Build Video',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.5,
      position: at('Build Video'),
      onError: 'continueRegularOutput',
      parameters: {
        method: 'POST',
        url: `${SELF}/shadowing`,
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ topic: $json.topic, sentenceCount: 6, orientation: "portrait" }) }}',
        // Generous: Groq, a stock search and Claude review per scene, and two
        // encodes. A hundred seconds is normal, so this is about five times that.
        options: { timeout: 540000 },
      },
    },
    {
      id: 'dy-built',
      name: 'Built?',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: at('Built?'),
      parameters: ifTrue('has-run',
        "={{ $json.ok === true && !!$json.runId && $('Pick Topic').first().json.dryRun !== true }}"),
    },
    {
      id: 'dy-publish',
      name: 'Publish To Buffer',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.5,
      position: at('Publish To Buffer'),
      onError: 'continueRegularOutput',
      parameters: {
        method: 'POST',
        url: `${SELF}/buffer-publish`,
        sendBody: true,
        specifyBody: 'json',
        // dueAt rather than the queue: the whole point of the schedule is that
        // the post lands on the slot, and `addToQueue` would put it wherever
        // Buffer's own posting times happen to fall.
        jsonBody: '={{ JSON.stringify({ runId: $json.runId, dueAt: $(\'Pick Topic\').first().json.dueAt }) }}',
        options: { timeout: 180000 },
      },
    },
    {
      id: 'dy-record',
      name: 'Record Run',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: at('Record Run'),
      parameters: { mode: 'runOnceForAllItems', jsCode: nodeCodeWithLib('02_record_run.js') },
    },
    {
      id: 'dy-prune',
      name: 'Prune Output',
      type: 'n8n-nodes-base.executeCommand',
      typeVersion: 1,
      position: at('Prune Output'),
      parameters: {
        executeOnce: true,
        command: `node ${IN_CONTAINER}/container/cli/prune_output.js ${IN_CONTAINER}/output ${KEEP_RUNS}`,
      },
    },
    {
      id: 'dy-check-topics',
      name: 'Check Topics',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: at('Check Topics'),
      parameters: { mode: 'runOnceForAllItems', jsCode: nodeCodeWithLib('03_check_topics.js') },
    },
    {
      id: 'dy-topics-low',
      name: 'Topics Low?',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: at('Topics Low?'),
      parameters: ifTrue('need-refill', '={{ $json.need === true }}'),
    },
    {
      id: 'dy-refill',
      name: 'Refill Topics',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.5,
      position: at('Refill Topics'),
      // Claude being down only delays the refill to the next run; Merge Topics
      // logs the error.
      onError: 'continueRegularOutput',
      parameters: {
        method: 'POST',
        url: 'http://host.docker.internal:7861/topics',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ existing: $json.existing, recent: $json.recent, count: $json.batch }) }}',
        options: { timeout: 180000 },
      },
    },
    {
      id: 'dy-merge-topics',
      name: 'Merge Topics',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: at('Merge Topics'),
      parameters: { mode: 'runOnceForAllItems', jsCode: nodeCodeWithLib('04_merge_topics.js') },
    },
  ];

  return {
    name: 'Daily Shadowing Video',
    slug: 'daily',
    webhookPath: 'daily-dry-run',
    nodes,
    connections: CONNECTIONS,
    settings: { executionOrder: 'v1', saveManualExecutions: true, timezone: 'Asia/Ho_Chi_Minh' },
  };
}

module.exports = { definition, CHAIN };
