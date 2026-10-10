# Bổ sung topic bằng Claude + giữ 10 video + tách pool/state — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Workflow `daily` tự dọn `output/` còn 10 run, tự gọi Claude trên host thêm topic khi pool đã dùng ≥ 90%, và dữ liệu topic tách thành `topics/pool.json` (git) + `topics/state.json` (gitignored).

**Architecture:** Logic topic là hàm thuần trong `container/nodes/daily/lib/topics.js` (có test), được nhúng vào trước Code node lúc deploy. Dọn file là một CLI script trong container. Sinh topic là route `POST /topics` trên server Claude sẵn có ở host (:7861), phần spawn `claude -p` tách ra `host/imagereview/claude.js` dùng chung với `/review`.

**Tech Stack:** n8n 2.x (Code / IF / HTTP / Execute Command / Webhook / Schedule node), Node 26 + `node:test` trên host, Node trong container, `claude` CLI.

**Spec:** `docs/superpowers/specs/2026-10-10-topic-refill-output-retention-design.md`

## Global Constraints

- Lệnh chạy từ `/Users/sangnguyen/Projects/ad-test/data/workflow`; đường dẫn trong plan tương đối với thư mục đó.
- Nhánh `feat/topic-refill-retention`. Không stage `.DS_Store`. `topics.json` chỉ bị đụng ở Task 4 và Task 5 như mô tả.
- `container/**`: chỉ `node` + builtin (`fs, path, child_process, crypto`), không package ngoài, chỉ ghi trong `/data/workflow`.
- Mọi `throw` trong `container/nodes/**` **không có dấu hai chấm** — dùng ` - `.
- `container/cli/*`: nhận tham số qua `process.argv`, không đọc env, in **một dòng JSON** ra stdout.
- Sửa `container/nodes/**` hoặc `host/workflows/**` → phải `node host/deploy.js daily` mới có hiệu lực.
- Ghi file JSON trạng thái luôn atomic: ghi `<file>.tmp` rồi `fs.renameSync`.
- Ngưỡng / số lượng: `refill.threshold` mặc định **0.9**, `refill.batch` mặc định **30** (kẹp 1..100), `KEEP_RUNS` **10**, `history` cap **200**, `refills` cap **50**, `recent` **30**, độ dài topic hợp lệ **3–12 từ**, `/topics` `count` **1..100**, timeout gọi Claude cho `/topics` **150000 ms**, timeout HTTP node Refill Topics **180000 ms**.
- Dòng đánh dấu cuối `lib/topics.js`: `// --- exports (stripped when embedded) ---` (chính xác từng ký tự).
- Test chạy bằng `node --test <file glob>` (Node 26 cần glob rõ ràng, không truyền thư mục).
- Commit message kết thúc bằng dòng trống rồi `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Comment code tiếng Anh, giải thích *vì sao*, giọng như code xung quanh.
- ⚠ `daily` chạy lúc 07:00 và 19:00 ICT. **Task 4 và Task 5 phải làm liền nhau** trong cùng một khoảng không có lịch chạy: sau Task 4, code cũ trên n8n vẫn đọc `topics.json`.

## File map

| File | Việc |
|---|---|
| `container/nodes/daily/lib/topics.js` | **Mới.** Hàm thuần: chọn topic, tỉ lệ, ghi lượt dùng, merge |
| `container/nodes/daily/lib/topics.test.js` | **Mới** |
| `container/cli/prune_output.js` | **Mới.** Giữ N run mới nhất |
| `container/cli/prune_output.test.js` | **Mới** |
| `host/imagereview/claude.js` | **Mới.** Spawn `claude -p` dùng chung |
| `host/imagereview/topics.js` | **Mới.** Prompt + schema + validate cho `/topics` |
| `host/imagereview/server.js` | Viết lại: dùng `claude.js`, thêm `/topics` |
| `host/migrate-topics.js` | **Mới.** Chuyển đổi một lần |
| `topics/pool.json`, `topics/state.json` | **Mới** (sinh bởi migration); `topics.json` bị xoá |
| `.gitignore` | thêm `topics/state.json` |
| `container/nodes/daily/01_pick_topic.js`, `02_record_run.js` | Viết lại theo pool/state |
| `container/nodes/daily/03_check_topics.js`, `04_merge_topics.js` | **Mới** |
| `host/workflows/daily.js` | Viết lại: 6 node mới, nhúng lib |
| `CLAUDE.md`, `docs.md` | Tài liệu |

---

### Task 1: `lib/topics.js` — logic topic thuần

**Files:**
- Create: `container/nodes/daily/lib/topics.js`
- Test: `container/nodes/daily/lib/topics.test.js`

**Interfaces:**
- Produces (mọi hàm thuần, không I/O):
  - `HISTORY_CAP = 200`, `REFILLS_CAP = 50`
  - `emptyState() => {used: {}, history: [], refills: []}`
  - `normalizeTopic(s: any) => string`
  - `refillSettings(pool) => {threshold: number, batch: number}` — threshold ∈ (0,1] else 0.9; batch nguyên 1..100 else 30
  - `poolTopics(pool) => string[]` — `pool.topics[].topic` là chuỗi khác rỗng, đã trim
  - `pickTopic(topics: string[], used: object, random = Math.random) => {topic: string|null, fresh: number}`
  - `usageRatio(topics: string[], used: object) => number`
  - `recordUse(state, entry: {topic, at, ...}) => state`
  - `addRefill(state, refill) => state`
  - `mergeTopics(pool, candidates: any[], {batch: number, today: string}) => {pool, added: string[], rejected: any[]}`
  - `todayIct(now = Date.now()) => 'YYYY-MM-DD'`

- [ ] **Step 1: Viết test (fail)**

`container/nodes/daily/lib/topics.test.js`:

```js
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
```

- [ ] **Step 2: Chạy, xác nhận fail**

Run: `node --test container/nodes/daily/lib/*.test.js`
Expected: FAIL — `Cannot find module './topics'`.

- [ ] **Step 3: Cài đặt**

`container/nodes/daily/lib/topics.js`:

```js
// Topic bookkeeping for the daily workflow, as pure functions.
//
// Kept out of the Code nodes so the rules can be tested on the host with
// `node --test`: which topic runs next, when the pool counts as used up, and what
// Claude's suggestions must pass before they join the pool. The picker has been
// wrong once already (it ranked by history position the wrong way round and would
// have repeated the last topic forever), which is why this is tested at all.
//
// Code nodes cannot `require` project files, so host/workflows/daily.js prepends
// everything above the exports marker at the bottom to each Code node that needs
// it. Keep this file free of `require` and of top-level side effects.

const HISTORY_CAP = 200;
const REFILLS_CAP = 50;
const DEFAULT_THRESHOLD = 0.9;
const DEFAULT_BATCH = 30;
const MIN_WORDS = 3;
const MAX_WORDS = 12;
const ICT_OFFSET_MS = 7 * 3600_000;

function emptyState() {
  return { used: {}, history: [], refills: [] };
}

/** The comparison key for "is this the same topic": case, punctuation and spacing folded away. */
function normalizeTopic(s) {
  return String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** pool.refill with anything missing or out of range replaced by the defaults. */
function refillSettings(pool) {
  const r = pool?.refill ?? {};
  const threshold = Number(r.threshold);
  const batch = Number(r.batch);
  return {
    threshold: threshold > 0 && threshold <= 1 ? threshold : DEFAULT_THRESHOLD,
    batch: Number.isInteger(batch) && batch >= 1 && batch <= 100 ? batch : DEFAULT_BATCH,
  };
}

/** The topic strings of pool.json, ignoring malformed entries rather than failing on them. */
function poolTopics(pool) {
  return (pool?.topics ?? [])
    .map((t) => (typeof t?.topic === 'string' ? t.topic.trim() : ''))
    .filter(Boolean);
}

/**
 * Least recently used, never-used first.
 *
 * Never-used topics are picked at random among themselves, so a freshly appended
 * batch does not go out as a visibly contiguous block. Once every topic has run,
 * the one with the oldest lastAt goes next; a tie keeps pool order.
 */
function pickTopic(topics, used, random = Math.random) {
  if (!topics.length) return { topic: null, fresh: 0 };
  const fresh = topics.filter((t) => !used?.[t]);
  if (fresh.length) return { topic: fresh[Math.floor(random() * fresh.length)], fresh: fresh.length };

  const at = (t) => Date.parse(used[t]?.lastAt) || 0;
  let best = topics[0];
  for (const t of topics) if (at(t) < at(best)) best = t;
  return { topic: best, fresh: 0 };
}

/**
 * Share of the pool that has run at least once. Topics in `used` that were since
 * deleted from the pool do not count. An empty pool counts as fully used, so it
 * asks for a refill rather than dividing by zero.
 */
function usageRatio(topics, used) {
  if (!topics.length) return 1;
  return topics.filter((t) => used?.[t]).length / topics.length;
}

/** A new state with this run counted against its topic and logged, newest first. */
function recordUse(state, entry) {
  const prev = state.used?.[entry.topic] ?? { count: 0, lastAt: null };
  return {
    ...state,
    used: { ...(state.used ?? {}), [entry.topic]: { count: prev.count + 1, lastAt: entry.at } },
    history: [entry, ...(state.history ?? [])].slice(0, HISTORY_CAP),
  };
}

function addRefill(state, refill) {
  return { ...state, refills: [refill, ...(state.refills ?? [])].slice(0, REFILLS_CAP) };
}

/**
 * Claude's suggestions, filtered and appended to the pool.
 *
 * Claude is told the whole pool and asked not to repeat it, but the code does
 * not take that on trust: anything that normalises to an existing topic, repeats
 * an earlier suggestion, is not 3-12 words, or is not a string at all is
 * rejected. At most `batch` are added.
 */
function mergeTopics(pool, candidates, { batch, today }) {
  const seen = new Set(poolTopics(pool).map(normalizeTopic));
  const added = [];
  const rejected = [];

  for (const c of Array.isArray(candidates) ? candidates : []) {
    if (typeof c !== 'string') {
      rejected.push(c);
      continue;
    }
    const topic = c.trim().replace(/\s+/g, ' ').toLowerCase();
    const key = normalizeTopic(topic);
    const words = key ? key.split(' ').length : 0;
    if (words < MIN_WORDS || words > MAX_WORDS || seen.has(key) || added.length >= batch) {
      rejected.push(c);
      continue;
    }
    seen.add(key);
    added.push(topic);
  }

  return {
    pool: {
      ...pool,
      topics: [...(pool.topics ?? []), ...added.map((topic) => ({ topic, addedAt: today, source: 'claude' }))],
    },
    added,
    rejected,
  };
}

/** The calendar date in Asia/Ho_Chi_Minh, which is the date the channel lives in. */
function todayIct(now = Date.now()) {
  return new Date(now + ICT_OFFSET_MS).toISOString().slice(0, 10);
}

// --- exports (stripped when embedded) ---
module.exports = {
  HISTORY_CAP, REFILLS_CAP, emptyState, normalizeTopic, refillSettings, poolTopics,
  pickTopic, usageRatio, recordUse, addRefill, mergeTopics, todayIct,
};
```

- [ ] **Step 4: Chạy, xác nhận pass**

Run: `node --test container/nodes/daily/lib/*.test.js`
Expected: `# pass 14`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add container/nodes/daily/lib/topics.js container/nodes/daily/lib/topics.test.js
git commit -m "feat(daily): pure topic bookkeeping with tests"
```

---

### Task 2: `prune_output.js` — giữ N run mới nhất

**Files:**
- Create: `container/cli/prune_output.js`
- Test: `container/cli/prune_output.test.js`

**Interfaces:**
- Produces: `node container/cli/prune_output.js <outputDir> <keep>` → stdout `{"kept":number,"removed":[runId...],"files":number}`; exit 1 khi argv sai, còn lại exit 0.

- [ ] **Step 1: Viết test (fail)**

`container/cli/prune_output.test.js`:

```js
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
```

- [ ] **Step 2: Chạy, xác nhận fail**

Run: `node --test container/cli/*.test.js`
Expected: các test fail (`Cannot find module` / status 1 vì script chưa có).

- [ ] **Step 3: Cài đặt**

`container/cli/prune_output.js`:

```js
#!/usr/bin/env node
/**
 * usage: node prune_output.js <outputDir> <keep>
 *
 * Keeps the newest <keep> runs in output/ and deletes every file of the rest.
 *
 * A run is every file whose name starts with its runId (`20261010152936_o87wx7`):
 * the mp4s, the .srt, the record .json, the caption and the cover. Newest is
 * decided by the runId itself, whose prefix is a timestamp, so sorting the
 * strings sorts by time and no mtime is trusted. Anything that does not start
 * with a runId is not ours and is left alone.
 *
 * Runs after the daily build has been published: buffer-publish reads the mp4
 * from output/, and Buffer itself fetches the copy on S3, so nothing needs an
 * older file once that step is done.
 *
 * Cleaning up must never fail the schedule, so a file that will not delete is
 * reported on stderr and the run carries on; only a malformed command line exits
 * non-zero.
 */
const fs = require('fs');
const path = require('path');

const RUN_ID = /^(\d{14}_[a-z0-9]{6})/;

const [dir, keepArg] = process.argv.slice(2);
const keep = Number(keepArg);
if (!dir || !Number.isInteger(keep) || keep < 1) {
  console.error('usage - prune_output.js <outputDir> <keep>, keep a whole number of at least 1');
  process.exit(1);
}

let names = [];
try {
  names = fs.readdirSync(dir);
} catch (err) {
  console.error(`cannot read ${dir} - ${err.message}`);
}

const byRun = new Map();
for (const name of names) {
  const m = RUN_ID.exec(name);
  if (!m) continue;
  if (!byRun.has(m[1])) byRun.set(m[1], []);
  byRun.get(m[1]).push(name);
}

const runs = [...byRun.keys()].sort().reverse();
const removed = runs.slice(keep);
let files = 0;
for (const run of removed) {
  for (const name of byRun.get(run)) {
    try {
      fs.rmSync(path.join(dir, name), { force: true });
      files += 1;
    } catch (err) {
      console.error(`${name} - ${err.message}`);
    }
  }
}

process.stdout.write(JSON.stringify({ kept: Math.min(keep, runs.length), removed, files }));
```

- [ ] **Step 4: Chạy, xác nhận pass**

Run: `node --test container/cli/*.test.js`
Expected: `# pass 4`, `# fail 0`. Đồng thời `node --test container/cli/lib/*.test.js` vẫn `# pass 8`.

- [ ] **Step 5: Kiểm trong container (không xoá gì thật)**

```bash
docker exec shadowing-n8n node /data/workflow/container/cli/prune_output.js /data/workflow/output 50
```

Expected: `{"kept":<số run hiện có>,"removed":[],"files":0}`.

- [ ] **Step 6: Commit**

```bash
git add container/cli/prune_output.js container/cli/prune_output.test.js
git commit -m "feat(cli): prune_output keeps the newest N runs in output/"
```

---

### Task 3: Server Claude — tách `claude.js`, thêm `/topics`

**Files:**
- Create: `host/imagereview/claude.js`
- Create: `host/imagereview/topics.js`
- Modify (viết lại toàn bộ): `host/imagereview/server.js`

**Interfaces:**
- Produces:
  - `claude.js`: `MODEL: string`; `askClaude({systemPrompt: string, schema: object, content: object[], timeoutMs: number}) => Promise<{output: object, ms: number|null}>` — reject khi Claude lỗi / timeout / không có structured output.
  - `topics.js`: `SYSTEM_PROMPT`, `SCHEMA`, `TIMEOUT_MS = 150000`, `badRequest(body) => string|null`, `message(body) => content[]`.
  - `POST /topics` `{existing: string[], recent: string[], count: 1..100}` → 200 `{topics: string[], model, ms}`; 400 body sai; 503 Claude lỗi.
  - `POST /review` và `GET /health`: hành vi **không đổi**.

- [ ] **Step 1: Ghi nhận trạng thái trước (fail)**

Reviewer có thể đang chạy (tiến trình nền của phiên điều phối, hoặc LaunchAgent). Kiểm:

```bash
curl -s localhost:7861/health; echo
curl -s -X POST localhost:7861/topics -H 'Content-Type: application/json' -d '{"existing":["asking about a warranty"],"recent":[],"count":3}'; echo
```

Expected: health `{"ok":true,...}`; `/topics` trả `{"error":"not found"}`.

Nếu health không trả lời: chạy `node host/imagereview/server.js` ở chế độ nền cho các bước sau và tự tắt khi xong task.

- [ ] **Step 2: `host/imagereview/claude.js`**

```js
/**
 * One `claude -p` call with a structured answer, shared by every route of the
 * host server (/review, /topics).
 *
 * The flags are the point of this file, so they are in one place:
 *   - content goes in over stream-json, so images need no tool to be read
 *   - `--tools ""`: the model can answer and do nothing else
 *   - `--json-schema`: the answer is parsed, never scraped out of prose
 *   - its own system prompt and a cwd outside the repo, so neither Claude Code's
 *     default prompt nor this project's CLAUDE.md is paid for on every call
 * `--bare` is not usable: it demands ANTHROPIC_API_KEY and skips the OAuth login
 * this relies on.
 */
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Sonnet over Haiku: judging photos and writing varied, natural topics both
// benefit, and the call is a few seconds either way.
const MODEL = process.env.IMAGEREVIEW_MODEL ?? 'sonnet';
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';

/** Resolves to `{output, ms}` - output is the schema-shaped answer - or rejects. */
function askClaude({ systemPrompt, schema, content, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--tools', '',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--model', MODEL,
      '--system-prompt', systemPrompt,
      '--json-schema', JSON.stringify(schema),
    ], {
      cwd: os.tmpdir(),
      env: { ...process.env, PATH: `${path.join(os.homedir(), '.local', 'bin')}:${process.env.PATH}` },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('claude timed out')); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const result = out.split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .find((m) => m?.type === 'result');
      if (!result || result.is_error || !result.structured_output) {
        reject(new Error(`claude exit ${code}: ${(result?.result ?? err).toString().slice(0, 200)}`));
        return;
      }
      resolve({ output: result.structured_output, ms: result.duration_ms ?? null });
    });

    child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`);
  });
}

module.exports = { MODEL, askClaude };
```

