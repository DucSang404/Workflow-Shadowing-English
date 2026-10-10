// Run on the host: node --test container/nodes/daily/lib/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const t = require('./topics');

test('normalizeTopic folds case, punctuation and spacing', () => {
  assert.equal(t.normalizeTopic('  Asking about a  Warranty! '), 'asking about a warranty');
  assert.equal(t.normalizeTopic("ordering at a café's counter"), 'ordering at a café s counter');
  assert.equal(t.normalizeTopic(null), '');
});

test('refillSettings falls back on missing or out-of-range values', () => {
  assert.deepEqual(t.refillSettings({}), { threshold: 0.9, batch: 30 });
  assert.deepEqual(t.refillSettings({ refill: { threshold: 0.5, batch: 10 } }), { threshold: 0.5, batch: 10 });
  assert.deepEqual(t.refillSettings({ refill: { threshold: 0, batch: 500 } }), { threshold: 0.9, batch: 30 });
  assert.deepEqual(t.refillSettings({ refill: { threshold: 2, batch: 2.5 } }), { threshold: 0.9, batch: 30 });
});

test('poolTopics keeps non-empty trimmed strings only', () => {
  const pool = { topics: [{ topic: ' a b c ' }, { topic: '' }, { topic: 3 }, {}] };
  assert.deepEqual(t.poolTopics(pool), ['a b c']);
  assert.deepEqual(t.poolTopics({}), []);
});

test('pickTopic prefers never-used topics, picked at random among them', () => {
  const used = { a: { count: 1, lastAt: '2026-10-01T00:00:00Z' } };
  assert.deepEqual(t.pickTopic(['a', 'b', 'c'], used, () => 0), { topic: 'b', fresh: 2 });
  assert.deepEqual(t.pickTopic(['a', 'b', 'c'], used, () => 0.99), { topic: 'c', fresh: 2 });
});

test('pickTopic falls back to the least recently used, ties keep pool order', () => {
  const used = {
    a: { count: 2, lastAt: '2026-10-05T00:00:00Z' },
    b: { count: 1, lastAt: '2026-10-01T00:00:00Z' },
    c: { count: 1, lastAt: '2026-10-01T00:00:00Z' },
  };
  assert.deepEqual(t.pickTopic(['a', 'b', 'c'], used), { topic: 'b', fresh: 0 });
});

test('pickTopic on an empty pool picks nothing', () => {
  assert.deepEqual(t.pickTopic([], {}), { topic: null, fresh: 0 });
});

test('usageRatio counts only topics still in the pool', () => {
  const used = { a: { count: 1 }, gone: { count: 4 } };
  assert.equal(t.usageRatio(['a', 'b'], used), 0.5);
  assert.equal(t.usageRatio([], used), 1);
});

test('recordUse bumps the count, sets lastAt, prepends and caps history', () => {
  let s = t.emptyState();
  s = t.recordUse(s, { topic: 'a', at: '2026-10-01T00:00:00Z' });
  s = t.recordUse(s, { topic: 'a', at: '2026-10-02T00:00:00Z' });
  assert.deepEqual(s.used.a, { count: 2, lastAt: '2026-10-02T00:00:00Z' });
  assert.equal(s.history[0].at, '2026-10-02T00:00:00Z');
  for (let i = 0; i < 250; i += 1) s = t.recordUse(s, { topic: `x${i}`, at: 'now' });
  assert.equal(s.history.length, t.HISTORY_CAP);
});

test('recordUse does not mutate its input', () => {
  const s = t.emptyState();
  t.recordUse(s, { topic: 'a', at: 'now' });
  assert.deepEqual(s, t.emptyState());
});

test('addRefill prepends and caps', () => {
  let s = t.emptyState();
  for (let i = 0; i < 60; i += 1) s = t.addRefill(s, { at: String(i), added: i });
  assert.equal(s.refills.length, t.REFILLS_CAP);
  assert.equal(s.refills[0].at, '59');
});

test('mergeTopics adds clean new topics and rejects the rest', () => {
  const pool = { refill: { batch: 30 }, topics: [{ topic: 'asking about a warranty', addedAt: '2026-10-01', source: 'manual' }] };
  const r = t.mergeTopics(pool, [
    'Returning a jacket that does not fit',
    'asking about a WARRANTY.',          // duplicate of the pool after normalising
    'returning a jacket that does not fit', // duplicate within the batch
    'too short',                           // 2 words
    'one two three four five six seven eight nine ten eleven twelve thirteen', // 13 words
    42,
    'booking a table for two at a restaurant',
  ], { batch: 30, today: '2026-10-10' });
  assert.deepEqual(r.added, ['returning a jacket that does not fit', 'booking a table for two at a restaurant']);
  assert.equal(r.rejected.length, 5);
  assert.equal(r.pool.topics.length, 3);
  assert.deepEqual(r.pool.topics[2], { topic: 'booking a table for two at a restaurant', addedAt: '2026-10-10', source: 'claude' });
  assert.equal(pool.topics.length, 1, 'input pool is not mutated');
});

test('mergeTopics stops at batch', () => {
  const r = t.mergeTopics({ topics: [] }, ['a b c', 'd e f', 'g h i'], { batch: 2, today: '2026-10-10' });
  assert.deepEqual(r.added, ['a b c', 'd e f']);
  assert.deepEqual(r.rejected, ['g h i']);
});

test('mergeTopics tolerates a non-array response', () => {
  const r = t.mergeTopics({ topics: [] }, undefined, { batch: 5, today: '2026-10-10' });
  assert.deepEqual(r.added, []);
});

test('todayIct uses UTC+7', () => {
  assert.equal(t.todayIct(Date.parse('2026-10-10T16:59:00Z')), '2026-10-10');
  assert.equal(t.todayIct(Date.parse('2026-10-10T17:00:00Z')), '2026-10-11');
});
