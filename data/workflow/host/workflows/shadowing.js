/**
 * The shadowing video workflow.
 *
 * Exports a definition rather than deploying: host/deploy.js does the pushing,
 * and shadowing-stub.js derives from this definition in memory so the two can
 * never drift apart.
 *
 * Code node bodies are read from container/nodes/shadowing/ - real files that can
 * be linted and unit-tested outside n8n. See CLAUDE.md for why they live under
 * container/.
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../lib/config');

/** Path prefix as seen from inside the n8n container, not from the host. */
const IN_CONTAINER = '/data/workflow';

const nodeCode = (file) =>
  fs.readFileSync(path.join(ROOT, 'container', 'nodes', 'shadowing', file), 'utf8');

const SYSTEM_PROMPT = [
  'You write short, natural English conversations for listening-and-shadowing practice.',
  'Return ONLY a JSON object of this shape:',
  '{"sentences":[{"speaker":"A","en":"<one English line>","vi":"<natural Vietnamese translation>","imageQuery":"<2-4 word stock photo search>"}]}',
  'Rules:',
  '- Everyday spoken register, the kind of thing people actually say. No textbook stiffness.',
  '- The lines must form ONE coherent two-person exchange on the given topic, in order.',
  '- `speaker` is "A" or "B" and must alternate as the turns alternate, starting at "A".',
  '  A is the person with the need (customer, traveller, caller); B is the other side.',
  '- 8 to 16 words per line, so a learner can repeat each one in a single breath.',
  '- Plain words only: no emoji, no markdown, no bracketed speaker labels.',
  '- The Vietnamese must read like natural Vietnamese, not a word-for-word gloss.',
  '- `imageQuery` is what a stock photo library is searched for to illustrate that line.',
  '  Concrete, photographable nouns only - "hotel reception desk", "handing over credit card".',
  '  Never abstract ideas, never names, never words like "conversation" or "person talking".',
].join('\n');

// Groq has retired llama-3.3-70b-versatile; gpt-oss-120b is the closest equivalent
// still on the free tier. `reasoning_effort: low` matters: at the default the model
// burns ~820 completion tokens on six lines, which alone breaches the free tier's
// 1000 output-tokens-per-minute cap. At low it writes eight better lines in ~260.
const GROQ_BODY = `={{ JSON.stringify({
  model: "openai/gpt-oss-120b",
  temperature: 0.8,
  max_tokens: 900,
  reasoning_effort: "low",
  response_format: { type: "json_object" },
  messages: [
    { role: "system", content: ${JSON.stringify(SYSTEM_PROMPT)} },
    { role: "user", content: "Topic: " + $json.topic + "\\nWrite exactly " + $json.sentenceCount + " sentences." }
  ]
}) }}`;

const TTS_BODY = `={{ JSON.stringify({
  model: "tts-1",
  input: $json.ttsText,
  voice: $json.voice,
  response_format: "mp3",
  speed: $json.speed
}) }}`;

/** Node order is the execution order; connections are derived from it. */
const CHAIN = ['Webhook', 'Prepare Run', 'Generate Dialogue', 'Parse & Normalize',
  'Synthesize Speech', 'Keep Successful Audio', 'Write Sentence Audio',
  'Search Pexels', 'Collect Pexels', 'Fetch Scenes', 'Fetch Music',
  'Probe Durations', 'Build SRT', 'Assemble Video', 'Build Response', 'Respond to Webhook'];

function linearConnections(chain) {
  return Object.fromEntries(
    chain.slice(0, -1).map((from, i) => [from, { main: [[{ node: chain[i + 1], type: 'main', index: 0 }]] }]),
  );
}