- [ ] **Step 3: `host/imagereview/topics.js`**

```js
/**
 * POST /topics - Claude suggests new conversation topics for the daily video.
 *
 * Called by the daily workflow once 90% of topics/pool.json has been used. It
 * only suggests: the workflow's Merge Topics node filters duplicates and odd
 * lengths again before anything reaches the pool, so a bad answer costs a retry
 * on the next run, never a broken pool.
 */
const TIMEOUT_MS = 150000;
const MAX_COUNT = 100;

const SCHEMA = {
  type: 'object',
  properties: { topics: { type: 'array', items: { type: 'string' } } },
  required: ['topics'],
};

const SYSTEM_PROMPT = `You write topics for a daily English-shadowing video aimed at
Vietnamese learners of spoken English. Each video is a short two-person
conversation about one topic, illustrated with stock photos.

Every topic you write must be:
- ONE concrete everyday situation between two people - a customer and a clerk,
  a patient and a receptionist, two colleagues, a guest and a host.
- English, lowercase, 3 to 10 words, in the same style as the existing list,
  e.g. "asking about a warranty", "ordering breakfast at a small cafe".
- set somewhere a stock photo can show: a cafe, a clinic, an airport, an office,
  a shop counter, a hotel lobby, a bank, a gym. Avoid situations with no visible
  place (phone calls about abstract matters, online chats, feelings).
