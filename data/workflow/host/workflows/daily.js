/**
 * One video a day, posted to TikTok at 19:00 Asia/Ho_Chi_Minh.
 *
 * Builds at 18:00 and schedules the post for 19:00 the same day. The hour of
 * slack is deliberate: a build takes about 100 seconds when everything behaves,
 * but it reaches out to Groq, an image model and S3, and any of those can be
 * slow. Posting is handed to Buffer with an explicit `dueAt`, so even a build
 * that overruns still goes out on time.
 *
 * It drives the two existing webhooks rather than duplicating their nodes. Those
 * endpoints are the ones that have been exercised by hand all along; a scheduled
 * run that takes a different path through the code would be a second thing to
 * trust.
 *
 * Can also be run by hand from the n8n UI - the schedule is the only trigger,
 * but "Execute workflow" does the same thing immediately.
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../lib/config');

const nodeCode = (file) =>
  fs.readFileSync(path.join(ROOT, 'container', 'nodes', 'daily', file), 'utf8');

// Local, because n8n is calling its own webhooks from inside the same container.
const SELF = 'http://localhost:5678/webhook';

const BUILD_HOUR_ICT = 18;

const CHAIN = ['Every Day', 'Pick Topic', 'Build Video', 'Built?', 'Publish To Buffer',
  'Record Run'];
const to = (node) => [{ node, type: 'main', index: 0 }];

const CONNECTIONS = {
  'Every Day': { main: [to('Pick Topic')] },
  'Pick Topic': { main: [to('Build Video')] },
  'Build Video': { main: [to('Built?')] },
  // A failed build must not reach Buffer: posting nothing is better than posting
  // a half-made video, and the history entry still records the attempt.
  'Built?': { main: [to('Publish To Buffer'), to('Record Run')] },
  'Publish To Buffer': { main: [to('Record Run')] },
};

function definition() {
  const at = (name) => [-560 + CHAIN.indexOf(name) * 210, 0];

  const nodes = [
    {
      id: 'dy-cron',
      name: 'Every Day',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: at('Every Day'),
      // The workflow's own timezone setting is Asia/Ho_Chi_Minh, so this hour is
      // local and does not drift with daylight saving anywhere else.
      parameters: {
        rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: BUILD_HOUR_ICT, triggerAtMinute: 0 }] },
      },
    },
    {
      id: 'dy-topic',
      name: 'Pick Topic',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: at('Pick Topic'),
      parameters: { mode: 'runOnceForAllItems', jsCode: nodeCode('01_pick_topic.js') },
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
        // Generous: Groq, six generated images and two encodes. A hundred
        // seconds is normal, so this is roughly five times the expected cost.
        options: { timeout: 540000 },
      },
    },
    {
      id: 'dy-built',
      name: 'Built?',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: at('Built?'),
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
          conditions: [{
            id: 'has-run',
            leftValue: '={{ $json.ok === true && !!$json.runId }}',
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
        // the post lands at 19:00, and `addToQueue` would put it wherever
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
      parameters: { mode: 'runOnceForAllItems', jsCode: nodeCode('02_record_run.js') },
    },
  ];

  return {
    name: 'Daily Shadowing Video',
    slug: 'daily',
    nodes,
    connections: CONNECTIONS,
    settings: { executionOrder: 'v1', saveManualExecutions: true, timezone: 'Asia/Ho_Chi_Minh' },
  };
}

module.exports = { definition, CHAIN };
