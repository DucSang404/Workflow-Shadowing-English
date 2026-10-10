// Run on the host: node --test container/cli/lib/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { pickBest, candidateKey } = require('./pick_best');

const c = (key, score) => ({ key, score });

test('picks the highest score at or above the bar', () => {
  const r = pickBest([c('a', 60), c('b', 81), c('c', 74)], 72, new Set());
  assert.equal(r.choice.key, 'b');
  assert.equal(r.pass, true);
});

test('below the bar it still returns the best, marked as a fail', () => {
  const r = pickBest([c('a', 40), c('b', 65), c('c', 50)], 72, new Set());
  assert.equal(r.choice.key, 'b');
  assert.equal(r.pass, false);
});

test('a score exactly at the bar passes', () => {
  assert.equal(pickBest([c('a', 72)], 72, new Set()).pass, true);
});

test('skips a candidate another scene already used', () => {
  const r = pickBest([c('a', 90), c('b', 75)], 72, new Set(['a']));
  assert.equal(r.choice.key, 'b');
  assert.equal(r.pass, true);
});

test('a tie keeps source order', () => {
  assert.equal(pickBest([c('a', 80), c('b', 80)], 72, new Set()).choice.key, 'a');
});

test('ignores candidates without a numeric score', () => {
  const r = pickBest([{ key: 'a' }, c('b', 30)], 72, new Set());
  assert.equal(r.choice.key, 'b');
});

test('nothing usable gives no choice', () => {
  assert.deepEqual(pickBest([], 72, new Set()), { choice: null, pass: null });
  assert.deepEqual(pickBest([c('a', 90)], 72, new Set(['a'])), { choice: null, pass: null });
});

test('candidateKey uses the id, and the url when there is none', () => {
  assert.equal(candidateKey({ source: 'unsplash', id: 'x1', url: 'https://a' }), 'unsplash:x1');
  assert.equal(candidateKey({ source: 'openverse', url: 'https://b' }), 'openverse:https://b');
});