- useful: something a learner will actually face at work, while travelling, or
  in daily life.

Spread the list across areas - food and drink, travel and transport, work and
office, health, shopping, housing, banking and money, leisure, services and
repairs, school - and lean towards areas the recent topics have not covered.

Never repeat or merely rephrase a topic from the existing list: "returning a
shirt" and "returning a jacket that does not fit" are the same situation.
Return exactly the number of topics asked for, all different from each other.`;

/** Null when the body is usable, otherwise why not. */
function badRequest(body) {
  if (!Array.isArray(body?.existing) || body.existing.some((t) => typeof t !== 'string')) {
    return 'existing must be an array of strings';
  }
  if (body.recent !== undefined && (!Array.isArray(body.recent) || body.recent.some((t) => typeof t !== 'string'))) {
    return 'recent must be an array of strings';
  }
  if (!Number.isInteger(body.count) || body.count < 1 || body.count > MAX_COUNT) {
    return `count must be a whole number from 1 to ${MAX_COUNT}`;
  }
  return null;
}

/** The user turn: what exists, what ran lately, how many to write. */
function message(body) {
  const text = [
    `Existing topics (${body.existing.length}) - do not repeat or rephrase any of these:`,
    ...body.existing.map((t) => `- ${t}`),
    '',
    'Most recent topics, newest first (favour other areas):',
    ...(body.recent ?? []).map((t) => `- ${t}`),
    '',
    `Write ${body.count} new topics.`,
  ].join('\n');
  return [{ type: 'text', text }];
}

module.exports = { SCHEMA, SYSTEM_PROMPT, TIMEOUT_MS, badRequest, message };
```

- [ ] **Step 4: Viết lại `host/imagereview/server.js`**

Thay toàn bộ nội dung (giữ nguyên `SCHEMA`, `SYSTEM_PROMPT`, `reviewMessage` logic của `/review`; chỉ đổi cách gọi Claude và thêm route):

```js
#!/usr/bin/env node
/**
 * Claude on the host, for the parts of the pipeline the n8n container cannot do
 * itself (the hardened image has no `claude` and cannot get one).
 *
 *   node host/imagereview/server.js        # :7861, loopback only
 *
 *   GET  /health
 *   POST /review   { kind, topic, line, dialogue, images: [{ id, mediaType, data }] }
 *               -> { required, scores: [{ id, present, missing, issues, score }], model, ms }
 *   POST /topics   { existing, recent, count }
 *               -> { topics, model, ms }                       (see topics.js)
 *
 * /review: a stock search matches keywords, not the line. A search for the syrup
 * in a coffee order finds syrup on pancakes, and nothing in the pipeline can tell
 * - every pixel decodes fine. Claude can tell, so fetch_scenes.js sends the
 * candidates here and keeps the best one at or above its pass score.
 *
 * This server only SCORES. The bar (72 by default) is applied in fetch_scenes.js,
 * so moving it never means touching the prompt. Up to four candidates go in one
 * call: seeing them side by side keeps the numbers consistent with each other, and
 * it is a quarter of the calls. `node host/imagereview/check.js` re-checks the
 * scale against a fixed fixture after any prompt or model change.
 *
 * How Claude is called lives in claude.js, shared by both routes.
 *
 * Bound to 127.0.0.1, not 0.0.0.0: Docker Desktop still routes
 * host.docker.internal to it (verified from inside shadowing-n8n), and nothing on
 * the LAN can spend your Claude usage.
 *
 * Down, slow or rate-limited, a route answers 503 and the caller carries on
 * without it: an unreviewed scene, or no new topics until the next run. Claude
 * improves the output; it must never cost a video.
 */
const http = require('http');
const { MODEL, askClaude } = require('./claude');
const topics = require('./topics');

const PORT = Number(process.env.IMAGEREVIEW_PORT ?? 7861);
// Four images per call instead of one, so more than the single-image 90 s.
const CALL_TIMEOUT_MS = 120000;
// Scenes are reviewed while other scenes download, so two is enough to keep up,
// and more would only spend usage faster. Shared by every route.
const MAX_CONCURRENT = 2;
const MAX_IMAGES = 4;
// Four 768 px thumbnails are ~1 MB of base64; this is headroom, not a target.
const MAX_BODY = 16 * 1024 * 1024;

const SCHEMA = {
  type: 'object',
  properties: {
    required: { type: 'array', items: { type: 'string' } },
    scores: {
      type: 'array',
      items: {
        type: 'object',
        // present/missing/issues come before score so the number is written after
        // the reasons for it, not before.
        properties: {
          id: { type: 'string' },
          present: { type: 'array', items: { type: 'string' } },
          missing: { type: 'array', items: { type: 'string' } },
          issues: { type: 'array', items: { type: 'string' } },
          score: { type: 'integer', minimum: 0, maximum: 100 },
        },
        required: ['id', 'present', 'missing', 'issues', 'score'],
      },
    },
  },
  required: ['required', 'scores'],
};

const SYSTEM_PROMPT = `You are the picture editor for a short English-shadowing video.
Each scene is a stock PHOTO illustrating ONE line of dialogue. You are shown up to
four candidate photos, each introduced by a label ("Candidate c1:" and so on), and
you score every one of them.

1. required: what the line makes the viewer expect to SEE. Only two kinds:
   - the SETTING the topic or line puts it in (an office, a cafe, a street, a
     kitchen). "company", "work", "the team" mean an office.
   - objects the line NAMES - "laptop", "menu", "passport", "syrup". At most two.
     Never objects you infer: a price does not require a cash register, "cards
     are fine" does not require a payment terminal.
   A part of something stands for the whole: "the battery" or "the screen" of a
   laptop requires the laptop, not a visible battery or screen.
   Name each item plainly, without the line's adjectives: "coffee cup", not
   "large iced latte in a clear cup". Skip what cannot be pictured: times,
   feelings, abstract nouns (deadline, problem, tomorrow).
   required depends on the line only, so it is the same for every candidate.
