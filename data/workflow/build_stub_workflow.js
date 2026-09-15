#!/usr/bin/env node
/**
 * Deploys a stub twin of the real workflow with the Groq call swapped for a
 * canned completion. Everything after it - normalisation, TTS, the binary
 * write, the paired-item index lookup, both Execute Command steps, the SRT
 * maths - runs for real, so the pipeline can be proven end to end before a
 * Groq key exists. Separate workflow, so the real one is never touched.
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
const WF_NAME = 'AI Shadowing Video Generator (stub)';

const workflow = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflow.json'), 'utf8'));

const CANNED = {
  sentences: [
    { en: 'Hi there, could I get a large iced latte, please?', vi: 'Chào bạn, cho tôi một ly latte đá lớn nhé?' },
    { en: 'Sure thing. Would you like any syrup with that?', vi: 'Được thôi. Bạn có muốn thêm siro không?' },
    { en: 'Just a little vanilla, and can you make it less sweet?', vi: 'Một chút vani thôi, và làm ít ngọt giúp tôi được không?' },
    { en: 'No problem. That comes to $5.75 altogether.', vi: 'Không vấn đề gì. Tổng cộng là 5,75 đô la.' },
    { en: 'Here you go. Do you take cards, or is it cash only?', vi: 'Của bạn đây. Bạn nhận thẻ hay chỉ tiền mặt?' },
    { en: 'Cards are fine. Your drink will be ready in 3 minutes.', vi: 'Thẻ cũng được. Đồ uống của bạn sẽ xong sau 3 phút.' },
  ],
};

// Shaped exactly like a Groq chat completion so Parse & Normalize is unchanged.
const stubNode = {
  id: 'n-groq',
  name: 'Generate Dialogue',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [-180, 0],
  parameters: {
    mode: 'runOnceForAllItems',
    jsCode: `// STUB: stands in for the Groq call so the rest of the pipeline can be proven.\nreturn [{ json: { choices: [{ message: { content: ${JSON.stringify(JSON.stringify(CANNED))} } }] } }];`,
  },
};

workflow.name = WF_NAME;
workflow.nodes = workflow.nodes.map((n) => (n.name === 'Generate Dialogue' ? stubNode : n));
// A distinct path and webhookId, otherwise the two workflows fight over /shadowing.
const hook = workflow.nodes.find((n) => n.name === 'Webhook');
hook.parameters.path = 'shadowing-stub';
hook.webhookId = 'b1d4e5f6-0c77-4a22-9b33-8e1a2d3c4b55';

const api = async (method, route, body) => {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { 'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${text.slice(0, 600)}`);
  return JSON.parse(text);
};

(async () => {
  const existing = (await api('GET', '/workflows?limit=250')).data.find((w) => w.name === WF_NAME);
  const saved = existing
    ? await api('PUT', `/workflows/${existing.id}`, {
      name: workflow.name, nodes: workflow.nodes, connections: workflow.connections, settings: workflow.settings,
    })
    : await api('POST', '/workflows', {
      name: workflow.name, nodes: workflow.nodes, connections: workflow.connections, settings: workflow.settings,
    });

  await api('POST', `/workflows/${saved.id}/activate`);
  console.log(JSON.stringify({
    action: existing ? 'updated' : 'created',
    workflowId: saved.id,
    active: true,
    webhook: 'http://localhost:5678/webhook/shadowing-stub',
  }, null, 2));
})().catch((err) => { console.error(err.message); process.exit(1); });
