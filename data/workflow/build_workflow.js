#!/usr/bin/env node
/**
 * Builds the shadowing workflow and pushes it through the n8n public REST API.
 * Re-runnable: if a workflow with the same name exists it is updated in place,
 * so the webhook URL and any execution history survive.
 *
 * Code node bodies live in scripts/nodes/*.js rather than inline here - they are
 * real files you can lint, diff and unit-test outside n8n.
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.env'), 'utf8')
    .split('\n').filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

const API = env.N8N_API_URL;
const KEY = env.N8N_API_KEY;
const CRED_GROQ = { id: env.CRED_GROQ_ID, name: 'Groq API' };
const CRED_TTS = { id: env.CRED_EDGETTS_ID, name: 'EdgeTTS Header Auth' };
const WF_NAME = 'AI Shadowing Video Generator';

const code = (f) => fs.readFileSync(path.join(ROOT, 'scripts', 'nodes', f), 'utf8');

// ---- the prompt handed to Groq --------------------------------------------
const SYSTEM_PROMPT = [
  'You write short, natural English conversations for listening-and-shadowing practice.',
  'Return ONLY a JSON object of this shape:',
  '{"sentences":[{"en":"<one English line>","vi":"<natural Vietnamese translation>"}]}',
  'Rules:',
  '- Everyday spoken register, the kind of thing people actually say. No textbook stiffness.',
  '- The lines must form ONE coherent two-person exchange on the given topic, in order.',
  '- 8 to 16 words per line, so a learner can repeat each one in a single breath.',
  '- Plain words only: no emoji, no markdown, no bracketed speaker labels.',
  '- The Vietnamese must read like natural Vietnamese, not a word-for-word gloss.',
].join('\n');

// Groq has retired llama-3.3-70b-versatile; gpt-oss-120b is the closest
// equivalent still on the free tier. `reasoning_effort: low` matters: at the
// default the model burns ~820 completion tokens on six lines, which alone
// breaches the free tier's 1000 output-tokens-per-minute cap. At low it writes
// eight better lines in ~260.
const groqBody = `={{ JSON.stringify({
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

const ttsBody = `={{ JSON.stringify({
  model: "tts-1",
  input: $json.ttsText,
  voice: $json.voice,
  response_format: "mp3",
  speed: $json.speed
}) }}`;

// ---- nodes -----------------------------------------------------------------
const nodes = [
  {
    id: 'n-webhook',
    name: 'Webhook',
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2.1,
    position: [-620, 0],
    webhookId: 'a7c3f1e2-9b44-4d10-8e55-6f2b1c0d9a31',
    parameters: {
      httpMethod: 'POST',
      path: 'shadowing',
      responseMode: 'responseNode',
      options: {},
    },
  },
  {
    id: 'n-prepare',
    name: 'Prepare Run',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [-400, 0],
    parameters: { mode: 'runOnceForAllItems', jsCode: code('01_prepare_run.js') },
  },
  {
    id: 'n-groq',
    name: 'Generate Dialogue',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.5,
    position: [-180, 0],
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
      jsonBody: groqBody,
      options: { timeout: 60000 },
    },
    credentials: { groqApi: CRED_GROQ },
  },
  {
    id: 'n-parse',
    name: 'Parse & Normalize',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [40, 0],
    parameters: { mode: 'runOnceForAllItems', jsCode: code('02_parse_normalize.js') },
  },
  {
    id: 'n-tts',
    name: 'Synthesize Speech',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.5,
    position: [260, 0],
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
      jsonBody: ttsBody,
      options: {
        timeout: 120000,
        response: { response: { responseFormat: 'file', outputPropertyName: 'data' } },
      },
    },
    credentials: { httpHeaderAuth: CRED_TTS },
  },
  {
    id: 'n-filter',
    name: 'Keep Successful Audio',
    type: 'n8n-nodes-base.filter',
    typeVersion: 2.3,
    position: [480, 0],
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
    position: [700, 0],
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
    id: 'n-probe',
    name: 'Probe Durations',
    type: 'n8n-nodes-base.executeCommand',
    typeVersion: 1,
    position: [920, 0],
    parameters: {
      executeOnce: true,
      command: "=node /data/workflow/scripts/probe_durations.js '{{ $('Prepare Run').first().json.workDir }}'",
    },
  },
  {
    id: 'n-srt',
    name: 'Build SRT',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [1140, 0],
    parameters: { mode: 'runOnceForAllItems', jsCode: code('03_build_srt.js') },
  },
  {
    id: 'n-assemble',
    name: 'Assemble Video',
    type: 'n8n-nodes-base.executeCommand',
    typeVersion: 1,
    position: [1360, 0],
    parameters: {
      executeOnce: true,
      command: "=node /data/workflow/scripts/build_video.js '{{ $json.planPath }}'",
    },
  },
  {
    id: 'n-response',
    name: 'Build Response',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [1580, 0],
    parameters: { mode: 'runOnceForAllItems', jsCode: code('04_build_response.js') },
  },
  {
    id: 'n-respond',
    name: 'Respond to Webhook',
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.5,
    position: [1800, 0],
    parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json) }}', options: {} },
  },
];

const chain = ['Webhook', 'Prepare Run', 'Generate Dialogue', 'Parse & Normalize',
  'Synthesize Speech', 'Keep Successful Audio', 'Write Sentence Audio', 'Probe Durations',
  'Build SRT', 'Assemble Video', 'Build Response', 'Respond to Webhook'];

const connections = {};
for (let i = 0; i < chain.length - 1; i += 1) {
  connections[chain[i]] = { main: [[{ node: chain[i + 1], type: 'main', index: 0 }]] };
}

const workflow = {
  name: WF_NAME,
  nodes,
  connections,
  settings: { executionOrder: 'v1', saveManualExecutions: true, timezone: 'Asia/Ho_Chi_Minh' },
};

// ---- push -------------------------------------------------------------------
const api = async (method, route, body) => {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { 'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${text.slice(0, 600)}`);
  return json;
};

(async () => {
  const existing = (await api('GET', '/workflows?limit=250')).data
    .find((w) => w.name === WF_NAME);

  const saved = existing
    ? await api('PUT', `/workflows/${existing.id}`, workflow)
    : await api('POST', '/workflows', workflow);

  fs.writeFileSync(path.join(ROOT, 'workflow.json'), JSON.stringify(workflow, null, 2));

  console.log(JSON.stringify({
    action: existing ? 'updated' : 'created',
    workflowId: saved.id,
    name: saved.name,
    nodes: saved.nodes.length,
    editor: `http://localhost:5678/workflow/${saved.id}`,
    testWebhook: 'http://localhost:5678/webhook-test/shadowing',
    prodWebhook: 'http://localhost:5678/webhook/shadowing',
  }, null, 2));
})().catch((err) => { console.error(err.message); process.exit(1); });