2. For each candidate, present / missing: check each required item against that
   photo. An object is present if a viewer would recognise it at a glance on a
   phone. The setting is present when the place clearly reads as that kind of
   place - one convincing cue is enough (a counter with cups or an espresso
   machine makes a cafe; desks with monitors make an office).
3. For each candidate, issues: anything that would embarrass the channel or fight
   the subtitles - a watermark, a prominent brand logo, large text across the
   frame, an obviously staged studio shot (white seamless backdrop, people
   grinning and pointing at a screen), a collage, an illustration instead of a
   photo.
4. For each candidate, score 0-100 against these anchors:
   90-100  the setting is right, every named object is clearly there, and what
           is happening matches the line
   72-89   the setting and the main named object are right; a secondary detail
           is missing or the action only roughly matches
   50-71   the setting is right but the main named object is missing, or the
           object is there in the wrong setting
   20-49   only loosely about the topic
   0-19    unrelated, broken, or dominated by text, a logo or a watermark
   Then subtract for issues: up to 15 for a staged look or a small logo, more for
   anything that dominates the frame. Stay within 0-100.
   The people in a stock photo are strangers. Never score their looks, gender,
   age or how many there are - only whether what they are doing fits the line.
   Score each candidate on the anchors, not by ranking it against the others; use
   the others only to keep your numbers consistent.
5. Return exactly one entry in scores for EVERY candidate id you were shown.`;

/** The /review user content: each labelled candidate, then everything needed to judge them. */
function reviewContent(req) {
  const lines = (req.dialogue ?? []).map((d) =>
    `${d.idx === req.line?.idx ? '>>' : '  '}${d.idx} ${d.speaker}: ${d.en}`);
  const context = req.kind === 'cover'
    ? [
      `Topic: ${req.topic}`,
      'These photos are candidates for the BACKDROP of the title card: a wide shot of',
      'the place the conversation happens in. The only required item is the setting.',
      'The channel name and topic are printed across the middle, so add up to 10 when',
      'the centre of the frame is calm and uncluttered, and subtract up to 20 when a',
      'person fills the centre.',
    ]
    : [
      `Topic: ${req.topic}`,
      'Dialogue (the scene illustrates the line marked >>):',
      ...lines,
      `Line being illustrated: "${req.line?.en}"`,
      req.line?.vi ? `Its meaning in Vietnamese: "${req.line.vi}"` : null,
    ];

  const content = [];
  for (const img of req.images) {
    content.push({ type: 'text', text: `Candidate ${img.id}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType ?? 'image/jpeg', data: img.data } });
  }
  content.push({
    type: 'text',
    text: [...context, `Score these candidates: ${req.images.map((i) => i.id).join(', ')}`]
      .filter(Boolean).join('\n'),
  });
  return content;
}

/** Null when the batch is well-formed, otherwise the reason it is not. */
function badImages(images) {
  if (!Array.isArray(images) || !images.length || images.length > MAX_IMAGES) {
    return `images must be an array of 1 to ${MAX_IMAGES}`;
  }
  if (images.some((i) => !i?.id || !i?.data)) return 'every image needs an id and base64 data';
  if (new Set(images.map((i) => i.id)).size !== images.length) return 'image ids must be unique';
  return null;
}

async function review(body) {
  const { output, ms } = await askClaude({
    systemPrompt: SYSTEM_PROMPT, schema: SCHEMA, content: reviewContent(body), timeoutMs: CALL_TIMEOUT_MS,
  });
  // A batch with a candidate left unscored is unusable: the caller cannot tell a
  // skipped photo from a bad one.
  const got = new Set((output.scores ?? []).map((s) => s.id));
  const lost = body.images.map((i) => i.id).filter((id) => !got.has(id));
  if (lost.length) throw new Error(`no score for ${lost.join(', ')}`);
  return { ...output, model: MODEL, ms };
}

async function suggestTopics(body) {
  const { output, ms } = await askClaude({
    systemPrompt: topics.SYSTEM_PROMPT, schema: topics.SCHEMA,
    content: topics.message(body), timeoutMs: topics.TIMEOUT_MS,
  });
  return { topics: output.topics ?? [], model: MODEL, ms };
}

const ROUTES = {
  '/review': {
    bad: (body) => badImages(body.images),
    run: review,
    log: (body, out) => `${body.kind ?? 'scene'} ${body.line?.idx ?? ''} `
      + `${out.scores.map((s) => `${s.id}=${s.score}`).join(' ')}`,
  },
  '/topics': {
    bad: topics.badRequest,
    run: suggestTopics,
    log: (body, out) => `topics asked=${body.count} got=${out.topics.length}`,
  },
};

// A plain counting semaphore: callers past the limit wait their turn.
let active = 0;
const waiting = [];
async function withSlot(fn) {
  if (active >= MAX_CONCURRENT) await new Promise((r) => waiting.push(r));
  active += 1;
  try {
    return await fn();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    send(res, 200, { ok: true, model: MODEL, active, waiting: waiting.length });
    return;
  }
  const route = req.method === 'POST' ? ROUTES[req.url] : null;
  if (!route) {
    send(res, 404, { error: 'not found' });
    return;
  }

  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) req.destroy();
    else chunks.push(c);
  });
  req.on('end', async () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      send(res, 400, { error: 'body is not JSON' });
      return;
    }
    const bad = route.bad(body);
    if (bad) {
      send(res, 400, { error: bad });
      return;
    }
    const started = Date.now();
    try {
      const out = await withSlot(() => route.run(body));
      console.log(`[imagereview] ${((Date.now() - started) / 1000).toFixed(1)}s ${req.url} ${route.log(body, out)}`);
      send(res, 200, out);
    } catch (e) {
      console.log(`[imagereview] ${req.url} error: ${e.message}`);
      send(res, 503, { error: e.message });
    }
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[imagereview] listening on 127.0.0.1:${PORT}, model ${MODEL}`);
});
```

Kiểm:

```bash
node --check host/imagereview/server.js && echo SYNTAX_OK
rtk proxy grep -c "You are the picture editor" host/imagereview/server.js
```

Expected: `SYNTAX_OK`, `1`.

- [ ] **Step 5: Khởi động lại server và kiểm `/review` không đổi**

Server đang chạy dùng code cũ. Tìm và khởi động lại (KHÔNG dùng `launchctl` nếu LaunchAgent chưa cài):

```bash
lsof -tiTCP:7861 -sTCP:LISTEN
```

- Nếu tiến trình thuộc LaunchAgent (`launchctl list | grep imagereview` có dòng): `launchctl kickstart -k gui/$(id -u)/com.shawnspace.imagereview`.
- Nếu không: báo người điều phối PID đó để họ khởi động lại — **không tự kill** tiến trình của phiên khác. Trong lúc chờ, chạy bản mới trên cổng tạm để kiểm: `IMAGEREVIEW_PORT=7862 node host/imagereview/server.js` (nền) và dùng `IMAGEREVIEW_PORT=7862` cho các lệnh dưới.

```bash
IMAGEREVIEW_PORT=${PORT:-7861} node host/imagereview/check.js; echo "check exit=$?"
```

Expected: 4 dòng `ok`, `check exit=0`.

- [ ] **Step 6: Kiểm `/topics`**

```bash
P=${PORT:-7861}
curl -s -X POST localhost:$P/topics -H 'Content-Type: application/json' -d '{"existing":[],"count":3}'; echo
curl -s -X POST localhost:$P/topics -H 'Content-Type: application/json' -d '{"existing":["asking about a warranty"],"count":0}'; echo
curl -s -X POST localhost:$P/topics -H 'Content-Type: application/json' \
  -d '{"existing":["asking about a warranty","ordering breakfast at a small cafe","asking for directions to the train station","checking in at a hotel","booking a dentist appointment"],"recent":["asking about a warranty"],"count":5}' \
  | node -e 'const o=JSON.parse(require("fs").readFileSync(0));console.log(o.topics.length,o.model,o.ms);o.topics.forEach(t=>console.log(" -",t))'
```

Expected:
- dòng 1: 5–10 topic hoặc lỗi đều được (pool rỗng là hợp lệ) — chỉ cần không phải 400.
- dòng 2: `{"error":"count must be a whole number from 1 to 100"}`.
- khối 3: `5 sonnet <ms>` rồi 5 topic chữ thường, 3–10 từ, không trùng 5 topic đưa vào.

Tắt server cổng tạm nếu đã mở ở Step 5.

- [ ] **Step 7: Commit**

