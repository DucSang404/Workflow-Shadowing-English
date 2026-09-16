#!/usr/bin/env node
/**
 * Per-node summary of an n8n execution.
 *
 *   node host/inspect-execution.js        # the most recent execution
 *   node host/inspect-execution.js 12     # a specific one
 *
 * This is the first thing to run when a webhook returns an empty body: n8n
 * answers 200 and the real cause is in the execution record.
 */
const { client } = require('./lib/n8n');

const INTERESTING = ['Probe Durations', 'Build SRT', 'Assemble Video', 'Build Response'];

(async () => {
  const n8n = client();

  const id = process.argv[2] ?? (await n8n.get('/executions?limit=1')).data[0]?.id;
  if (!id) { console.log('no executions yet'); return; }

  const execution = await n8n.get(`/executions/${id}?includeData=true`);
  const result = execution.data?.resultData ?? {};

  console.log(`execution ${id}  status=${execution.status}  lastNode=${result.lastNodeExecuted}`);

  if (result.error) {
    console.log(`\nERROR in "${result.error.node?.name}": ${result.error.message}`);
    if (result.error.description) console.log(`  ${result.error.description}`);
    if (result.error.stack) console.log(`  ${String(result.error.stack).split('\n').slice(0, 4).join('\n  ')}`);
  }

  console.log('\nper-node:');
  for (const [name, runs] of Object.entries(result.runData ?? {})) {
    const run = runs[0] ?? {};
    const items = run.data?.main?.[0]?.length ?? 0;
    const err = run.error?.message ? `  !! ${run.error.message}` : '';
    console.log(`  ${name.padEnd(24)} ${String(run.executionStatus ?? '?').padEnd(9)} items=${items}${err}`);
  }

  for (const name of INTERESTING) {
    const out = result.runData?.[name]?.[0]?.data?.main?.[0]?.[0]?.json;
    if (out) console.log(`\n${name} output:\n ${JSON.stringify(out).slice(0, 900)}`);
  }
})().catch((err) => { console.error(err.message); process.exit(1); });
