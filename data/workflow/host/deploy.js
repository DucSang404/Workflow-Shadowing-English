#!/usr/bin/env node
/**
 * Deploys workflow definitions to n8n.
 *
 *   node host/deploy.js                 # every registered workflow
 *   node host/deploy.js shadowing       # just one
 *   node host/deploy.js --no-activate   # push without activating
 *
 * Upserts by name, so redeploying keeps the workflow id, the webhook URL and the
 * execution history. A snapshot of what was pushed is written to build/<slug>.json
 * for diffing - build/ is generated, never edit it by hand.
 */
const fs = require('fs');
const path = require('path');
const { ROOT, loadEnv, requireEnv } = require('./lib/config');
const { client } = require('./lib/n8n');

const REGISTRY = {
  shadowing: require('./workflows/shadowing'),
  'shadowing-stub': require('./workflows/shadowing-stub'),
};

(async () => {
  const args = process.argv.slice(2);
  const activate = !args.includes('--no-activate');
  const wanted = args.filter((a) => !a.startsWith('--'));

  const names = wanted.length ? wanted : Object.keys(REGISTRY);
  const unknown = names.filter((n) => !REGISTRY[n]);
  if (unknown.length) {
    throw new Error(`unknown workflow: ${unknown.join(', ')}. Known: ${Object.keys(REGISTRY).join(', ')}`);
  }

  const env = requireEnv(loadEnv(), 'CRED_GROQ_ID', 'CRED_EDGETTS_ID', 'CRED_PEXELS_ID');
  const credentials = {
    groq: { id: env.CRED_GROQ_ID, name: 'Groq API' },
    edgeTts: { id: env.CRED_EDGETTS_ID, name: 'EdgeTTS Header Auth' },
    pexels: { id: env.CRED_PEXELS_ID, name: 'Pexels API' },
  };

  const n8n = client();
  const results = [];

  for (const name of names) {
    const def = REGISTRY[name].definition({ credentials });
    const { saved, action } = await n8n.upsertWorkflow(def);

    fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'build', `${def.slug}.json`), JSON.stringify(def, null, 2));

    if (activate) await n8n.activate(saved.id);

    results.push({
      workflow: def.slug,
      action,
      id: saved.id,
      nodes: saved.nodes.length,
      active: activate,
      webhook: `http://localhost:5678/webhook/${def.webhookPath}`,
    });
  }

  console.log(JSON.stringify(results, null, 2));
})().catch((err) => { console.error(err.message); process.exit(1); });