```bash
git add host/imagereview/claude.js host/imagereview/topics.js host/imagereview/server.js
git commit -m "feat(imagereview): share the claude call, add POST /topics"
```

---

### Task 4: Migration `topics.json` → `topics/pool.json` + `topics/state.json`

**Files:**
- Create: `host/migrate-topics.js`
- Create (sinh ra): `topics/pool.json`, `topics/state.json`
- Modify: `.gitignore`
- Delete: `topics.json` (ở Task 5, **sau** deploy — xem Step 6)

**Interfaces:**
- Consumes: không.
- Produces: `topics/pool.json` theo spec 3.1, `topics/state.json` theo spec 3.2.

- [ ] **Step 1: Viết script**

`host/migrate-topics.js`:

```js
#!/usr/bin/env node
/**
 * One-off: splits topics.json into topics/pool.json and topics/state.json.
 *
 *   node host/migrate-topics.js            # this project's data/workflow
 *   node host/migrate-topics.js <dir>      # any directory holding a topics.json
 *
 * pool.json is the list people (and Claude) add to and lives in git; state.json
 * is what the daily workflow writes on every run and is gitignored, so two runs
 * a day stop showing up as changes. See the topic-refill spec for the shapes.
 *
 * Refuses to run if either output already exists, so it cannot clobber state
 * that the workflow has been writing since.
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./lib/config');

const dir = path.resolve(process.argv[2] ?? ROOT);
const src = path.join(dir, 'topics.json');
const outDir = path.join(dir, 'topics');
const poolFile = path.join(outDir, 'pool.json');
const stateFile = path.join(outDir, 'state.json');

for (const f of [poolFile, stateFile]) {
  if (fs.existsSync(f)) {
    console.error(`${f} already exists - not migrating twice`);
    process.exit(1);
  }
}

const old = JSON.parse(fs.readFileSync(src, 'utf8'));
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

const seen = new Set();
const topics = [];
for (const t of old.pool ?? []) {
  if (typeof t !== 'string' || !t.trim() || seen.has(t.trim())) continue;
  seen.add(t.trim());
  topics.push({ topic: t.trim(), addedAt: today, source: 'manual' });
}

const history = (old.history ?? []).map((h) => ({ ...h, dryRun: false }));
const used = {};
// Oldest first, so the newest `at` is the one left in lastAt.
for (const h of [...history].reverse()) {
  if (!h.topic) continue;
  const prev = used[h.topic] ?? { count: 0, lastAt: null };
  used[h.topic] = { count: prev.count + 1, lastAt: h.at ?? prev.lastAt };
}

const pool = {
  _comment: 'Topic pool for the daily run. Edit freely. Claude appends to `topics` when most of it has been used; review its additions in git diff.',
  refill: { threshold: 0.9, batch: 30 },
  topics,
};
const state = { used, history, refills: [] };

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(poolFile, `${JSON.stringify(pool, null, 2)}\n`, 'utf8');
fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  topics: topics.length,
  history: history.length,
  used: Object.keys(used).length,
  pool: path.relative(process.cwd(), poolFile),
  state: path.relative(process.cwd(), stateFile),
}));
```

- [ ] **Step 2: Chạy thử trên bản sao (test)**

```bash
T=work/_migrate_test && rm -rf $T && mkdir -p $T && cp topics.json $T/
node -e 'const t=JSON.parse(require("fs").readFileSync("topics.json"));const c={};t.history.forEach(h=>c[h.topic]=(c[h.topic]||0)+1);console.log("expect", JSON.stringify({topics:new Set(t.pool).size,history:t.history.length,used:Object.keys(c).length}))'
node host/migrate-topics.js $T
node host/migrate-topics.js $T; echo "second run exit=$?"
node -e '
const s=JSON.parse(require("fs").readFileSync(process.argv[1]+"/topics/state.json"));
const h=s.history; const c={}; h.forEach(x=>c[x.topic]=(c[x.topic]||0)+1);
const bad=Object.entries(c).filter(([k,v])=>s.used[k].count!==v);
console.log("counts match", bad.length===0, "dryRun false everywhere", h.every(x=>x.dryRun===false));
' $T
rm -rf $T
```

Expected:
- dòng `expect {...}` và dòng JSON của lần chạy đầu có cùng `topics`, `history`, `used`.
- `already exists - not migrating twice` rồi `second run exit=1`.
- `counts match true dryRun false everywhere true`.

- [ ] **Step 3: Chạy thật**

```bash
node host/migrate-topics.js
ls topics/
```

Expected: JSON tóm tắt; `pool.json  state.json`.

- [ ] **Step 4: `.gitignore`**

Thêm vào cuối `.gitignore`:

```
# written by the daily workflow on every run; topics/pool.json is the part to edit
topics/state.json
```

Kiểm: `git check-ignore -v topics/state.json` → in dòng khớp; `git check-ignore topics/pool.json; echo $?` → `1`.

- [ ] **Step 5: Commit (giữ `topics.json` tới sau deploy)**

```bash
git add host/migrate-topics.js topics/pool.json .gitignore
git commit -m "feat(topics): split topics.json into pool.json (git) and state.json (ignored)"
```

- [ ] **Step 6: Ghi chú cho Task 5**

`topics.json` vẫn còn trên đĩa và trong git — code `daily` đang chạy trên n8n vẫn đọc nó cho tới khi Task 5 deploy. Task 5 xoá nó sau khi deploy. Không để qua 07:00 / 19:00 ICT giữa hai task.

---

### Task 5: Workflow `daily` — node mới, nhúng lib, deploy, chạy thử

**Files:**
- Modify (viết lại toàn bộ): `container/nodes/daily/01_pick_topic.js`, `container/nodes/daily/02_record_run.js`
- Create: `container/nodes/daily/03_check_topics.js`, `container/nodes/daily/04_merge_topics.js`
- Modify (viết lại toàn bộ): `host/workflows/daily.js`
- Delete: `topics.json`

**Interfaces:**
- Consumes: mọi hàm của `lib/topics.js` (Task 1) làm **global** trong Code node (nhúng lúc deploy); `prune_output.js` (Task 2); `POST /topics` (Task 3); `topics/pool.json`, `topics/state.json` (Task 4).
- Produces: workflow `Daily Shadowing Video` với webhook `POST /webhook/daily-dry-run`.

- [ ] **Step 1: `01_pick_topic.js`**

Thay toàn bộ:

```js
// Chooses the topic for this run and the time its video should go out.
//
// pickTopic, poolTopics and emptyState come from lib/topics.js, which
// host/workflows/daily.js prepends to this node at deploy time.
//
// Least recently used, not random: random repeats itself far sooner than people
// expect, and a learning channel that posts the same situation twice in a week
// looks abandoned. topics/pool.json can be edited at any time without touching
// this file; topics/state.json records what has run.
const fs = require('fs');
const POOL = '/data/workflow/topics/pool.json';
const STATE = '/data/workflow/topics/state.json';

// The slots a video can be scheduled into, in ICT. Two a day.
const POST_HOURS = [8, 20];
const ICT_OFFSET_HOURS = 7;

const topics = poolTopics(JSON.parse(fs.readFileSync(POOL, 'utf8')));
if (!topics.length) throw new Error('topics/pool.json has no topics');

let state = emptyState();
try {
  state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
} catch (err) {
  // Missing on a fresh checkout; unreadable means every topic looks unused for
  // one cycle, which is a repeat, not a failure.
  if (err.code !== 'ENOENT') console.log(`[daily] state.json unreadable, treating as empty - ${err.message}`);
}

const { topic, fresh } = pickTopic(topics, state.used ?? {});

// Only the dry-run webhook delivers a `body`; the schedule trigger does not. A
// dry run builds and records but never reaches Buffer - see the Built? node.
const dryRun = $input.first().json.body !== undefined;

// ----------------------------------------------------------------- when ----
// Aim at the next slot that has not already passed. The build runs about an
// hour ahead of its slot, but a late or retried build must not hand Buffer a
// time in the past, so the slot is chosen from the clock rather than from which
// schedule trigger happened to fire.
const SAFETY_MS = 5 * 60_000;
const nowIct = new Date(Date.now() + ICT_OFFSET_HOURS * 3600_000);

const slotFor = (hour, dayOffset) => new Date(Date.UTC(
  nowIct.getUTCFullYear(), nowIct.getUTCMonth(), nowIct.getUTCDate() + dayOffset,
  hour - ICT_OFFSET_HOURS, 0, 0,
));

const dueAt = [...POST_HOURS.map((h) => slotFor(h, 0)), slotFor(POST_HOURS[0], 1)]
  .find((d) => d.getTime() >= Date.now() + SAFETY_MS);

const slotIct = new Date(dueAt.getTime() + ICT_OFFSET_HOURS * 3600_000);
const pad = (n) => String(n).padStart(2, '0');

return [{
  json: {
    topic,
    dryRun,
    dueAt: dueAt.toISOString(),
    postsAtIct: `${slotIct.getUTCFullYear()}-${pad(slotIct.getUTCMonth() + 1)}-${pad(slotIct.getUTCDate())}`
      + ` ${pad(slotIct.getUTCHours())}:00 ICT`,
    poolSize: topics.length,
    // How many topics have never run. While this is large the pool is still
    // being worked through for the first time.
    freshCandidates: fresh,
  },
}];
```

