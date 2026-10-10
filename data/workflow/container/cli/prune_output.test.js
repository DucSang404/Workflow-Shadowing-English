// Run on the host: node --test container/cli/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'prune_output.js');
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

function fakeOutput() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-'));
  const ids = [];
  for (let i = 1; i <= 13; i += 1) {
    const runId = `${String(20261001000000 + i * 100)}_abc${String(i).padStart(3, '0')}`;
    ids.push(runId);
    for (const ext of ['.mp4', '.srt', '.json', '_caption.txt', '_cover.jpg']) {
      fs.writeFileSync(path.join(dir, `${runId}${ext}`), 'x');
    }
    if (i === 2) fs.writeFileSync(path.join(dir, `${runId}_landscape.mp4`), 'x');
  }
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine');
  return { dir, ids };
}

test('keeps the newest N runs and every file that belongs to them', () => {
  const { dir, ids } = fakeOutput();
  const r = run(dir, '10');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.kept, 10);
  assert.deepEqual(out.removed, [ids[2], ids[1], ids[0]]);
  assert.equal(out.files, 16); // 3 runs x 5 files, plus the extra landscape mp4
  const left = fs.readdirSync(dir);
  for (const id of ids.slice(3)) assert.ok(left.includes(`${id}.mp4`), `${id} kept`);
  for (const id of ids.slice(0, 3)) assert.ok(!left.some((f) => f.startsWith(id)), `${id} removed`);
  assert.ok(left.includes('notes.txt'), 'unrelated file untouched');
});

test('fewer runs than keep removes nothing', () => {
  const { dir } = fakeOutput();
  const out = JSON.parse(run(dir, '50').stdout);
  assert.equal(out.kept, 13);
  assert.deepEqual(out.removed, []);
});

test('a missing directory is reported, not fatal', () => {
  const r = run(path.join(os.tmpdir(), 'prune-does-not-exist-xyz'), '10');
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), { kept: 0, removed: [], files: 0 });
});

test('a bad keep is a usage error', () => {
  const { dir } = fakeOutput();
  assert.equal(run(dir, '0').status, 1);
  assert.equal(run(dir, 'ten').status, 1);
  assert.equal(run(dir).status, 1);
});
