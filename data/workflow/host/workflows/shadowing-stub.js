/**
 * Stub twin of the shadowing workflow: the Groq call is swapped for a canned
 * completion, everything after it runs for real.
 *
 * Use it to exercise normalisation, TTS, the binary write, the paired-item index
 * lookup, both Execute Command steps and the SRT maths without spending Groq
 * quota - the free tier only allows about one real run per minute.
 *
 * It derives from the real definition in memory, so the two cannot drift.
 */
const { definition: real } = require('./shadowing');

const CANNED = {
  sentences: [
    { speaker: 'A', en: 'Hi there, could I get a large iced latte, please?', vi: 'Chào bạn, cho tôi một ly latte đá lớn nhé?' },
    { speaker: 'B', en: 'Sure thing. Would you like any syrup with that?', vi: 'Được thôi. Bạn có muốn thêm siro không?' },
    { speaker: 'A', en: 'Just a little vanilla, and can you make it less sweet?', vi: 'Một chút vani thôi, và làm ít ngọt giúp tôi được không?' },
    { speaker: 'B', en: 'No problem. That comes to $5.75 altogether.', vi: 'Không vấn đề gì. Tổng cộng là 5,75 đô la.' },
    { speaker: 'A', en: 'Here you go. Do you take cards, or is it cash only?', vi: 'Của bạn đây. Bạn nhận thẻ hay chỉ tiền mặt?' },
    { speaker: 'B', en: 'Cards are fine. Your drink will be ready in 3 minutes.', vi: 'Thẻ cũng được. Đồ uống của bạn sẽ xong sau 3 phút.' },
  ],
};

function definition(opts) {
  const base = real(opts);

  // Shaped exactly like a Groq chat completion, so Parse & Normalize is untouched.
  const stub = {
    id: 'n-groq',
    name: 'Generate Dialogue',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: base.nodes.find((n) => n.name === 'Generate Dialogue').position,
    parameters: {
      mode: 'runOnceForAllItems',
      jsCode: [
        '// STUB: stands in for the Groq call so the rest of the pipeline can be',
        '// proven without spending free-tier quota. Edited via host/workflows/shadowing-stub.js.',
        `return [{ json: { choices: [{ message: { content: ${JSON.stringify(JSON.stringify(CANNED))} } }] } }];`,
      ].join('\n'),
    },
  };

  const nodes = base.nodes.map((n) => (n.name === 'Generate Dialogue' ? stub : n));

  // A distinct path and webhookId, otherwise the two workflows fight over /shadowing.
  const webhook = nodes.find((n) => n.name === 'Webhook');
  webhook.parameters = { ...webhook.parameters, path: 'shadowing-stub' };
  webhook.webhookId = 'b1d4e5f6-0c77-4a22-9b33-8e1a2d3c4b55';

  return {
    ...base,
    name: 'AI Shadowing Video Generator (stub)',
    slug: 'shadowing-stub',
    webhookPath: 'shadowing-stub',
    nodes,
  };
}

module.exports = { definition };