- [ ] **Step 2: `02_record_run.js`**

Thay toàn bộ:

```js
// Writes this run into topics/state.json and shapes a one-line summary.
//
// recordUse and emptyState come from lib/topics.js, prepended at deploy time.
//
// The run counts against its topic whether or not publishing succeeded - a topic
// whose video was built has been spent either way, and repeating it tomorrow
// because Buffer was down would be the wrong recovery. A dry run counts too: its
// video was built.
const fs = require('fs');
const STATE = '/data/workflow/topics/state.json';

const picked = $('Pick Topic').first().json;
const built = $('Build Video').first().json;
const node = $input.first().json;

// Both sub-calls are HTTP requests set to continue on error, so a failure shows
// up as an `error` on the item rather than killing the schedule. A dry run never
// called Buffer, so whatever arrived here is the build, not a publish result.
let published;
if (picked.dryRun) published = { ok: false, error: 'dry run' };
else if (node.error) published = { ok: false, error: String(node.error.message ?? node.error).slice(0, 300) };
else published = node;

const entry = {
  topic: picked.topic,
  runId: built?.runId ?? null,
  at: new Date().toISOString(),
  postsAt: picked.dueAt,
  published: published.ok === true,
  postId: published.postId ?? null,
  error: published.ok === true ? null : (published.error ?? 'unknown'),
  dryRun: picked.dryRun === true,
};

try {
  let state = emptyState();
  try {
    state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.log(`[daily] state.json unreadable, starting it again - ${err.message}`);
  }
  const tmp = `${STATE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(recordUse(state, entry), null, 2), 'utf8');
  fs.renameSync(tmp, STATE);
} catch (err) {
  console.log(`[daily] could not record the run - ${err.message}`);
}

return [{
  json: {
    ok: entry.published,
    dryRun: entry.dryRun,
    topic: entry.topic,
    runId: entry.runId,
    video: built?.video ?? null,
    postsAt: picked.postsAtIct,
    postId: entry.postId,
    error: entry.error,
  },
}];
```

- [ ] **Step 3: `03_check_topics.js`**

```js
// Decides whether the pool is running low enough to ask Claude for more.
//
// poolTopics, refillSettings, usageRatio and emptyState come from lib/topics.js,
// prepended at deploy time.
//
// "Low" is the share of pool topics that have run at least once, against
// pool.json's refill.threshold (0.9 by default). Refilling before the pool is
// used up means the channel never has to repeat a topic.
const fs = require('fs');
const POOL = '/data/workflow/topics/pool.json';
const STATE = '/data/workflow/topics/state.json';
const RECENT = 30;

const pool = JSON.parse(fs.readFileSync(POOL, 'utf8'));
let state = emptyState();
try {
  state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
} catch {
  state = emptyState();
}

const topics = poolTopics(pool);
const { threshold, batch } = refillSettings(pool);
const ratio = usageRatio(topics, state.used ?? {});
const recent = [...new Set((state.history ?? []).map((h) => h.topic).filter(Boolean))].slice(0, RECENT);

return [{
  json: {
    need: ratio >= threshold,
    ratio: Math.round(ratio * 1000) / 1000,
    threshold,
    batch,
    poolSize: topics.length,
    existing: topics,
    recent,
  },
}];
```

- [ ] **Step 4: `04_merge_topics.js`**

```js
// Adds Claude's suggested topics to topics/pool.json and logs the attempt.
//
// mergeTopics, addRefill, todayIct and emptyState come from lib/topics.js,
// prepended at deploy time.
//
// The HTTP node before this continues on error, so a reviewer that is down or
// slow arrives here as `{error}`. Then the pool is left alone and the failure is
// logged in state.refills; the next run still finds the pool low and asks again.
const fs = require('fs');
const POOL = '/data/workflow/topics/pool.json';
const STATE = '/data/workflow/topics/state.json';

const check = $('Check Topics').first().json;
const res = $input.first().json;

const writeJson = (file, data) => {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
};

// Read again rather than trusting Check Topics' copy: someone may have edited
// the pool while Claude was thinking.
const pool = JSON.parse(fs.readFileSync(POOL, 'utf8'));
const before = (pool.topics ?? []).length;

let refill;
let added = [];
if (res.error || !Array.isArray(res.topics)) {
  const why = res.error?.message ?? res.error ?? 'no topics in the response';
  refill = { at: new Date().toISOString(), before, added: 0, rejected: 0, error: String(why).slice(0, 300) };
} else {
  const merged = mergeTopics(pool, res.topics, { batch: check.batch, today: todayIct() });
  if (merged.added.length) writeJson(POOL, merged.pool);
  added = merged.added;
  refill = { at: new Date().toISOString(), before, added: added.length, rejected: merged.rejected.length, error: null };
}

try {
  let state = emptyState();
  try {
    state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    state = emptyState();
  }
  writeJson(STATE, addRefill(state, refill));
} catch (err) {
  console.log(`[daily] could not log the refill - ${err.message}`);
}