function definition({ credentials }) {
  // Position follows CHAIN, so adding a step shifts the canvas instead of parking
  // the new node on top of an existing one.
  const at = (name) => [-620 + CHAIN.indexOf(name) * 220, 0];

  const nodes = [
    {
      id: 'n-webhook',
      name: 'Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2.1,
      position: at('Webhook'),
      webhookId: 'a7c3f1e2-9b44-4d10-8e55-6f2b1c0d9a31',
      parameters: { httpMethod: 'POST', path: 'shadowing', responseMode: 'responseNode', options: {} },
    },
    {
      id: 'n-prepare',
      name: 'Prepare Run',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: at('Prepare Run'),
      parameters: { mode: 'runOnceForAllItems', jsCode: nodeCode('01_prepare_run.js') },
    },
    {
      id: 'n-groq',
      name: 'Generate Dialogue',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.5,
      position: at('Generate Dialogue'),
      // Groq's free tier rate-limits aggressively. n8n's retry interval is fixed
      // rather than exponential, so this is five attempts five seconds apart -
      // enough to ride out a short 429 window.
      retryOnFail: true,
      maxTries: 5,
      waitBetweenTries: 5000,
      parameters: {
        method: 'POST',
        url: 'https://api.groq.com/openai/v1/chat/completions',
        authentication: 'predefinedCredentialType',
        nodeCredentialType: 'groqApi',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: GROQ_BODY,
        options: { timeout: 60000 },
      },
      credentials: { groqApi: credentials.groq },
    },
    {
      id: 'n-parse',
      name: 'Parse & Normalize',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: at('Parse & Normalize'),
      parameters: { mode: 'runOnceForAllItems', jsCode: nodeCode('02_parse_normalize.js') },
    },
    {
      id: 'n-tts',
      name: 'Synthesize Speech',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.5,
      position: at('Synthesize Speech'),
      // A sentence that will not synthesise must not sink the run: the item is
      // passed through carrying its error, filtered out next, and reported at the
      // end as a skipped sentence.
      retryOnFail: true,
      maxTries: 3,
      waitBetweenTries: 2000,
      onError: 'continueRegularOutput',
      parameters: {
        method: 'POST',
        url: 'http://edge-tts:5050/v1/audio/speech',
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: TTS_BODY,
        options: {
          timeout: 120000,
          response: { response: { responseFormat: 'file', outputPropertyName: 'data' } },
        },
      },
      credentials: { httpHeaderAuth: credentials.edgeTts },
    },
    {
      id: 'n-filter',
      name: 'Keep Successful Audio',
      type: 'n8n-nodes-base.filter',
      typeVersion: 2.3,
      position: at('Keep Successful Audio'),
      parameters: {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
          conditions: [{
            id: 'has-audio',
            leftValue: '={{ Object.keys($binary || {}).length > 0 }}',
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
      id: 'n-write',
      name: 'Write Sentence Audio',
      type: 'n8n-nodes-base.readWriteFile',
      typeVersion: 1.1,
      position: at('Write Sentence Audio'),
      parameters: {
        operation: 'write',
        // The index comes from the paired item: the HTTP node replaces `json` with
        // the binary response, so it is no longer on this item.
        fileName: "={{ $('Prepare Run').first().json.workDir }}/sent_{{ String($('Parse & Normalize').item.json.idx).padStart(3, '0') }}.mp3",
        dataPropertyName: 'data',
        options: {},
      },
    },
    {
      id: 'n-pexels',
      name: 'Search Pexels',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.5,
      position: at('Search Pexels'),
      // Optional by design: with no key, a bad key or an exhausted quota this
      // passes the error through and every scene falls back to Openverse.
      onError: 'continueRegularOutput',
      retryOnFail: true,
      maxTries: 2,
      waitBetweenTries: 1000,
      parameters: {
        method: 'GET',
        url: 'https://api.pexels.com/v1/search',
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendQuery: true,
        specifyQuery: 'keypair',
        queryParameters: {
          parameters: [
            { name: 'query', value: "={{ $('Parse & Normalize').item.json.imageQuery }}" },
            { name: 'per_page', value: '3' },
            { name: 'orientation', value: 'landscape' },
          ],
        },
        options: { timeout: 20000 },
      },
      credentials: { httpHeaderAuth: credentials.pexels },
    },
    {
      id: 'n-pexels-collect',
      name: 'Collect Pexels',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: at('Collect Pexels'),
      parameters: { mode: 'runOnceForAllItems', jsCode: nodeCode('05_collect_pexels.js') },
    },
    {
      id: 'n-scenes',
      name: 'Fetch Scenes',
      type: 'n8n-nodes-base.executeCommand',
      typeVersion: 1,
      position: at('Fetch Scenes'),
      // Illustration is a nice-to-have: if every image lookup fails the script
      // still exits 0 with an empty list, and the video falls back to the flat
      // background rather than the run dying over a picture.
      parameters: {
        executeOnce: true,
        command: `=node ${IN_CONTAINER}/container/cli/fetch_scenes.js '{{ $('Prepare Run').first().json.workDir }}'`,
      },
    },
    {
      id: 'n-music',
      name: 'Fetch Music',
      type: 'n8n-nodes-base.executeCommand',
      typeVersion: 1,
      position: at('Fetch Music'),
      // Same contract as Fetch Scenes: a bed is a nice-to-have, so the script
      // exits 0 with `music: null` when there is nothing to use and the run keeps
      // going with speech-only audio.
      parameters: {
        executeOnce: true,
        command: `=node ${IN_CONTAINER}/container/cli/fetch_music.js '{{ $('Prepare Run').first().json.workDir }}'`,
      },
    },
    {
      id: 'n-probe',
      name: 'Probe Durations',
      type: 'n8n-nodes-base.executeCommand',
      typeVersion: 1,
      position: at('Probe Durations'),
      parameters: {
        executeOnce: true,
        command: `=node ${IN_CONTAINER}/container/cli/probe_durations.js '{{ $('Prepare Run').first().json.workDir }}'`,
      },
    },
    {
      id: 'n-srt',
      name: 'Build SRT',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: at('Build SRT'),
      parameters: { mode: 'runOnceForAllItems', jsCode: nodeCode('03_build_srt.js') },
    },
    {
      id: 'n-assemble',
      name: 'Assemble Video',
      type: 'n8n-nodes-base.executeCommand',
      typeVersion: 1,
      position: at('Assemble Video'),
      parameters: {
        executeOnce: true,
        command: `=node ${IN_CONTAINER}/container/cli/build_video.js '{{ $json.planPath }}'`,
      },
    },
    {
      id: 'n-response',
      name: 'Build Response',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: at('Build Response'),
      parameters: { mode: 'runOnceForAllItems', jsCode: nodeCode('04_build_response.js') },
    },
    {
      id: 'n-respond',
      name: 'Respond to Webhook',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1.5,
      position: at('Respond to Webhook'),
      parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json) }}', options: {} },
    },
  ];

  return {
    name: 'AI Shadowing Video Generator',
    slug: 'shadowing',
    webhookPath: 'shadowing',
    nodes,
    connections: linearConnections(CHAIN),
    settings: { executionOrder: 'v1', saveManualExecutions: true, timezone: 'Asia/Ho_Chi_Minh' },
  };
}

module.exports = { definition, IN_CONTAINER, CHAIN, linearConnections };