return [{ json: { ...refill, ratioBefore: check.ratio, addedTopics: added } }];
```

- [ ] **Step 5: Kiểm cú pháp node đã nhúng lib (fail trước khi có `daily.js` mới)**

```bash
node -e '
const fs=require("fs");
const lib=fs.readFileSync("container/nodes/daily/lib/topics.js","utf8");
const cut=lib.indexOf("// --- exports (stripped when embedded) ---");
if(cut<0) throw new Error("marker missing");
for (const f of ["01_pick_topic.js","02_record_run.js","03_check_topics.js","04_merge_topics.js"]) {
  new Function(lib.slice(0,cut)+"\n"+fs.readFileSync("container/nodes/daily/"+f,"utf8"));
  console.log("ok", f);
}'
```

Expected: 4 dòng `ok`.

- [ ] **Step 6: `host/workflows/daily.js`**

Thay toàn bộ:

```js
/**
 * Two videos a day, posted to TikTok at 08:00 and 20:00 Asia/Ho_Chi_Minh.
 *
 * Builds an hour ahead of each slot and hands Buffer the slot as an explicit
 * `dueAt`. The hour of slack is deliberate: a build takes about 100 seconds when
 * everything behaves, but it reaches out to Groq, the stock-photo search, Claude
 * and S3, and any of those can be slow. Posting is handed to Buffer with an
 * explicit `dueAt`, so even a build that overruns still goes out on time.
 *
 * It drives the two existing webhooks rather than duplicating their nodes. Those
 * endpoints are the ones that have been exercised by hand all along; a scheduled
 * run that takes a different path through the code would be a second thing to
 * trust.
 *
 * After the post is handed over it housekeeps: output/ is pruned to the newest
 * KEEP_RUNS runs, and once most of topics/pool.json has been used Claude (on the
 * host, :7861/topics) is asked for more topics. Both come after publishing on
 * purpose - neither may hold up a post.
 *
 * POST /webhook/daily-dry-run runs the whole chain except Buffer. It takes no
 * parameters and cannot publish, so exposing it adds no way to post.
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../lib/config');

const NODES_DIR = path.join(ROOT, 'container', 'nodes', 'daily');
const nodeCode = (file) => fs.readFileSync(path.join(NODES_DIR, file), 'utf8');

// Code nodes cannot `require` project files, so the tested topic functions are
// prepended to each node that uses them. Everything from the marker down is the
// `module.exports` the host-side tests need and a Code node must not see.
const EXPORTS_MARKER = '// --- exports (stripped when embedded) ---';
function nodeCodeWithLib(file) {
  const lib = nodeCode(path.join('lib', 'topics.js'));
  const cut = lib.indexOf(EXPORTS_MARKER);
  if (cut < 0) throw new Error('container/nodes/daily/lib/topics.js has lost its exports marker');
  return `${lib.slice(0, cut)}\n// ---- ${file} ----\n${nodeCode(file)}`;
}

// Local, because n8n is calling its own webhooks from inside the same container.
const SELF = 'http://localhost:5678/webhook';
const IN_CONTAINER = '/data/workflow';

// One build per slot, each an hour before it. The slots themselves live in
// container/nodes/daily/01_pick_topic.js (POST_HOURS) because that is what
// computes `dueAt`; change them together.
const BUILD_HOURS_ICT = [7, 19];

// How many runs output/ keeps. Older ones are deleted after each scheduled build.
const KEEP_RUNS = 10;

const CHAIN = ['Twice Daily', 'Pick Topic', 'Build Video', 'Built?', 'Publish To Buffer',
  'Record Run', 'Prune Output', 'Check Topics', 'Topics Low?', 'Refill Topics', 'Merge Topics'];
const to = (node) => [{ node, type: 'main', index: 0 }];

const CONNECTIONS = {
  'Twice Daily': { main: [to('Pick Topic')] },
  'Dry Run Hook': { main: [to('Pick Topic')] },
  'Pick Topic': { main: [to('Build Video')] },
  'Build Video': { main: [to('Built?')] },
  // A failed build must not reach Buffer: posting nothing is better than posting
  // a half-made video, and the history entry still records the attempt. A dry
  // run takes the same branch.
  'Built?': { main: [to('Publish To Buffer'), to('Record Run')] },
  'Publish To Buffer': { main: [to('Record Run')] },
  'Record Run': { main: [to('Prune Output')] },
  'Prune Output': { main: [to('Check Topics')] },
  'Check Topics': { main: [to('Topics Low?')] },
  // False goes nowhere: most runs end here.
  'Topics Low?': { main: [to('Refill Topics'), []] },
  'Refill Topics': { main: [to('Merge Topics')] },
};

const ifTrue = (id, expression) => ({
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [{
      id,
      leftValue: expression,
      rightValue: true,
      operator: { type: 'boolean', operation: 'true', singleValue: true },
    }],
    combinator: 'and',
  },
  looseTypeValidation: true,
  options: {},
});

function definition() {
  const at = (name) => [-560 + CHAIN.indexOf(name) * 210, 0];

  const nodes = [
    {
      id: 'dy-cron',
      name: 'Twice Daily',
      type: 'n8n-nodes-base.scheduleTrigger',
      typeVersion: 1.2,
      position: at('Twice Daily'),
      // The workflow's own timezone setting is Asia/Ho_Chi_Minh, so this hour is
      // local and does not drift with daylight saving anywhere else.
      parameters: {
        rule: {
          interval: BUILD_HOURS_ICT.map((hour) => ({
            field: 'days', daysInterval: 1, triggerAtHour: hour, triggerAtMinute: 0,
          })),
        },
      },
    },
    {
      id: 'dy-dryrun',
      name: 'Dry Run Hook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2.1,
      position: [at('Twice Daily')[0], 200],
      webhookId: 'c3e9a1d2-7f40-4b6e-9a18-5d2c0b7e4f61',
      // Answers at once: the build behind it takes minutes. Watch the run with
      // `node host/inspect-execution.js`.
      parameters: { httpMethod: 'POST', path: 'daily-dry-run', responseMode: 'onReceived', options: {} },
    },
    {
      id: 'dy-topic',
      name: 'Pick Topic',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: at('Pick Topic'),
      parameters: { mode: 'runOnceForAllItems', jsCode: nodeCodeWithLib('01_pick_topic.js') },
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
        // Generous: Groq, a stock search and Claude review per scene, and two
        // encodes. A hundred seconds is normal, so this is about five times that.
        options: { timeout: 540000 },
      },
    },
    {
      id: 'dy-built',
      name: 'Built?',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: at('Built?'),
      parameters: ifTrue('has-run',
        "={{ $json.ok === true && !!$json.runId && $('Pick Topic').first().json.dryRun !== true }}"),
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
        // the post lands on the slot, and `addToQueue` would put it wherever
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
      parameters: { mode: 'runOnceForAllItems', jsCode: nodeCodeWithLib('02_record_run.js') },
    },
    {
      id: 'dy-prune',
      name: 'Prune Output',
      type: 'n8n-nodes-base.executeCommand',
      typeVersion: 1,
      position: at('Prune Output'),
      parameters: {
        executeOnce: true,
        command: `node ${IN_CONTAINER}/container/cli/prune_output.js ${IN_CONTAINER}/output ${KEEP_RUNS}`,
      },
    },
    {
      id: 'dy-check-topics',
      name: 'Check Topics',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: at('Check Topics'),
      parameters: { mode: 'runOnceForAllItems', jsCode: nodeCodeWithLib('03_check_topics.js') },
    },
    {
      id: 'dy-topics-low',
      name: 'Topics Low?',
      type: 'n8n-nodes-base.if',
      typeVersion: 2.2,
      position: at('Topics Low?'),
      parameters: ifTrue('need-refill', '={{ $json.need === true }}'),
    },
    {
      id: 'dy-refill',
      name: 'Refill Topics',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.5,
      position: at('Refill Topics'),
      // Claude being down only delays the refill to the next run; Merge Topics
      // logs the error.
      onError: 'continueRegularOutput',
      parameters: {
        method: 'POST',
        url: 'http://host.docker.internal:7861/topics',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify({ existing: $json.existing, recent: $json.recent, count: $json.batch }) }}',
        options: { timeout: 180000 },
      },
    },
    {
      id: 'dy-merge-topics',
      name: 'Merge Topics',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: at('Merge Topics'),
      parameters: { mode: 'runOnceForAllItems', jsCode: nodeCodeWithLib('04_merge_topics.js') },
    },
  ];

  return {
    name: 'Daily Shadowing Video',
    slug: 'daily',
    webhookPath: 'daily-dry-run',
    nodes,
    connections: CONNECTIONS,
    settings: { executionOrder: 'v1', saveManualExecutions: true, timezone: 'Asia/Ho_Chi_Minh' },
  };
}

module.exports = { definition, CHAIN };
```

Kiểm definition offline:

```bash
node -e '
const d=require("./host/workflows/daily").definition();
const names=new Set(d.nodes.map(n=>n.name));
const dangling=Object.entries(d.connections).flatMap(([f,c])=>[f,...c.main.flat().map(x=>x.node)]).filter(n=>!names.has(n));
console.log("nodes",d.nodes.length,"dangling",JSON.stringify(dangling));
for (const n of d.nodes.filter(n=>n.type.endsWith(".code"))) { new Function(n.parameters.jsCode); if (/module\.exports/.test(n.parameters.jsCode)) throw new Error(n.name+" still has module.exports"); }
console.log("code nodes ok");'
```

Expected: `nodes 12 dangling []`, `code nodes ok`.

- [ ] **Step 7: Deploy, rồi xoá `topics.json`**

```bash
node host/deploy.js daily 2>&1 | tail -8
git rm -q topics.json
ls topics.json 2>&1 | head -1
```

Expected: `"workflow": "daily"`, `"action": "updated"`, `"webhook": "http://localhost:5678/webhook/daily-dry-run"`; sau đó `No such file or directory`.

- [ ] **Step 8: Chạy thử lần 1 — ép refill**

Reviewer phải trả lời `curl -s localhost:7861/health`. Tạm hạ ngưỡng (sẽ trả lại ở Step 9):

```bash
node -e 'const f="topics/pool.json",p=JSON.parse(require("fs").readFileSync(f));p.refill.threshold=0.01;require("fs").writeFileSync(f,JSON.stringify(p,null,2)+"\n")'
BEFORE=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("topics/pool.json")).topics.length)')
START=$(date -u +%Y-%m-%dT%H:%M:%S)
curl -s -X POST http://localhost:5678/webhook/daily-dry-run; echo
node -e '
const fs=require("fs"); const start=process.argv[1]; const t0=Date.now();
(function poll(){
  let s={}; try { s=JSON.parse(fs.readFileSync("topics/state.json")); } catch {}
  const r=(s.refills||[])[0];
  if (r && r.at > start) { console.log("refill", JSON.stringify(r)); console.log("history0", JSON.stringify(s.history[0])); return; }
  if (Date.now()-t0 > 540000) { console.log("TIMEOUT"); process.exit(1); }
  setTimeout(poll, 10000);
})();' "$START"
node -e 'const p=JSON.parse(require("fs").readFileSync("topics/pool.json"));const c=p.topics.filter(t=>t.source==="claude");console.log("pool", p.topics.length, "claude", c.length);c.slice(0,5).forEach(t=>console.log(" -",t.topic))'
echo "before=$BEFORE"
node host/inspect-execution.js | grep -E "status=|Prune Output|Check Topics|Topics Low|Refill Topics|Merge Topics|Publish To Buffer"
ls output | sed -E 's/^([0-9]{14}_[a-z0-9]{6}).*/\1/' | sort -u | wc -l
```

Expected:
- webhook trả ngay `{"message":"Workflow was started"}`.
- `refill {... "added": <1..30>, "error": null}`; `history0` có `"dryRun":true`, `"published":false`, `"error":"dry run"`.
- `pool <before + added>`, `claude <added>`, vài topic mới dạng chữ thường.
- execution `status=success`; `Prune Output`, `Check Topics`, `Topics Low?`, `Refill Topics`, `Merge Topics` đều chạy; **không có** `Publish To Buffer`.
- số run trong `output/` ≤ 10.

- [ ] **Step 9: Trả ngưỡng, chạy thử lần 2 — không refill**

```bash
node -e 'const f="topics/pool.json",p=JSON.parse(require("fs").readFileSync(f));p.refill.threshold=0.9;require("fs").writeFileSync(f,JSON.stringify(p,null,2)+"\n")'
START=$(date -u +%Y-%m-%dT%H:%M:%S)
curl -s -X POST http://localhost:5678/webhook/daily-dry-run; echo
node -e '
const fs=require("fs"); const start=process.argv[1]; const t0=Date.now();
(function poll(){
  let s={}; try { s=JSON.parse(fs.readFileSync("topics/state.json")); } catch {}
  const h=(s.history||[])[0];
  if (h && h.at > start) { setTimeout(()=>{ console.log("history0", JSON.stringify(h)); }, 15000); return; }
  if (Date.now()-t0 > 540000) { console.log("TIMEOUT"); process.exit(1); }
  setTimeout(poll, 10000);
})();' "$START"
node host/inspect-execution.js | grep -E "status=|Topics Low|Refill Topics|Merge Topics"
```

Expected: `history0` có `dryRun:true`; execution `success`; `Topics Low?` chạy, **không có** `Refill Topics` / `Merge Topics`.

- [ ] **Step 10: Commit**

Commit code + việc xoá `topics.json`. `topics/pool.json` lúc này có topic Claude vừa thêm ở Step 8 — **commit riêng** để người dùng duyệt / revert dễ:

```bash
git add container/nodes/daily/01_pick_topic.js container/nodes/daily/02_record_run.js \
  container/nodes/daily/03_check_topics.js container/nodes/daily/04_merge_topics.js \
  host/workflows/daily.js build/daily.json
git commit -m "feat(daily): prune output to 10 runs, refill topics via Claude, dry-run webhook"
git add topics/pool.json
git commit -m "chore(topics): first Claude-suggested topics (from the dry-run test)"
```

(`git rm topics.json` ở Step 7 đã stage việc xoá; nó đi vào commit đầu.)

---

### Task 6: Tài liệu

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs.md`

**Interfaces:**
- Consumes: hành vi đã triển khai ở Task 1–5.

- [ ] **Step 1: `CLAUDE.md` — cây thư mục**

Trong cây thư mục:
- Bỏ mọi dòng nhắc `topics.json` (nếu có); thêm ở cấp `data/workflow/`, ngay trên `publish.config.json`:
  ```
  ├── topics/
  │   ├── pool.json             ← danh sách topic: bạn sửa tay, Claude tự thêm. Có trong git
  │   └── state.json            ← workflow ghi (đã dùng, history, refills). Gitignored
  ```
- Dưới `host/`: thêm `│   ├── migrate-topics.js     ← một lần: topics.json → topics/`.
- Dưới `host/imagereview/`: thêm `claude.js  ← spawn claude -p, dùng chung` và `topics.js  ← POST /topics`.
- Dưới `container/cli/`: thêm `prune_output.js   ← giữ N run mới nhất trong output/`.
- Dưới `container/nodes/`: thêm nhóm
  ```
  │       ├── daily/
  │       │   ├── lib/topics.js       ← hàm thuần, có test; NHÚNG vào Code node lúc deploy
  │       │   ├── 01_pick_topic.js
  │       │   ├── 02_record_run.js
  │       │   ├── 03_check_topics.js
  │       │   └── 04_merge_topics.js
  ```

- [ ] **Step 2: `CLAUDE.md` — mục "Chạy tự động mỗi ngày"**

Thay đoạn bắt đầu bằng `**Chủ đề lấy từ \`topics.json\`, chọn theo *ít dùng gần đây nhất***` (tới hết đoạn đó) bằng:

```markdown
**Chủ đề lấy từ `topics/pool.json`, chọn theo *ít dùng gần đây nhất*** — không phải
ngẫu nhiên, vì ngẫu nhiên lặp lại sớm hơn người ta tưởng nhiều. Sửa `pool.json` lúc
nào cũng được. Thứ workflow ghi (`used`, `history`, `refills`) nằm ở
`topics/state.json`, gitignored — nên `git status` không bẩn sau mỗi lần chạy.

**Pool tự bổ sung.** Khi ≥ `refill.threshold` (0.9) số topic đã chạy ít nhất một lần,
cuối run `daily` gọi `POST :7861/topics` — Claude viết thêm `refill.batch` (30) topic,
code lọc trùng / sai độ dài rồi nối vào `pool.json` với `source: "claude"`. **Duyệt
bằng `git diff topics/pool.json`.** Reviewer tắt thì chỉ ghi lỗi vào `state.refills`
và thử lại lần sau; picker vẫn còn ~10% topic chưa dùng.

**`output/` chỉ giữ 10 run mới nhất** (`KEEP_RUNS` trong `host/workflows/daily.js`),
dọn sau khi đăng — `buffer-publish` cần mp4 tới lúc đó, Buffer lấy bản trên S3.
File không bắt đầu bằng runId không bị đụng.

**Chạy thử không đăng:** `curl -X POST http://localhost:5678/webhook/daily-dry-run`
— dựng, ghi state, dọn, kiểm topic, **bỏ qua Buffer**. Không nhận tham số, nên không
thể dùng nó để đăng bài. Dry run vẫn tốn một lượt Groq và tính là đã dùng topic.

**Code node của `daily` dùng chung `lib/topics.js`.** Code node không `require` được
file dự án, nên `nodeCodeWithLib()` trong `host/workflows/daily.js` nối phần trên dòng
`// --- exports (stripped when embedded) ---` vào trước node. Test:
`node --test container/nodes/daily/lib/*.test.js`. Đừng xoá dòng đánh dấu đó.
```

- [ ] **Step 3: `CLAUDE.md` — lệnh thường dùng**

Ngay dưới dòng `node --test container/cli/lib/*.test.js      # test logic chọn ảnh`, thêm:

```bash
node --test container/cli/*.test.js            # test prune_output
node --test container/nodes/daily/lib/*.test.js  # test logic topic

# chạy daily mà không đăng Buffer (trả ngay; xem tiến độ bằng inspect-execution)
curl -X POST http://localhost:5678/webhook/daily-dry-run
```

- [ ] **Step 4: `CLAUDE.md` — mục reviewer**

Trong mục `### Claude chấm ảnh stock (\`host/imagereview/\`)`, thêm gạch đầu dòng cuối:

```markdown
- **Cùng server còn có `POST /topics`** (`topics.js`) cho việc bổ sung topic. Hai route
  dùng chung `claude.js` (cờ của `claude -p` nằm một chỗ) và chung semaphore 2 lời gọi.
```

- [ ] **Step 5: `docs.md`**

Ngay trước mục `### Trang kết cuối video ✅ (2026-10-05)`, chèn:

```markdown
### Topic tự bổ sung + giữ 10 video + tách pool/state ✅ (2026-10-10)

`topics.json` tách thành `topics/pool.json` (git) và `topics/state.json` (gitignored).
Khi ≥ 90% pool đã dùng, `daily` gọi Claude trên host thêm 30 topic (lọc trùng bằng
code). Sau mỗi lần đăng, `output/` chỉ giữ 10 run mới nhất. Webhook
`daily-dry-run` chạy trọn chuỗi trừ Buffer. Spec:
`docs/superpowers/specs/2026-10-10-topic-refill-output-retention-design.md`.
```

- [ ] **Step 6: Kiểm tàn dư**

```bash
rtk proxy grep -n "topics\.json" CLAUDE.md; echo "exit=$?"
```

Expected: không còn dòng nào mô tả `topics.json` như file đang dùng (nếu còn trong đoạn lịch sử thì ghi chú "đã tách thành `topics/`"); lý tưởng `exit=1`.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md docs.md
git commit -m "docs: topic pool/state split, Claude topic refill, output retention"
```
