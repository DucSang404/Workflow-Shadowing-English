# Ảnh cảnh stock + Claude chấm điểm — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thay ảnh SD sinh ra bằng ảnh Unsplash/Pexels/Openverse, Claude chấm 0–100 từng ứng viên theo lô 4 ảnh, dùng ảnh cao nhất ≥ 72 (không đạt thì vẫn dùng ảnh cao nhất, ghi FAIL).

**Architecture:** Hai node HTTP của n8n (giữ khoá) tìm Unsplash + Pexels cho từng câu và cho ảnh bìa (slot `idx 0`), một Code node gom vào `stock.json`. `container/cli/fetch_scenes.js` tải ứng viên lười, gửi từng lô 4 ảnh thu nhỏ tới `host/imagereview/server.js` (chạy `claude -p` trên host), chọn bằng hàm thuần `pickBest`. Một nhánh phụ sau Fetch Scenes báo download cho Unsplash.

**Tech Stack:** n8n 2.x (Code / HTTP Request / Execute Command node), Node (container: chỉ builtin + ffmpeg; host: Node 26 + `node:test`), `claude` CLI, macOS `sips`.

**Spec:** `docs/superpowers/specs/2026-10-10-stock-images-claude-review-design.md`

## Global Constraints

- Mọi đường dẫn trong plan tương đối với `data/workflow/` trừ khi ghi rõ; lệnh chạy từ `/Users/sangnguyen/Projects/ad-test/data/workflow`.
- `container/**` chỉ dùng `node` + `ffmpeg` + `ffprobe` + `sh`; không `jq`/`curl`/`bash`, không `npm install`, không `require` package ngoài.
- Code node chỉ `require` được `fs, path, child_process, crypto`.
- Chỉ ghi được trong `/data/workflow` (trong container).
- Mọi `throw` trong `container/nodes/**` **không có dấu hai chấm** (n8n cắt message tại dấu hai chấm cuối) — dùng ` - `.
- Script `container/cli/*`: nhận đường dẫn qua `process.argv`, không đọc env, in **một dòng JSON** ra stdout, lỗi ra stderr.
- Khoá API chỉ nằm trong credential store của n8n; `.env` chỉ giữ **id** credential (`CRED_UNSPLASH_ID`).
- Sửa `container/nodes/**` hoặc `host/workflows/**` thì phải chạy `node host/deploy.js shadowing shadowing-stub` mới có hiệu lực.
- Không sửa tay `build/*.json`.
- `passScore` mặc định **72**, kẹp `[0,100]`. Lô **4** ảnh, tối đa **2** lô / cảnh. Thumb **768 px**. `REVIEW_BUDGET_MS` = **180000**. Reviewer `MAX_CONCURRENT` = **2**, `CALL_TIMEOUT_MS` = **120000**, `MAX_BODY` = **16 MB**; caller `IMAGEREVIEW_MS` = **150000**.
- Unsplash: `per_page=6`, `orientation=landscape`, `content_filter=high`, header `Accept-Version: v1`; URL ảnh `urls.raw + '&w=1920&fm=jpg&q=80'`. Pexels `per_page` **6**.
- Comment trong code viết tiếng Anh, giọng văn như code xung quanh (giải thích *vì sao*, có số đo khi có).
- Không đụng timeline/audio/phụ đề (`03_build_srt.js` chỉ thêm field truyền qua; `build_video.js` không đổi).

## File map

| File | Việc |
|---|---|
| `container/cli/lib/pick_best.js` | **Mới.** `pickBest`, `candidateKey` — hàm thuần |
| `container/cli/lib/pick_best.test.js` | **Mới.** `node:test` |
| `host/imagereview/server.js` | **Viết lại.** `/review` nhận lô ảnh, trả mảng điểm |
| `host/imagereview/check.js` | **Mới.** Kiểm thang điểm trên fixture |
| `host/imagereview/fixtures/latte/{case.json,c1..c4.jpg}` | **Mới.** Fixture hiệu chuẩn |
| `container/cli/fetch_scenes.js` | **Viết lại.** Stock + review theo lô |
| `container/nodes/shadowing/01_prepare_run.js` | `stockPath`, `passScore`, `imageSource` |
| `container/nodes/shadowing/02_parse_normalize.js` | bỏ `imagePrompt`/`coverPrompt`, thêm `coverQuery` |
| `container/nodes/shadowing/05_collect_pexels.js` → `05_collect_stock.js` | gom Unsplash + Pexels |
| `container/nodes/shadowing/06_unsplash_downloads.js` | **Mới.** Liệt kê ảnh Unsplash đã dùng |
| `container/nodes/shadowing/03_build_srt.js` | truyền `passScore`, `reviewCalls` |
| `container/nodes/shadowing/04_build_response.js` | tổng hợp review mới |
| `host/workflows/shadowing.js` | Groq prompt, node Unsplash, nhánh phụ |
| `host/workflows/shadowing-stub.js` | `coverQuery` trong CANNED |
| `host/deploy.js` | credential `unsplash` |
| `CLAUDE.md`, `docs.md` | tài liệu |

---

### Task 1: `pickBest` — logic chọn ảnh

**Files:**
- Create: `container/cli/lib/pick_best.js`
- Test: `container/cli/lib/pick_best.test.js`

**Interfaces:**
- Produces:
  - `candidateKey(c: {source: string, id?: string, url: string}) => string` — `"<source>:<id ?? url>"`.
  - `pickBest(scored: Array<{key: string, score: number}>, passScore: number, used: Set<string>) => {choice: object|null, pass: boolean|null}` — bỏ qua phần tử có `key` trong `used` hoặc `score` không phải số; điểm cao nhất thắng, hoà thì phần tử đứng trước thắng; `pass = choice.score >= passScore`; không còn gì → `{choice: null, pass: null}`.

- [ ] **Step 1: Viết test (fail)**

`container/cli/lib/pick_best.test.js`:

```js
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
```

- [ ] **Step 2: Chạy test, xác nhận fail**

Run: `node --test container/cli/lib/*.test.js`
Expected: FAIL — `Cannot find module './pick_best'`.

- [ ] **Step 3: Cài đặt**

`container/cli/lib/pick_best.js`:

```js
/**
 * Choosing one still per scene from the candidates Claude has scored.
 *
 * Kept apart from fetch_scenes.js because it is the one piece of that script with
 * a rule worth pinning down in a test: the bar, the fallback below it, and no
 * photo appearing twice in a video. Pure - no I/O - so it runs under `node --test`
 * on the host.
 */

/** Identity of a candidate across scenes: the same photo found by two searches is one photo. */
function candidateKey(c) {
  return `${c.source}:${c.id ?? c.url}`;
}

/**
 * Best-scoring candidate not already used elsewhere in the video.
 *
 * The best is returned even below `passScore`: a weak picture beats a hole in the
 * video, and `pass: false` lets the run record say so. A tie goes to the earlier
 * candidate, which is the one the source ranked higher.
 *
 * @param {Array<{key: string, score: number}>} scored - in source order
 * @param {number} passScore - 0-100
 * @param {Set<string>} used - candidateKey() of every still already chosen
 * @returns {{choice: object|null, pass: boolean|null}}
 */
function pickBest(scored, passScore, used) {
  let choice = null;
  for (const c of scored) {
    if (used.has(c.key) || !Number.isFinite(c.score)) continue;
    if (!choice || c.score > choice.score) choice = c;
  }
  return choice ? { choice, pass: choice.score >= passScore } : { choice: null, pass: null };
}

module.exports = { pickBest, candidateKey };
```

- [ ] **Step 4: Chạy test, xác nhận pass**

Run: `node --test container/cli/lib/*.test.js`
Expected: `# pass 8`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add container/cli/lib/pick_best.js container/cli/lib/pick_best.test.js
git commit -m "feat(scenes): add pickBest for choosing a scored stock photo"
```

---

### Task 2: Reviewer chấm điểm theo lô

**Files:**
- Modify (viết lại toàn bộ): `host/imagereview/server.js`
- Create: `host/imagereview/check.js`
- Create: `host/imagereview/fixtures/latte/case.json`, `c1.jpg`, `c2.jpg`, `c3.jpg`, `c4.jpg`

**Interfaces:**
- Produces: `POST http://127.0.0.1:7861/review`
  - Request: `{ kind: 'scene'|'cover', topic: string, line: {idx, en, vi}|null, dialogue: [{idx, speaker, en}], images: [{id: string, mediaType: 'image/jpeg', data: base64}] }` — 1–4 ảnh, `id` duy nhất.
  - 200: `{ required: string[], scores: [{id, present: string[], missing: string[], issues: string[], score: 0..100}], model: string, ms: number|null }` — `scores` có đủ mọi `id`.
  - 400: request sai hình dạng. 503: Claude lỗi / timeout / thiếu điểm cho một id.
  - `GET /health` → `{ ok: true, model, active, waiting }` (giữ nguyên).

- [ ] **Step 1: Tạo fixture ảnh**

Lấy 4 ảnh CC0 từ Openverse, thu nhỏ bằng `sips` (macOS có sẵn; host không có `ffmpeg` trên PATH):

```bash
cd /Users/sangnguyen/Projects/ad-test/data/workflow/host/imagereview
mkdir -p fixtures/latte
# $1 = output id, $2 = query, $3 = which result (0-based)
grab() {
  url=$(curl -s -A 'shadowing-video/1.0' \
    "https://api.openverse.org/v1/images/?q=$(printf %s "$2" | sed 's/ /%20/g')&license=cc0&size=large&page_size=8&mature=false" \
    | jq -r ".results[$3].url")
  curl -sL -A 'shadowing-video/1.0' "$url" -o "fixtures/latte/$1.raw" \
    && sips -s format jpeg -Z 768 "fixtures/latte/$1.raw" --out "fixtures/latte/$1.jpg" >/dev/null \
    && rm "fixtures/latte/$1.raw"
}
grab c1 "iced latte" 0
grab c2 "iced coffee cafe" 0
grab c3 "snowy mountain" 0
grab c4 "car engine" 0
ls -la fixtures/latte
```

Expected: 4 file `.jpg`, mỗi file > 20 KB.

- [ ] **Step 2: Kiểm bằng mắt từng ảnh**

Mở `c1.jpg`..`c4.jpg` (Read tool). Yêu cầu:
- `c1`, `c2`: **nhìn thấy rõ một ly cà phê đá**; ít nhất một trong hai có bối cảnh quán.
- `c3`, `c4`: không liên quan tới cà phê.

Ảnh nào không đạt → chạy lại `grab <id> "<query>" 1` (rồi `2`, `3`…) tới khi đạt. Đây là fixture, sai ở đây làm hỏng phép kiểm ở Step 6.

- [ ] **Step 3: Viết `case.json`**

`host/imagereview/fixtures/latte/case.json`:

```json
{
  "kind": "scene",
  "topic": "ordering coffee",
  "line": { "idx": 1, "en": "Hi there, could I get a large iced latte, please?", "vi": "Chào bạn, cho tôi một ly latte đá lớn nhé?" },
  "dialogue": [
    { "idx": 1, "speaker": "A", "en": "Hi there, could I get a large iced latte, please?" },
    { "idx": 2, "speaker": "B", "en": "Sure thing. Would you like any syrup with that?" }
  ],
  "expect": { "c1": "pass", "c2": "pass", "c3": "fail", "c4": "fail" }
}
```

- [ ] **Step 4: Viết `check.js`**

`host/imagereview/check.js`:

```js
#!/usr/bin/env node
/**
 * Calibration check for the reviewer's scoring scale.
 *
 *   node host/imagereview/check.js [fixtureDir]     # default: fixtures/latte
 *
 * Sends the fixture's photos as one batch to a running server and checks that the
 * ones that fit the line score at or above 72 and the ones that do not score below
 * 50. Run it after any change to the prompt or the model: a pass score of 72 only
 * means something while this still holds.
 *
 * Exits non-zero on any miss, so it can gate a change.
 */
const fs = require('fs');
const path = require('path');

const dir = process.argv[2] ?? path.join(__dirname, 'fixtures', 'latte');
const PORT = Number(process.env.IMAGEREVIEW_PORT ?? 7861);
const PASS_AT = 72;
const FAIL_BELOW = 50;

(async () => {
  const { expect, ...req } = JSON.parse(fs.readFileSync(path.join(dir, 'case.json'), 'utf8'));
  const images = Object.keys(expect).map((id) => ({
    id,
    mediaType: 'image/jpeg',
    data: fs.readFileSync(path.join(dir, `${id}.jpg`)).toString('base64'),
  }));

  const res = await fetch(`http://127.0.0.1:${PORT}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...req, images }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`http ${res.status} ${JSON.stringify(body)}`);

  let ok = true;
  for (const s of body.scores) {
    const want = expect[s.id];
    const good = want === 'pass' ? s.score >= PASS_AT : s.score < FAIL_BELOW;
    if (!good) ok = false;
    console.log(`${good ? 'ok ' : 'BAD'} ${s.id} want=${want} score=${s.score} `
      + `missing=${JSON.stringify(s.missing)} issues=${JSON.stringify(s.issues)}`);
  }
  console.log(`required=${JSON.stringify(body.required)} model=${body.model} ${body.ms ?? '?'}ms`);
  process.exit(ok ? 0 : 1);
})().catch((err) => { console.error(err.message); process.exit(1); });
```

- [ ] **Step 5: Chạy check với server CŨ, xác nhận fail**

```bash
launchctl unload ~/Library/LaunchAgents/com.shawnspace.imagereview.plist 2>/dev/null
node host/imagereview/server.js &
sleep 1
node host/imagereview/check.js; echo "exit=$?"
```

Expected: `http 400 {"error":"image (base64) is required"}` và `exit=1` (server cũ không hiểu `images`).

Dừng server: `kill %1`.

- [ ] **Step 6: Viết lại `host/imagereview/server.js`**

Thay toàn bộ nội dung file:

```js
#!/usr/bin/env node
/**
 * Scene reviewer: Claude scores stock-photo candidates against the line of
 * dialogue each scene illustrates.
 *
 *   node host/imagereview/server.js        # :7861, loopback only
 *
 *   GET  /health
 *   POST /review   { kind, topic, line, dialogue, images: [{ id, mediaType, data }] }
 *               -> { required, scores: [{ id, present, missing, issues, score }], model, ms }
 *
 * Why it exists: a stock search matches keywords, not the line. A search for the
 * syrup in a coffee order finds syrup on pancakes, and nothing in the pipeline can
 * tell - every pixel decodes fine. Claude can tell, so fetch_scenes.js sends the
 * candidates here and keeps the best one at or above its pass score.
 *
 * This server only SCORES. The bar (72 by default) is applied in fetch_scenes.js,
 * so moving it never means touching the prompt. Up to four candidates go in one
 * call: seeing them side by side keeps the numbers consistent with each other, and
 * it is a quarter of the calls. `node host/imagereview/check.js` re-checks the
 * scale against a fixed fixture after any prompt or model change.
 *
 * It runs on the HOST because it drives the `claude` CLI you are already logged in
 * to. The n8n image has no `claude` and cannot get one (see CLAUDE.md, container
 * constraints). The call is `claude -p` with:
 *   - the images sent inline over stream-json, so no tool is needed to read them
 *   - `--tools ""`: the reviewer can look, and do nothing else
 *   - `--json-schema`, so the verdict is parsed, never scraped out of prose
 *   - its own system prompt, and a cwd outside the project, so neither Claude
 *     Code's default prompt nor this repo's 40 KB CLAUDE.md is paid for per call
 *
 * Bound to 127.0.0.1, not 0.0.0.0: Docker Desktop still routes
 * host.docker.internal to it (verified from inside shadowing-n8n), and nothing on
 * the LAN can spend your Claude usage.
 *
 * A reviewer that is down, slow or rate-limited answers 503 and the caller uses
 * its first candidate unreviewed. Review improves pictures; it must never cost a
 * video.
 */
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.IMAGEREVIEW_PORT ?? 7861);
// Sonnet over Haiku: the whole point is telling an iced latte from an iced tea.
const MODEL = process.env.IMAGEREVIEW_MODEL ?? 'sonnet';
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';
// Four images per call instead of one, so more than the single-image 90 s.
const CALL_TIMEOUT_MS = 120000;
// Scenes are reviewed while other scenes download, so two is enough to keep up,
// and more would only spend usage faster.
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

/** The user turn: each labelled candidate, then everything needed to judge them. */
function reviewMessage(req) {
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
  return { type: 'user', message: { role: 'user', content } };
}

/** One `claude -p` call. Resolves to the structured verdict or throws. */
function askClaude(req) {
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
      '--system-prompt', SYSTEM_PROMPT,
      '--json-schema', JSON.stringify(SCHEMA),
    ], {
      cwd: os.tmpdir(),
      env: { ...process.env, PATH: `${path.join(os.homedir(), '.local', 'bin')}:${process.env.PATH}` },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('claude timed out')); }, CALL_TIMEOUT_MS);
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
      // A batch with a candidate left unscored is unusable: the caller cannot tell
      // a skipped photo from a bad one.
      const verdict = result.structured_output;
      const got = new Set((verdict.scores ?? []).map((s) => s.id));
      const lost = req.images.map((i) => i.id).filter((id) => !got.has(id));
      if (lost.length) {
        reject(new Error(`no score for ${lost.join(', ')}`));
        return;
      }
      resolve({ ...verdict, model: MODEL, ms: result.duration_ms ?? null });
    });

    child.stdin.end(`${JSON.stringify(reviewMessage(req))}\n`);
  });
}

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

/** Null when the batch is well-formed, otherwise the reason it is not. */
function badImages(images) {
  if (!Array.isArray(images) || !images.length || images.length > MAX_IMAGES) {
    return `images must be an array of 1 to ${MAX_IMAGES}`;
  }
  if (images.some((i) => !i?.id || !i?.data)) return 'every image needs an id and base64 data';
  if (new Set(images.map((i) => i.id)).size !== images.length) return 'image ids must be unique';
  return null;
}

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    send(res, 200, { ok: true, model: MODEL, active, waiting: waiting.length });
    return;
  }
  if (req.method !== 'POST' || req.url !== '/review') {
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
    const bad = badImages(body.images);
    if (bad) {
      send(res, 400, { error: bad });
      return;
    }
    const started = Date.now();
    try {
      const verdict = await withSlot(() => askClaude(body));
      console.log(`[imagereview] ${((Date.now() - started) / 1000).toFixed(1)}s `
        + `${body.kind ?? 'scene'} ${body.line?.idx ?? ''} `
        + `${verdict.scores.map((s) => `${s.id}=${s.score}`).join(' ')}`);
      send(res, 200, verdict);
    } catch (e) {
      console.log(`[imagereview] error: ${e.message}`);
      send(res, 503, { error: e.message });
    }
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[imagereview] listening on 127.0.0.1:${PORT}, model ${MODEL}`);
});
```

- [ ] **Step 7: Chạy check với server mới**

```bash
node host/imagereview/server.js &
sleep 1
curl -s -X POST localhost:7861/review -H 'Content-Type: application/json' -d '{"images":[]}'; echo
node host/imagereview/check.js; echo "exit=$?"
kill %1
```

Expected:
- dòng đầu: `{"error":"images must be an array of 1 to 4"}`
- 4 dòng `ok  c1 … ok  c4`, rồi `required=["cafe","coffee cup"]` (hoặc tương đương), `exit=0`. Thời gian một lần gọi khoảng 8–15 s.

Nếu một ảnh `BAD`: đọc `missing`/`issues`. Nếu lý do cho thấy **fixture** sai (vd c2 thật sự không có ly cà phê) → quay lại Step 2 đổi ảnh. Nếu lý do cho thấy **prompt** chấm lệch thang → sửa mốc điểm trong `SYSTEM_PROMPT`, chạy lại. Không hạ ngưỡng trong `check.js`.

- [ ] **Step 8: Bật lại LaunchAgent**

```bash
launchctl load ~/Library/LaunchAgents/com.shawnspace.imagereview.plist
sleep 2 && curl -s localhost:7861/health
```

Expected: `{"ok":true,"model":"sonnet","active":0,"waiting":0}`

- [ ] **Step 9: Commit**

```bash
git add host/imagereview/server.js host/imagereview/check.js host/imagereview/fixtures
git commit -m "feat(imagereview): score batches of stock photos 0-100 instead of reviewing SD stills"
```

---

### Task 3: `fetch_scenes.js` — stock + review theo lô

**Files:**
- Modify (viết lại toàn bộ): `container/cli/fetch_scenes.js`

**Interfaces:**
- Consumes:
  - `require('./lib/pick_best')` → `pickBest`, `candidateKey` (Task 1).
  - `POST /review` (Task 2).
  - `<dir>/manifest.json`: `{ topic, reviewImages, passScore, coverQuery, imageSource, sentences: [{idx, speaker, en, vi, imageQuery}] }` (Task 4 ghi các field mới; script phải chịu được manifest cũ thiếu `passScore`/`coverQuery`).
  - `<dir>/stock.json` (có thể không tồn tại): `{ "<idx>": [{source, id, url, photographer, link, downloadLocation?}] }`.
- Produces: stdout một dòng JSON:
  `{ scenes, missing, coverBackground, coverReview, reviewer: 'up'|'off', passScore, reviewCalls, imageSource, unsplashChosen: [{idx, downloadLocation}] }`.
  Mỗi phần tử `scenes`: `{ idx, file, query, matchedQuery, source, id, photographer, link, license, attribution, downloadLocation?, review }`;
  `review` = `{ score, pass, passScore, required, missing, issues, batches, reviewed, model, candidates: [{source, id, score}] }` hoặc `{ pass: null, skipped, passScore }`.
  `coverReview` = `review` của ảnh bìa cộng `{source, id, photographer, link}`, hoặc `null`.

- [ ] **Step 1: Dựng thư mục thử (test fail trước)**

```bash
mkdir -p work/_scenes_test
cat > work/_scenes_test/manifest.json <<'EOF'
{ "runId": "_scenes_test", "topic": "ordering coffee", "reviewImages": true, "passScore": 72,
  "coverQuery": "coffee shop interior", "imageSource": "auto",
  "sentences": [
    { "idx": 1, "speaker": "A", "en": "Hi there, could I get a large iced latte, please?", "vi": "Cho tôi một ly latte đá lớn nhé?", "imageQuery": "iced latte cup" },
    { "idx": 2, "speaker": "B", "en": "Sure thing. Would you like any syrup with that?", "vi": "Bạn có muốn thêm siro không?", "imageQuery": "coffee syrup bottles" }
  ] }
EOF
docker exec shadowing-n8n node /data/workflow/container/cli/fetch_scenes.js /data/workflow/work/_scenes_test \
  | node -e 'const o=JSON.parse(require("fs").readFileSync(0));console.log(JSON.stringify({reviewer:o.reviewer,passScore:o.passScore,reviewCalls:o.reviewCalls,cover:o.coverBackground,scenes:o.scenes.map(s=>({idx:s.idx,source:s.source,score:s.review&&s.review.score}))}))'
```

Expected (code cũ): `passScore` và `reviewCalls` là `undefined` (không xuất hiện), `cover` là `null`. Đó là "fail" của bước này.

- [ ] **Step 2: Viết lại `container/cli/fetch_scenes.js`**

Thay toàn bộ nội dung file:

```js
#!/usr/bin/env node
/**
 * usage: node fetch_scenes.js <sentenceDir>
 *
 * Finds one stock photo per sentence, plus one for the title-card backdrop, and
 * saves them as <dir>/scene_NNN.jpg and <dir>/cover_bg.jpg.
 *
 * Candidates come from two places, in order:
 *   1. stock.json - Unsplash and Pexels results, interleaved. The workflow's HTTP
 *                   nodes hold the API keys and write this file; this script never
 *                   sees a key. See CLAUDE.md, "Secrets".
 *   2. Openverse  - Creative Commons photos, keyless. Searched only once the stock
 *                   list runs out, because it is the slow one: each query tier is
 *                   a separate request.
 *
 * Claude (host/imagereview, :7861) scores the candidates 0-100 against the line,
 * four per call. The best one at or above `manifest.passScore` (72 unless the
 * caller set it) is used. When none reaches it a second batch of four is tried,
 * and after that the highest score is used anyway and recorded as a fail: a weak
 * picture beats a hole in the video.
 *
 * No photo is used twice in one video. The reviewer is optional: down, switched
 * off or out of budget, a scene takes its first candidate that decodes.
 *
 * A search yields *candidates*, not an answer. Openverse indexes many providers
 * and some of them (Wikimedia in particular) answer this host with HTTP 429 while
 * others serve happily, so taking only the top hit lost 4 of 6 scenes. Every
 * candidate is tried until enough download and decode.
 *
 * A sentence with no usable image is reported in `missing`; build_video.js falls
 * back to the plain background for it rather than failing the run.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { pickBest, candidateKey } = require('./lib/pick_best');

const dir = process.argv[2];

const MIN_BYTES = 8 * 1024;
const MAX_BYTES = 12 * 1024 * 1024;   // a 6000x4000 original is not worth waiting for
const SEARCH_TIMEOUT_MS = 15000;
const DOWNLOAD_TIMEOUT_MS = 45000;
const MAX_PARALLEL = 3;               // be a polite guest on a keyless public API
const NORMALISE_WIDTH = 1920;         // every scene is downscaled to this at most
const MAX_CANDIDATES = 10;            // per Openverse search, across its tiers

// What Claude is shown. Four full 1920 px frames make a slow, token-heavy request
// and judge no better than 768 px does.
const THUMB_WIDTH = 768;
const BATCH_SIZE = 4;
// A second batch rescues scenes whose first four were near misses; past that the
// candidates are the search's long tail and rarely better.
const MAX_BATCHES = 2;

const IMAGEREVIEW_URL = 'http://host.docker.internal:7861';
// Short: this only asks whether the service is up.
const IMAGEREVIEW_HEALTH_MS = 1500;
// One four-image call is ~10 s; this also covers waiting behind the reviewer's
// two-call concurrency limit.
const IMAGEREVIEW_MS = 150000;
// No new batches after this long. The daily workflow gives the whole build 540 s
// and a normal one takes ~100 s, so a slow or rate-limited reviewer must not be
// able to spend the rest.
const REVIEW_BUDGET_MS = 180000;
const startedAt = Date.now();

// Wikimedia and Flickr both reject clients that do not identify themselves, and
// Wikimedia asks for a contact. A bare fetch() gets HTTP 429.
const UA = 'shadowing-video/1.0 (self-hosted n8n pipeline; +https://github.com/n8n-io/n8n)';

// Licences in order of how little they oblige the uploader: cc0/pdm need no
// credit, `by` needs a credit line. by-sa is excluded on purpose - its
// share-alike terms would reach the whole upload.
const LICENCE_TIERS = ['cc0,pdm', 'by'];

const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const passScore = Number.isFinite(manifest.passScore) ? manifest.passScore : 72;

// Written by the workflow's Collect Stock node; absent when it never ran.
let stock = {};
const stockFile = path.join(dir, 'stock.json');
if (fs.existsSync(stockFile)) {
  try {
    stock = JSON.parse(fs.readFileSync(stockFile, 'utf8'));
  } catch {
    stock = {};
  }
}

const withTimeout = async (url, opts = {}, ms = SEARCH_TIMEOUT_MS) => {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: control.signal });
  } finally {
    clearTimeout(timer);
  }
};

/**
 * A phrase like "passport and key card" returns nothing while "passport" returns
 * plenty, so the query is relaxed in steps.
 */
function queryTiers(query, topic) {
  const words = query.split(/\s+/).filter(Boolean);
  const tiers = [query];

  // Drop words from the FRONT, not the back. English puts the head noun last, so
  // "printed hotel invoice" relaxes to "hotel invoice" and then "invoice".
  // Trimming the other way gave "printed hotel", which returned an 18th-century
  // engraving of the Hotel des Invalides.
  //
  // Stop while at least two words remain: a lone generic noun matches anything.
  // "handover" returned a soldier holding a microphone, "March" an engraved
  // silver plate. The topic is a better bet than a single word, so it goes ahead
  // of them and the one-word forms are the last resort.
  for (let drop = 1; words.length - drop >= 2; drop += 1) {
    tiers.push(words.slice(drop).join(' '));
  }
  if (topic && topic !== query) tiers.push(topic);
  if (words.length > 1) tiers.push(words[words.length - 1]);

  return [...new Set(tiers)];
}

async function openverseSearch(query, licence) {
  const url = 'https://api.openverse.org/v1/images/'
    + `?q=${encodeURIComponent(query)}&license=${licence}`
    + '&aspect_ratio=wide&size=large&page_size=8&mature=false';
  const res = await withTimeout(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return [];

  const body = await res.json();
  return (body.results ?? [])
    // Skip giant originals: a 6000x4000 scan is a slow download and gets scaled
    // down to 1920 immediately anyway.
    .filter((r) => r.url && (r.width ?? 0) >= 900 && (r.width ?? 0) <= 5000)
    .map((r) => ({
      source: 'openverse',
      id: r.id ?? null,
      url: r.url,
      license: r.license,
      photographer: r.creator ?? null,
      link: r.foreign_landing_url ?? null,
      matchedQuery: query,
      // Only a `by` image obliges the uploader to print a credit.
      attribution: r.license === 'by'
        ? `"${r.title ?? 'untitled'}" by ${r.creator ?? 'unknown'} (CC BY) - ${r.foreign_landing_url ?? r.url}`
        : null,
    }));
}

/** Candidates across every licence and query tier, best first, deduped. */
async function openverseCandidates(query, topic, trace) {
  const out = [];
  const seen = new Set();

  for (const licence of LICENCE_TIERS) {
    for (const term of queryTiers(query, topic)) {
      if (out.length >= MAX_CANDIDATES) return out;
      try {
        const hits = await openverseSearch(term, licence);
        if (!hits.length) trace.push(`${licence}/"${term}": no result`);
        for (const hit of hits) {
          if (seen.has(hit.url)) continue;
          seen.add(hit.url);
          out.push(hit);
        }
      } catch (err) {
        trace.push(`${licence}/"${term}": ${err.message}`);
      }
    }
  }
  return out;
}

async function download(url, dest) {
  let res;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    res = await withTimeout(url, {
      redirect: 'follow',
      headers: { 'User-Agent': UA },
    }, DOWNLOAD_TIMEOUT_MS);
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((r) => setTimeout(r, 600 * 2 ** attempt));
  }
  if (!res.ok) throw new Error(`http ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < MIN_BYTES) throw new Error(`too small (${buf.length} bytes)`);
  if (buf.length > MAX_BYTES) throw new Error(`too large (${Math.round(buf.length / 1048576)} MB)`);

  const raw = `${dest}.raw`;
  fs.writeFileSync(raw, buf);

  // Re-encode rather than trust the download: a 200 response is not proof of an
  // image (error pages save happily), and normalising the size here keeps work/
  // small and the later video encode predictable. ffmpeg failing is the check.
  try {
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', raw,
      '-vf', `scale='min(${NORMALISE_WIDTH},iw)':-2`, '-q:v', '4', dest], { stdio: 'pipe' });
  } catch {
    throw new Error('not a decodable image');
  } finally {
    fs.rmSync(raw, { force: true });
  }
}

let reviewerUp = false;
let reviewCalls = 0;
// candidateKey() of every still already chosen. Choosing and adding happen with
// no `await` in between, so scenes running side by side cannot take the same one.
const used = new Set();

/**
 * Stock results first, Openverse only once those run out. A generator, so the
 * slow Openverse search is never made for a scene the stock list already covered.
 */
async function* candidatesFor(job, trace) {
  yield* (stock[job.idx] ?? []);
  yield* await openverseCandidates(job.query, manifest.topic, trace);
}

/** Downloads candidates from `it` until `pool` holds `target` decodable stills. */
async function fill(pool, it, target, prefix, trace) {
  while (pool.length < target) {
    const { value: c, done } = await it.next();
    if (done) return;
    const key = candidateKey(c);
    if (used.has(key) || pool.some((p) => p.key === key)) continue;
    const file = path.join(dir, `${prefix}_c${pool.length + 1}.jpg`);
    try {
      await download(c.url, file);
      pool.push({ ...c, key, file });
    } catch (err) {
      trace.push(`${new URL(c.url).host}: ${err.message}`);
    }
  }
}

/** Claude's scores for one batch, in batch order. Throws when it cannot give them. */
async function reviewBatch(job, batch) {
  const images = batch.map((c, n) => {
    const thumb = c.file.replace(/\.jpg$/, '_thumb.jpg');
    try {
      execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', c.file,
        '-vf', `scale='min(${THUMB_WIDTH},iw)':-2`, '-q:v', '5', thumb], { stdio: 'pipe' });
      return { id: `c${n + 1}`, mediaType: 'image/jpeg', data: fs.readFileSync(thumb).toString('base64') };
    } finally {
      fs.rmSync(thumb, { force: true });
    }
  });

  reviewCalls += 1;
  const res = await withTimeout(`${IMAGEREVIEW_URL}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: job.cover ? 'cover' : 'scene',
      topic: manifest.topic,
      line: job.cover ? null : { idx: job.idx, en: job.en, vi: job.vi },
      // The whole exchange, so "that" in "any syrup with that?" can be resolved.
      dialogue: manifest.sentences.map(({ idx, speaker, en }) => ({ idx, speaker, en })),
      images,
    }),
  }, IMAGEREVIEW_MS);
  if (!res.ok) throw new Error(`http ${res.status} ${(await res.text().catch(() => '')).slice(0, 160)}`);

  const body = await res.json();
  const byId = Object.fromEntries((body.scores ?? []).map((s) => [s.id, s]));
  return {
    required: body.required ?? [],
    model: body.model ?? null,
    scores: batch.map((c, n) => {
      const s = byId[`c${n + 1}`];
      if (!s) throw new Error(`reviewer returned no score for c${n + 1}`);
      return { score: s.score, present: s.present ?? [], missing: s.missing ?? [], issues: s.issues ?? [] };
    }),
  };
}

/** One scene (or the cover): gather, review in batches, choose, keep one file. */
async function resolveJob(job) {
  const trace = [];
  const prefix = job.cover ? 'cover' : `scene_${String(job.idx).padStart(3, '0')}`;
  const dest = path.join(dir, job.cover ? 'cover_bg.jpg' : `${prefix}.jpg`);
  const it = candidatesFor(job, trace);
  const pool = [];
  const scored = [];
  let batches = 0;
  let required = [];
  let model = null;
  let skipped = reviewerUp ? null : 'reviewer off';

  await fill(pool, it, BATCH_SIZE, prefix, trace);
  while (!skipped && batches < MAX_BATCHES && scored.length < pool.length) {
    if (Date.now() - startedAt > REVIEW_BUDGET_MS) {
      skipped = 'review budget spent';
      break;
    }
    const batch = pool.slice(scored.length, scored.length + BATCH_SIZE);
    try {
      const verdict = await reviewBatch(job, batch);
      batches += 1;
      required = verdict.required;
      model = verdict.model;
      batch.forEach((c, n) => scored.push({ ...c, ...verdict.scores[n] }));
    } catch (err) {
      // A reviewer that cannot answer is not a reason to lose the picture.
      trace.push(`review: ${err.message}`);
      if (!scored.length) skipped = err.message;
      break;
    }
    if (pickBest(scored, passScore, used).pass) break;
    if (batches < MAX_BATCHES) await fill(pool, it, pool.length + BATCH_SIZE, prefix, trace);
  }

  let choice = null;
  let pass = null;
  if (scored.length) ({ choice, pass } = pickBest(scored, passScore, used));
  if (!choice) {
    choice = pool.find((c) => !used.has(c.key)) ?? null;
    pass = null;
    if (scored.length && !skipped) skipped = 'every scored candidate was taken by another scene';
  }

  for (const c of pool) if (c !== choice) fs.rmSync(c.file, { force: true });
  if (!choice) {
    return {
      idx: job.idx, cover: job.cover || undefined, query: job.query, missing: true,
      reason: trace.slice(-4).join(' | ') || 'no candidates',
    };
  }
  used.add(choice.key);
  fs.renameSync(choice.file, dest);

  const review = Number.isFinite(choice.score)
    ? {
      score: choice.score, pass, passScore, required,
      missing: choice.missing, issues: choice.issues,
      batches, reviewed: scored.length, model,
      // Every candidate Claude saw, so a scene that failed shows what was on offer.
      candidates: scored.map(({ source, id, score }) => ({ source, id, score })),
    }
    : { pass: null, skipped: skipped ?? 'not reviewed', passScore };

  return {
    idx: job.idx,
    cover: job.cover || undefined,
    file: dest,
    query: job.query,
    matchedQuery: choice.matchedQuery ?? job.query,
    source: choice.source,
    id: choice.id ?? null,
    photographer: choice.photographer ?? null,
    link: choice.link ?? null,
    license: choice.license ?? choice.source,
    attribution: choice.attribution ?? null,
    ...(choice.downloadLocation ? { downloadLocation: choice.downloadLocation } : {}),
    review,
  };
}

/** Runs tasks with a ceiling on how many are in flight at once. */
async function mapWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await worker(items[i]);
    }
  }));
  return results;
}

/** One probe for the whole run, rather than a dead connection per scene. */
async function reviewerAvailable() {
  if (manifest.reviewImages === false) return false;
  try {
    return (await withTimeout(`${IMAGEREVIEW_URL}/health`, {}, IMAGEREVIEW_HEALTH_MS)).ok;
  } catch {
    return false;
  }
}

(async () => {
  reviewerUp = await reviewerAvailable();

  // The cover is the title card's backdrop and the cover on the profile grid, so
  // it goes FIRST: queued last, it reached the reviewer after the budget was spent.
  // Its stock results are filed under idx 0, the slot the spoken brand line rides.
  const jobs = [
    { cover: true, idx: 0, query: manifest.coverQuery || manifest.topic },
    ...manifest.sentences.map((s) => ({ ...s, query: s.imageQuery || manifest.topic })),
  ];

  const settled = await mapWithLimit(jobs, MAX_PARALLEL, async (job) => {
    try {
      return await resolveJob(job);
    } catch (err) {
      return { idx: job.idx, cover: job.cover || undefined, query: job.query, missing: true, reason: err.message };
    }
  });

  const cover = settled.find((r) => r.cover);
  const coverOk = cover && !cover.missing;
  const rest = settled.filter((r) => !r.cover);
  const scenes = rest.filter((r) => !r.missing).sort((a, b) => a.idx - b.idx);
  const missing = rest.filter((r) => r.missing).map(({ idx, query, reason }) => ({ idx, query, reason }));

  process.stdout.write(JSON.stringify({
    scenes,
    missing,
    coverBackground: coverOk ? cover.file : null,
    coverReview: coverOk
      ? { ...cover.review, source: cover.source, id: cover.id, photographer: cover.photographer, link: cover.link }
      : null,
    reviewer: reviewerUp ? 'up' : 'off',
    passScore,
    reviewCalls,
    imageSource: manifest.imageSource ?? 'auto',
    // The workflow reports each of these to Unsplash; its API guidelines require it.
    unsplashChosen: [...(coverOk ? [cover] : []), ...scenes]
      .filter((r) => r.downloadLocation)
      .map((r) => ({ idx: r.idx, downloadLocation: r.downloadLocation })),
  }));
})().catch((err) => { console.error(err.message); process.exit(1); });
```

- [ ] **Step 3: Chạy lại thư mục thử (Openverse only, reviewer bật)**

Đảm bảo reviewer đang chạy (`curl -s localhost:7861/health`). Rồi:

```bash
rm -f work/_scenes_test/*.jpg
docker exec shadowing-n8n node /data/workflow/container/cli/fetch_scenes.js /data/workflow/work/_scenes_test \
  | node -e 'const o=JSON.parse(require("fs").readFileSync(0));console.log(JSON.stringify({reviewer:o.reviewer,passScore:o.passScore,reviewCalls:o.reviewCalls,cover:o.coverBackground,scenes:o.scenes.map(s=>({idx:s.idx,source:s.source,score:s.review.score,pass:s.review.pass,batches:s.review.batches})),missing:o.missing}))'
ls work/_scenes_test
```

Expected:
- `reviewer:"up"`, `passScore:72`, `reviewCalls` từ 3 đến 6.
- `cover` = `/data/workflow/work/_scenes_test/cover_bg.jpg`.
- 2 scene, `source:"openverse"`, có `score` dạng số, `batches` 1 hoặc 2.
- `ls` chỉ còn `manifest.json`, `cover_bg.jpg`, `scene_001.jpg`, `scene_002.jpg` — không còn `*_c*.jpg` hay `*_thumb.jpg`.

- [ ] **Step 4: Chạy thử với reviewer tắt**

```bash
node -e 'const f="work/_scenes_test/manifest.json",m=JSON.parse(require("fs").readFileSync(f));m.reviewImages=false;require("fs").writeFileSync(f,JSON.stringify(m))'
rm -f work/_scenes_test/*.jpg
docker exec shadowing-n8n node /data/workflow/container/cli/fetch_scenes.js /data/workflow/work/_scenes_test \
  | node -e 'const o=JSON.parse(require("fs").readFileSync(0));console.log(o.reviewer,o.reviewCalls,JSON.stringify(o.scenes.map(s=>s.review)))'
```

Expected: `off 0 [{"pass":null,"skipped":"reviewer off","passScore":72},{"pass":null,"skipped":"reviewer off","passScore":72}]`

- [ ] **Step 5: Chạy thử với `stock.json` giả (kiểm đường stock + chống trùng)**

Cả hai câu và ảnh bìa nhận **cùng** danh sách stock; ảnh không được trùng giữa các cảnh.

```bash
node -e '
const f="work/_scenes_test/manifest.json",m=JSON.parse(require("fs").readFileSync(f));m.reviewImages=true;require("fs").writeFileSync(f,JSON.stringify(m));
' 
docker exec shadowing-n8n node -e '
(async () => {
  const r = await fetch("https://api.openverse.org/v1/images/?q=coffee%20shop&license=cc0&size=large&page_size=8", { headers: { "User-Agent": "shadowing-video/1.0" } });
  const list = (await r.json()).results.map((x) => ({ source: "pexels", id: x.id, url: x.url, photographer: x.creator, link: x.foreign_landing_url }));
  require("fs").writeFileSync("/data/workflow/work/_scenes_test/stock.json", JSON.stringify({ 0: list, 1: list, 2: list }));
})();'
rm -f work/_scenes_test/*.jpg
docker exec shadowing-n8n node /data/workflow/container/cli/fetch_scenes.js /data/workflow/work/_scenes_test \
  | node -e 'const o=JSON.parse(require("fs").readFileSync(0));const ids=[o.coverReview&&o.coverReview.id,...o.scenes.map(s=>s.id)];console.log(JSON.stringify(ids),new Set(ids).size===ids.length?"UNIQUE":"DUPLICATE")'
```

Expected: 3 id, dòng kết thúc bằng `UNIQUE`. (Ở đây dùng URL Openverse giả làm "pexels" chỉ để kiểm đường đọc `stock.json`.)

- [ ] **Step 6: Dọn và commit**

```bash
rm -rf work/_scenes_test
git add container/cli/fetch_scenes.js
git commit -m "feat(scenes): pick stock photos by Claude score instead of generating with SD"
```

---

### Task 4: Code node của workflow `shadowing`

**Files:**
- Modify: `container/nodes/shadowing/01_prepare_run.js`
- Modify: `container/nodes/shadowing/02_parse_normalize.js`
- Rename + rewrite: `container/nodes/shadowing/05_collect_pexels.js` → `05_collect_stock.js`
- Create: `container/nodes/shadowing/06_unsplash_downloads.js`
- Modify: `container/nodes/shadowing/03_build_srt.js`
- Modify: `container/nodes/shadowing/04_build_response.js`

**Interfaces:**
- Consumes: stdout của Fetch Scenes (Task 3).
- Produces:
  - `$('Prepare Run').first().json`: thêm `stockPath`, `passScore`, `imageSourceWarning`; bỏ `pexelsPath`; `imageSource ∈ {'auto','stock'}`.
  - manifest: thêm `passScore`, `coverQuery`; bỏ `coverPrompt`, `sentences[].imagePrompt`.
  - Item `idx 0` (intro) mang `imageQuery = coverQuery`.
  - Node `Collect Stock` đọc `$('Search Unsplash')`, `$input` (= Search Pexels), `$('Parse & Normalize').itemMatching(i)`; ghi `cfg.stockPath`.
  - Node `Unsplash Downloads` trả `[{json:{idx, downloadLocation}}]` hoặc `[]`.
  - Tên node phải khớp đúng Task 5: `Search Unsplash`, `Search Pexels`, `Collect Stock`, `Fetch Scenes`, `Unsplash Downloads`, `Track Unsplash Download`.

- [ ] **Step 1: Viết script kiểm cú pháp (fail trước)**

Code node có `return` ở top-level nên `node --check` không dùng được; bọc trong `Function`:

```bash
cat > work/_check_nodes.sh <<'EOF'
for f in container/nodes/shadowing/*.js; do
  node -e 'new Function(require("fs").readFileSync(process.argv[1],"utf8"))' "$f" \
    && echo "ok  $f" || echo "BAD $f"
done
ls container/nodes/shadowing/05_collect_stock.js container/nodes/shadowing/06_unsplash_downloads.js
EOF
sh work/_check_nodes.sh
```

Expected: các file hiện có `ok`; `ls` báo `No such file` cho hai file mới.

- [ ] **Step 2: `01_prepare_run.js`**

Thay dòng:

```js
    pexelsPath: `${workDir}/pexels.json`,
```

bằng:

```js
    stockPath: `${workDir}/stock.json`,
```

Thêm ngay **trước** `return [{` (sau khối `outputs`):

```js
// Scene pictures now come only from stock photo libraries. `ai` meant the local
// SD generator, which the pipeline no longer calls; it is still accepted so old
// callers keep working, and the run says it was ignored.
const imageSourceRaw = String(body.imageSource ?? 'auto').toLowerCase();
const imageSource = ['auto', 'stock'].includes(imageSourceRaw) ? imageSourceRaw : 'auto';
const imageSourceWarning = imageSourceRaw === 'ai'
  ? 'imageSource ai is no longer supported - stock photos were used'
  : null;
```

Thay toàn bộ khối từ `// Where scene pictures come from.` tới hết dòng `reviewImages: body.reviewImages !== false,` bằng:

```js
    // Kept for old callers; see imageSourceWarning above.
    imageSource,
    imageSourceWarning,
    // Claude scores every stock candidate 0-100 against its line (host/imagereview)
    // and the best one at or above this is used. Below it the best is still used
    // and recorded as a fail - a weak picture beats a hole in the video.
    passScore: Math.round(clamp(body.passScore, 0, 100, 72)),
    // Off by request only; a reviewer that is not running is skipped the same way,
    // and every scene then takes its first candidate that decodes.
    reviewImages: body.reviewImages !== false,
```

- [ ] **Step 3: `02_parse_normalize.js`**

Thay:

```js
  // Falls back to the keyword form, which is poor input for a generator but far
  // better than nothing when the model omits the field.
  const imagePrompt = String(row.imagePrompt ?? '').trim().slice(0, 200) || imageQuery;

  return { idx: i + 1, speaker, en, vi, imageQuery, imagePrompt, ttsText: normalizeForTts(en) };
```

bằng:

```js
  return { idx: i + 1, speaker, en, vi, imageQuery, ttsText: normalizeForTts(en) };
```

Thay:

```js
const coverPrompt = String(parsed.coverPrompt ?? '').trim().slice(0, 200)
  || `${cfg.topic}, wide establishing shot, no people`;
```

bằng:

```js
// Stock search for the title-card backdrop: the place, with nobody in it.
const coverQuery = String(parsed.coverQuery ?? '').trim().slice(0, 80) || cfg.topic;
```

Trong `JSON.stringify({ ... })` của manifest, thay:

```js
    imageSource: cfg.imageSource, reviewImages: cfg.reviewImages, caption, hashtags, coverPrompt, intro, sentences }, null, 2),
```

bằng:

```js
    imageSource: cfg.imageSource, reviewImages: cfg.reviewImages, passScore: cfg.passScore,
    caption, hashtags, coverQuery, intro, sentences }, null, 2),
```

Thay:

```js
  // `imageQuery` is carried only so the Pexels node downstream has a valid query
  // instead of an empty one; 05_collect_pexels.js throws the result away.
  items.unshift({
    json: {
      ...intro, isIntro: true, imageQuery: cfg.topic,
```

bằng:

```js
  // Item 0 doubles as the title card's slot in the stock search: its `imageQuery`
  // is the cover search, and 05_collect_stock.js files the results under idx 0.
  items.unshift({
    json: {
      ...intro, isIntro: true, imageQuery: coverQuery,
```

- [ ] **Step 4: `05_collect_stock.js`**

```bash
git mv container/nodes/shadowing/05_collect_pexels.js container/nodes/shadowing/05_collect_stock.js
```

Thay toàn bộ nội dung `05_collect_stock.js`:

```js
// Collects the Unsplash and Pexels search results into stock.json, which
// fetch_scenes.js reads as each scene's candidate list.
//
// The indirection exists so the API keys stay in the n8n credential store: the
// HTTP nodes hold the credentials, this node only ever sees what they returned,
// and the CLI script never touches a key at all.
//
// Both searches are optional. With no key, a bad key or an exhausted quota a
// search node passes its error through instead of failing, that library is just
// absent here, and fetch_scenes.js falls back to Openverse.
//
// Item 0 is the title card's slot: its query is the manifest's coverQuery.
const fs = require('fs');
const cfg = $('Prepare Run').first().json;

// Unsplash asks for these on every link back to a photographer or to Unsplash.
const UTM = 'utm_source=shadowing_video&utm_medium=referral';

function fromUnsplash(json) {
  return (json?.results ?? []).filter((p) => p?.urls?.raw).map((p) => ({
    source: 'unsplash',
    id: String(p.id),
    // raw plus an explicit width: `regular` is fixed at 1080, short of a 1920 frame.
    url: `${p.urls.raw}&w=1920&fm=jpg&q=80`,
    photographer: p.user?.name ?? null,
    link: p.user?.links?.html ? `${p.user.links.html}?${UTM}` : null,
    // Unsplash's API guidelines require a request to this for every photo used.
    downloadLocation: p.links?.download_location ?? null,
  }));
}

function fromPexels(json) {
  return (json?.photos ?? []).filter((p) => p?.src?.large2x || p?.src?.large).map((p) => ({
    source: 'pexels',
    id: String(p.id),
    // large2x is ~1880px wide: plenty for a 1920 frame, far smaller than original.
    url: p.src.large2x ?? p.src.large,
    photographer: p.photographer ?? null,
    link: p.url ?? null,
  }));
}

/** u1, p1, u2, p2 ... so the first batch Claude sees has both libraries in it. */
function interleave(a, b) {
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if (a[i]) out.push(a[i]);
    if (b[i]) out.push(b[i]);
  }
  return out;
}

const pexels = $input.all();
const unsplash = $('Search Unsplash').all();
const byIdx = {};
let unsplashHits = 0;
let pexelsHits = 0;
let failed = 0;

for (let i = 0; i < pexels.length; i += 1) {
  // The paired item, not .all()[i]: Keep Successful Audio drops sentences whose
  // TTS failed, so positions here do not line up with Parse & Normalize's.
  let idx;
  try {
    idx = $('Parse & Normalize').itemMatching(i)?.json?.idx;
  } catch {
    idx = undefined;
  }
  if (idx === undefined || idx === null) continue;

  const u = unsplash[i]?.json ?? {};
  const p = pexels[i]?.json ?? {};
  if (u.error) failed += 1;
  if (p.error) failed += 1;

  const fromU = u.error ? [] : fromUnsplash(u);
  const fromP = p.error ? [] : fromPexels(p);
  unsplashHits += fromU.length;
  pexelsHits += fromP.length;
  byIdx[idx] = interleave(fromU, fromP);
}

fs.writeFileSync(cfg.stockPath, JSON.stringify(byIdx), 'utf8');

if (failed) {
  console.log(`[shadowing] run ${cfg.runId}: ${failed} stock lookup(s) failed, those scenes lean on Openverse`);
}

return [{
  json: { stockPath: cfg.stockPath, unsplashHits, pexelsHits, failed },
}];
```

- [ ] **Step 5: `06_unsplash_downloads.js`**

```js
// Lists the Unsplash photos this run actually used, so the next node can report
// each one to Unsplash. Their API guidelines require that request for every
// photo an app uses; the HTTP node after this one holds the key.
//
// This sits on a side branch off Fetch Scenes, not on the main chain. Returning
// nothing ends the branch and touches nothing else - which is why "no Unsplash
// photo was used" is an empty list here rather than a placeholder item.
let chosen = [];
try {
  chosen = JSON.parse($('Fetch Scenes').first().json.stdout || '{}').unsplashChosen ?? [];
} catch {
  chosen = [];
}

return chosen
  .filter((c) => c?.downloadLocation)
  .map((c) => ({ json: { idx: c.idx, downloadLocation: c.downloadLocation } }));
```

- [ ] **Step 6: `03_build_srt.js`**

Thay:

```js
let coverReview = null;
let reviewer = null;
```

bằng:

```js
let coverReview = null;
let reviewer = null;
let passScore = null;
let reviewCalls = 0;
```

Thay:

```js
    reviewer = parsed.reviewer ?? null;
  }
```

bằng:

```js
    reviewer = parsed.reviewer ?? null;
    passScore = parsed.passScore ?? null;
    reviewCalls = parsed.reviewCalls ?? 0;
  }
```

Trong object `return [{ json: { ... } }]` ở cuối, thay:

```js
    coverReview,
    reviewer,
```

bằng:

```js
    coverReview,
    reviewer,
    passScore,
    reviewCalls,
```

- [ ] **Step 7: `04_build_response.js`**

Trong record (`fs.writeFileSync(keptRecord, ...)`), thay:

```js
    // Claude's verdict on the title-card backdrop; each scene carries its own.
    coverReview: srt.coverReview ?? null,
```

bằng:

```js
    // Claude's score for the title-card backdrop; each scene carries its own.
    coverReview: srt.coverReview ?? null,
    passScore: srt.passScore ?? cfg.passScore,
```

Trong response, thay toàn bộ khối `scenes: { ... },` (từ `scenes: {` tới dòng `redraws: ...` và `},` đóng) bằng:

```js
    scenes: {
      used: (srt.scenes ?? []).length,
      missing: srt.scenesMissing ?? [],
      // Only CC BY images oblige a credit line; cc0, Pexels and Unsplash do not.
      attributions: (srt.scenes ?? []).map((sc) => sc.attribution).filter(Boolean),
      // `off` means no reviewer answered, so every scene took its first candidate.
      reviewer: srt.reviewer ?? 'off',
      passScore: srt.passScore ?? cfg.passScore,
      reviewCalls: srt.reviewCalls ?? 0,
      passed: (srt.scenes ?? []).filter((sc) => sc.review?.pass === true).length,
      failed: (srt.scenes ?? []).filter((sc) => sc.review?.pass === false)
        .map((sc) => ({ idx: sc.idx, score: sc.review.score, missing: sc.review.missing })),
      sources: (srt.scenes ?? []).reduce((n, sc) => ({ ...n, [sc.source]: (n[sc.source] ?? 0) + 1 }), {}),
      credits: (srt.scenes ?? [])
        .filter((sc) => sc.source === 'unsplash' || sc.source === 'pexels')
        .map(({ idx, source, photographer, link }) => ({ idx, source, photographer, link })),
      imageSourceWarning: cfg.imageSourceWarning ?? null,
    },
```

- [ ] **Step 8: Chạy lại kiểm cú pháp + grep tàn dư**

```bash
sh work/_check_nodes.sh
rtk proxy grep -rn -E "pexelsPath|imagePrompt|coverPrompt|redraws|draws" container/nodes/shadowing/ ; echo "grep exit=$?"
```

Expected: mọi file `ok` (gồm `05_collect_stock.js`, `06_unsplash_downloads.js`); `ls` không báo lỗi; grep không in gì, `grep exit=1`.

- [ ] **Step 9: Commit**

```bash
rm -f work/_check_nodes.sh
git add container/nodes/shadowing/
git commit -m "feat(shadowing): collect Unsplash+Pexels candidates, carry passScore and coverQuery"
```

---

### Task 5: Workflow definition, credential, deploy, chạy end-to-end

**Files:**
- Modify: `host/workflows/shadowing.js`
- Modify: `host/workflows/shadowing-stub.js`
- Modify: `host/deploy.js:37-44`
- Modify: `.env` (thêm `CRED_UNSPLASH_ID`)

**Interfaces:**
- Consumes: tên file Code node từ Task 4 (`05_collect_stock.js`, `06_unsplash_downloads.js`), credential `credentials.unsplash`.
- Produces: workflow `shadowing` và `shadowing-stub` đã deploy với chuỗi
  `… Write Sentence Audio → Search Unsplash → Search Pexels → Collect Stock → Fetch Scenes → Fetch Music …`
  và nhánh phụ `Fetch Scenes → Unsplash Downloads → Track Unsplash Download`.

- [ ] **Step 1: ⛔ Cần người dùng — tạo credential Unsplash**

Việc này cần tài khoản của người dùng, agent **không tự làm được**. Dừng và nhờ người dùng:

1. Đăng ký app tại https://unsplash.com/oauth/applications → lấy **Access Key**.
2. Mở http://localhost:5678 → Credentials → *Add credential* → **Header Auth**:
   - Credential name: `Unsplash API`
   - Name: `Authorization`
   - Value: `Client-ID <Access Key>`
3. Lấy id từ URL trang credential (`…/credentials/<id>`), thêm vào `.env`:
   ```
   CRED_UNSPLASH_ID=<id>
   ```

Kiểm (không in giá trị): `grep -c '^CRED_UNSPLASH_ID=.\+' .env` → Expected `1`.

- [ ] **Step 2: `host/deploy.js`**

Thay:

```js
  const env = requireEnv(loadEnv(), 'CRED_GROQ_ID', 'CRED_EDGETTS_ID', 'CRED_PEXELS_ID',
    'CRED_AWS_ID', 'CRED_BUFFER_ID');
```

bằng:

```js
  const env = requireEnv(loadEnv(), 'CRED_GROQ_ID', 'CRED_EDGETTS_ID', 'CRED_PEXELS_ID',
    'CRED_UNSPLASH_ID', 'CRED_AWS_ID', 'CRED_BUFFER_ID');
```

Thay:

```js
    pexels: { id: env.CRED_PEXELS_ID, name: 'Pexels API' },
```

bằng:

```js
    pexels: { id: env.CRED_PEXELS_ID, name: 'Pexels API' },
    unsplash: { id: env.CRED_UNSPLASH_ID, name: 'Unsplash API' },
```

- [ ] **Step 3: Groq prompt trong `host/workflows/shadowing.js`**

Thay:

```js
  '{"caption":"<TikTok caption>","hashtags":["tag","tag"],"coverPrompt":"<establishing shot>",'
  + '"sentences":[{"speaker":"A","en":"<one English line>","vi":"<natural Vietnamese translation>",'
  + '"imageQuery":"<2-4 word stock photo search>","imagePrompt":"<one descriptive sentence>"}]}',
```

bằng:

```js
  '{"caption":"<TikTok caption>","hashtags":["tag","tag"],"coverQuery":"<2-4 word stock photo search>",'
  + '"sentences":[{"speaker":"A","en":"<one English line>","vi":"<natural Vietnamese translation>",'
  + '"imageQuery":"<2-4 word stock photo search>"}]}',
```

Xoá **mọi dòng** từ dòng ngay sau

```js
  '  Never abstract ideas, never names, never words like "conversation" or "person talking".',
```

tới và **gồm** dòng

```js
  '  Never a group, never a crowd, never a posed headshot, never a close-up face.',
```

(tức toàn bộ phần comment + luật `imagePrompt` và `coverPrompt`), và chèn vào đúng chỗ đó:

```js
  // Backdrop for the title card. A place with nobody in it: the channel name and
  // the topic are printed across the middle, and a figure behind that text
  // fights with it. Claude also scores the cover candidates for a calm centre.
  '- `coverQuery` is what a stock photo library is searched for to find ONE wide',
  '  shot of the place this conversation happens in. 2-4 words naming the place,',
  '  e.g. "empty train platform", "coffee shop interior".',
```

Kiểm: `rtk proxy grep -n -E "imagePrompt|coverPrompt|A girl|A boy" host/workflows/shadowing.js; echo "exit=$?"` → Expected không in gì, `exit=1`.

- [ ] **Step 4: Chuỗi node trong `host/workflows/shadowing.js`**

Thay `CHAIN`:

```js
const CHAIN = ['Webhook', 'Prepare Run', 'Generate Dialogue', 'Parse & Normalize',
  'Synthesize Speech', 'Keep Successful Audio', 'Write Sentence Audio',
  'Search Unsplash', 'Search Pexels', 'Collect Stock', 'Fetch Scenes', 'Fetch Music',
  'Probe Durations', 'Build SRT', 'Assemble Video', 'Build Response', 'Respond to Webhook'];
```

Ngay **trước** node `id: 'n-pexels'`, chèn node:

```js
    {
      id: 'n-unsplash',
      name: 'Search Unsplash',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.5,
      position: at('Search Unsplash'),
      // Optional like Pexels: with no key, a bad key or the demo tier's 50/hour
      // spent, this passes the error through and the scene leans on the others.
      onError: 'continueRegularOutput',
      retryOnFail: true,
      maxTries: 2,
      waitBetweenTries: 1000,
      parameters: {
        method: 'GET',
        url: 'https://api.unsplash.com/search/photos',
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendQuery: true,
        specifyQuery: 'keypair',
        queryParameters: {
          parameters: [
            { name: 'query', value: "={{ $('Parse & Normalize').item.json.imageQuery }}" },
            { name: 'per_page', value: '6' },
            { name: 'orientation', value: 'landscape' },
            { name: 'content_filter', value: 'high' },
          ],
        },
        sendHeaders: true,
        specifyHeaders: 'keypair',
        headerParameters: { parameters: [{ name: 'Accept-Version', value: 'v1' }] },
        options: { timeout: 20000 },
      },
      credentials: { httpHeaderAuth: credentials.unsplash },
    },
```

Trong node `Search Pexels`, đổi `{ name: 'per_page', value: '3' }` thành `{ name: 'per_page', value: '6' }`, và đổi comment phía trên `onError` thành:

```js
      // Optional by design: with no key, a bad key or an exhausted quota this
      // passes the error through and the scene leans on Unsplash and Openverse.
```

Thay node `Collect Pexels`:

```js
    {
      id: 'n-pexels-collect',
      name: 'Collect Pexels',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: at('Collect Pexels'),
      parameters: { mode: 'runOnceForAllItems', jsCode: nodeCode('05_collect_pexels.js') },
    },
```

bằng:

```js
    {
      id: 'n-stock-collect',
      name: 'Collect Stock',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: at('Collect Stock'),
      parameters: { mode: 'runOnceForAllItems', jsCode: nodeCode('05_collect_stock.js') },
    },
```

Ngay **sau** node `id: 'n-scenes'` (Fetch Scenes), chèn hai node nhánh phụ:

```js
    // Side branch, below the main chain on purpose: see 06_unsplash_downloads.js.
    // executionOrder v1 runs the upper branch to the end first, so this reports
    // downloads after the webhook has answered and can never hold up a video.
    {
      id: 'n-unsplash-list',
      name: 'Unsplash Downloads',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [at('Fetch Scenes')[0] + 220, 220],
      parameters: { mode: 'runOnceForAllItems', jsCode: nodeCode('06_unsplash_downloads.js') },
    },
    {
      id: 'n-unsplash-track',
      name: 'Track Unsplash Download',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.5,
      position: [at('Fetch Scenes')[0] + 440, 220],
      onError: 'continueRegularOutput',
      parameters: {
        method: 'GET',
        url: '={{ $json.downloadLocation }}',
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        options: { timeout: 15000 },
      },
      credentials: { httpHeaderAuth: credentials.unsplash },
    },
```

Thay phần `return { ... connections: linearConnections(CHAIN), ... }`:

```js
  const connections = linearConnections(CHAIN);
  connections['Fetch Scenes'].main[0].push({ node: 'Unsplash Downloads', type: 'main', index: 0 });
  connections['Unsplash Downloads'] = { main: [[{ node: 'Track Unsplash Download', type: 'main', index: 0 }]] };

  return {
    name: 'AI Shadowing Video Generator',
    slug: 'shadowing',
    webhookPath: 'shadowing',
    nodes,
    connections,
    settings: { executionOrder: 'v1', saveManualExecutions: true, timezone: 'Asia/Ho_Chi_Minh' },
  };
```

- [ ] **Step 5: `host/workflows/shadowing-stub.js`**

Trong `CANNED`, thêm ngay sau dòng `hashtags: [...]`:

```js
  coverQuery: 'coffee shop interior',
```

- [ ] **Step 6: Kiểm definition offline**

```bash
node -e '
const { definition } = require("./host/workflows/shadowing-stub");
const d = definition({ credentials: new Proxy({}, { get: (_, k) => ({ id: "x", name: String(k) }) }) });
const names = new Set(d.nodes.map((n) => n.name));
const dangling = Object.entries(d.connections).flatMap(([from, c]) => [from, ...c.main[0].map((x) => x.node)]).filter((n) => !names.has(n));
console.log("nodes", d.nodes.length, "dangling", JSON.stringify(dangling));
console.log("fetch scenes ->", d.connections["Fetch Scenes"].main[0].map((x) => x.node).join(", "));
'
```

Expected: `dangling []`, và `fetch scenes -> Fetch Music, Unsplash Downloads`.

- [ ] **Step 7: Deploy**

```bash
node host/deploy.js shadowing shadowing-stub
```

Expected: cả hai workflow `updated` + activated, không lỗi `CRED_UNSPLASH_ID`.

- [ ] **Step 8: Run stub (không tốn Groq)**

Reviewer phải đang chạy (`curl -s localhost:7861/health`).

```bash
curl -s -X POST http://localhost:5678/webhook/shadowing-stub \
  -H 'Content-Type: application/json' -d '{"topic":"ordering coffee","keepWorkDir":true}' \
  | tee work/_stub.json | node -e 'const o=JSON.parse(require("fs").readFileSync(0));console.log(o.ok,o.runId,JSON.stringify(o.scenes))'
```

Expected:
- `true <runId>`; `scenes.used` = 6, `reviewer:"up"`, `passScore:72`, `reviewCalls` ≥ 7, `sources` có `unsplash` và/hoặc `pexels`, `credits` không rỗng.

Rồi kiểm sâu hơn:

```bash
RUN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("work/_stub.json")).runId)')
node -e '
const s=JSON.parse(require("fs").readFileSync(`work/${process.argv[1]}/stock.json`));
console.log("stock idx", Object.keys(s).join(","), "sizes", Object.values(s).map(a=>a.length).join(","));
' "$RUN"
node -e '
const r=JSON.parse(require("fs").readFileSync(`output/${process.argv[1]}.json`));
const ids=[r.coverReview&&`${r.coverReview.source}:${r.coverReview.id}`,...r.scenes.map(s=>`${s.source}:${s.id}`)];
console.log("cover", r.coverReview&&r.coverReview.score, "unique", new Set(ids).size===ids.length);
console.log(r.scenes.map(s=>`${s.idx} ${s.source} ${s.review.score} ${s.review.pass}`).join("\n"));
' "$RUN"
node host/inspect-execution.js | grep -E "Unsplash|Collect Stock"
```

Expected:
- `stock idx 0,1,2,3,4,5,6` — có **idx 0** (ảnh bìa) — mỗi idx có tối đa 12 phần tử.
- `cover <số>`, `unique true`.
- 6 dòng cảnh, mỗi dòng có điểm số.
- `Track Unsplash Download` có trong execution và đã chạy (lỗi ở node này chấp nhận được nhưng phải ghi lại).

Nếu `stock idx` thiếu số hoặc lệch câu (vd idx 1 mang kết quả của câu 2): `itemMatching` không giải đúng paired item qua hai node HTTP — dừng lại và báo, đừng đổi sang `.all()[i]`.

- [ ] **Step 9: Xem video**

Mở `output/<runId>.mp4` (vd `open output/$RUN.mp4`), xem lướt: title card có ảnh nền là ảnh thật, 6 cảnh là ảnh chụp liên quan câu thoại, không cảnh nào trùng.

- [ ] **Step 10: Run với `reviewImages:false` và với reviewer tắt**

```bash
curl -s -X POST http://localhost:5678/webhook/shadowing-stub -H 'Content-Type: application/json' \
  -d '{"topic":"ordering coffee","reviewImages":false}' \
  | node -e 'const o=JSON.parse(require("fs").readFileSync(0));console.log(o.ok,o.scenes.reviewer,o.scenes.reviewCalls,o.scenes.used)'
launchctl unload ~/Library/LaunchAgents/com.shawnspace.imagereview.plist
curl -s -X POST http://localhost:5678/webhook/shadowing-stub -H 'Content-Type: application/json' \
  -d '{"topic":"ordering coffee"}' \
  | node -e 'const o=JSON.parse(require("fs").readFileSync(0));console.log(o.ok,o.scenes.reviewer,o.scenes.reviewCalls,o.scenes.used)'
launchctl load ~/Library/LaunchAgents/com.shawnspace.imagereview.plist
```

Expected cả hai dòng: `true off 0 6`.

- [ ] **Step 11: Run thật + verify-sync**

```bash
curl -s -X POST http://localhost:5678/webhook/shadowing \
  -H 'Content-Type: application/json' -d '{"topic":"asking for directions","sentenceCount":6}' \
  | node -e 'const o=JSON.parse(require("fs").readFileSync(0));console.log(o.ok,o.runId,JSON.stringify({passed:o.scenes.passed,failed:o.scenes.failed,sources:o.scenes.sources}))'
node host/verify-sync.js; echo "verify exit=$?"
```

Expected: `true <runId> {...}` (Groq thật sinh `coverQuery`); `verify exit=0`.

- [ ] **Step 12: Dọn và commit**

```bash
rm -rf "work/$RUN" work/_stub.json
git add host/workflows/shadowing.js host/workflows/shadowing-stub.js host/deploy.js
git commit -m "feat(shadowing): search Unsplash, report Unsplash downloads, drop SD image prompts"
```

(`.env` gitignored — không commit.)

---

### Task 6: Tài liệu

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs.md`

**Interfaces:**
- Consumes: hành vi đã triển khai ở Task 1–5.

- [ ] **Step 1: `CLAUDE.md` — bảng runtime và cây thư mục**

Trong bảng runtime, thay hai dòng:

```
| `host/imagegen/` | macOS, **Python qua `uv`**, GPU Metal | torch + diffusers |
| `host/imagereview/` | macOS, Node, gọi CLI `claude` đã đăng nhập | `claude -p` |
```

bằng:

```
| `host/imagegen/` | ⚠ **không còn trong pipeline** (2026-10-10) — macOS, Python qua `uv` | torch + diffusers |
| `host/imagereview/` | macOS, Node, gọi CLI `claude` đã đăng nhập | `claude -p` |
```

Trong cây thư mục:
- dòng `imagegen/` → `│   ├── imagegen/             ← ⚠ KHÔNG CÒN DÙNG (ảnh giờ lấy từ stock), giữ để tham khảo`
- dòng `imagereview/` → `│   ├── imagereview/          ← Claude chấm điểm ảnh stock theo lô, HTTP 127.0.0.1:7861`
- dưới `container/cli/`, thêm `│   │   ├── lib/pick_best.js  ← chọn ảnh theo điểm (+ pick_best.test.js, chạy trên host)`
- `05_collect_pexels.js` → `05_collect_stock.js`; thêm dòng `06_unsplash_downloads.js` ngay dưới.

- [ ] **Step 2: `CLAUDE.md` — lệnh thường dùng**

Thay khối:

```bash
# sinh ảnh cảnh bằng model local (tuỳ chọn; không bật thì tự dùng ảnh stock)
host/imagegen/run.sh &              # lần đầu tải ~5.7 GB, nạp model ~80s
curl -s localhost:7860/health
#   imageSource: auto (mặc định) | ai (bắt buộc có generator) | stock

# Claude review ảnh cảnh (tuỳ chọn; không bật thì ảnh không được review)
node host/imagereview/server.js &   # dùng `claude` đã đăng nhập, cổng 127.0.0.1:7861
curl -s localhost:7861/health
#   reviewImages: true (mặc định) | false
```

bằng:

```bash
# Claude chấm ảnh stock (tuỳ chọn; không bật thì mỗi cảnh lấy ứng viên đầu tiên)
node host/imagereview/server.js &   # dùng `claude` đã đăng nhập, cổng 127.0.0.1:7861
curl -s localhost:7861/health
node host/imagereview/check.js      # kiểm thang điểm sau mỗi lần sửa prompt/model
#   reviewImages: true (mặc định) | false
#   passScore: 72 (mặc định) — ảnh cao nhất ≥ ngưỡng được dùng; không đạt vẫn dùng, ghi FAIL

node --test container/cli/lib/*.test.js      # test logic chọn ảnh
```

- [ ] **Step 3: `CLAUDE.md` — mục chạy tự động**

Thay đoạn từ `**Generator ảnh cũng phải chạy lúc 18:00**` tới hết khối lệnh `launchctl load ~/Library/LaunchAgents/com.shawnspace.imagegen.plist` bằng:

~~~markdown
**Generator ảnh không còn dùng** (2026-10-10). Nếu LaunchAgent cũ còn nạp thì gỡ
để khỏi chiếm ~3 GB RAM vô ích:

```bash
launchctl unload ~/Library/LaunchAgents/com.shawnspace.imagegen.plist
rm ~/Library/LaunchAgents/com.shawnspace.imagegen.plist
```
~~~

Đoạn ngay sau, `**Reviewer cũng vậy**, không thì mọi cảnh ra bản vẽ đầu tiên, không ai kiểm:` → đổi thành `**Reviewer phải chạy lúc 18:00**, không thì mọi cảnh lấy ứng viên đầu tiên, không ai chấm:`.

- [ ] **Step 4: `CLAUDE.md` — secret / env**

Trong đoạn `.env còn giữ **id** của credential (...)`, thêm `CRED_UNSPLASH_ID` vào danh sách. Ngay dưới, thêm:

```markdown
**Unsplash** là credential `httpHeaderAuth`: name `Authorization`, value
`Client-ID <access key>`. Bản demo 50 request/giờ — một run ~7–9 request. API
guidelines của họ bắt gọi `download_location` cho mỗi ảnh dùng; nhánh phụ
`Unsplash Downloads → Track Unsplash Download` sau `Fetch Scenes` làm việc đó.
```

- [ ] **Step 5: `CLAUDE.md` — mục SD và mục review**

Ngay dưới tiêu đề `### Sinh ảnh cảnh bằng SD 1.5 (chạy trên host)`, chèn:

```markdown
> ⚠ **Lịch sử — không còn trong pipeline từ 2026-10-10.** Ảnh cảnh giờ lấy từ
> Unsplash/Pexels/Openverse và được Claude chấm điểm (mục kế tiếp). Phần dưới giữ
> lại vì các con số đo được vẫn đúng nếu có ngày quay lại sinh ảnh.
```

Thay **toàn bộ** mục `### Claude review ảnh cảnh (`host/imagereview/`)` (từ tiêu đề tới ngay trước `### Gọi API ảnh bên ngoài`) bằng:

```markdown
### Claude chấm ảnh stock (`host/imagereview/`)

Tìm ảnh stock khớp **từ khoá**, không khớp **câu**: tìm siro cho câu gọi cà phê ra
siro trên bánh pancake, decode hoàn hảo. Nên mỗi cảnh có tới 8 ứng viên
(Unsplash/Pexels xen kẽ từ `stock.json`, rồi Openverse), Claude chấm **0–100** từng
ảnh theo lô 4, và `fetch_scenes.js` dùng ảnh cao nhất **≥ `passScore`** (mặc định
**72**). Lô 1 không có ảnh đạt thì chấm lô 2; vẫn không đạt thì **vẫn dùng ảnh cao
nhất** và ghi `pass:false` — ảnh yếu hơn lỗ trong video. Không ảnh nào dùng hai lần
trong một video (`candidateKey` + `used` trong `pickBest`).

- **Server chỉ chấm, không quyết.** Ngưỡng nằm ở `fetch_scenes.js`/`passScore`, nên
  đổi ngưỡng không đụng prompt. Thang điểm có mốc nằm trong `SYSTEM_PROMPT` (90+ đủ
  hết; 72–89 đúng bối cảnh + đồ vật chính; 50–71 thiếu đồ vật chính…).
- **`node host/imagereview/check.js`** gửi lô fixture (2 ảnh đúng, 2 ảnh sai) và đòi
  ≥72 / <50. Chạy sau **mọi** lần sửa prompt hoặc đổi model — con số 72 chỉ có
  nghĩa khi phép kiểm này còn qua. Ảnh fixture sai thì thay ảnh, đừng hạ ngưỡng.
- **Lô 4 ảnh, thumb 768 px.** Thấy các ảnh cạnh nhau thì điểm nhất quán hơn chấm
  từng ảnh, và chỉ tốn ¼ số lần gọi. Ảnh 1920 px không chấm chính xác hơn.
- **Chạy trên host, gọi `claude -p`** — không phải API key. Ảnh đi inline qua
  stream-json, `--tools ""`, `--json-schema`, `--system-prompt` riêng, `cwd` ngoài
  repo — để không trả tiền cho prompt mặc định và `CLAUDE.md` này trên mỗi lần gọi.
- **`--bare` không dùng được**: nó bắt buộc `ANTHROPIC_API_KEY`, bỏ qua đăng nhập OAuth.
- **Bind `127.0.0.1`.** Docker Desktop vẫn route `host.docker.internal` tới loopback.
- **`REVIEW_BUDGET_MS` = 180 s** — sau đó không gửi lô mới. Ảnh bìa xếp **đầu tiên**
  vì nó là bìa trên lưới profile.
- Reviewer chết / timeout / thiếu điểm cho một ảnh → cảnh đó lấy ứng viên đầu
  tiên decode được. Review làm ảnh đẹp hơn, **không bao giờ được làm mất video**.
- **Người trong ảnh stock là người lạ.** Không còn kiểm nhân vật A/B; bản sắc nhân
  vật cố định đã bỏ cùng với SD.
- **Ảnh bìa dùng slot `idx 0`** — item câu thương hiệu vốn đã đi qua node search;
  query của nó là `coverQuery` Groq sinh ra.
```

- [ ] **Step 6: `docs.md`**

Ngay dưới dòng tiêu đề `### 13. ~~Chất lượng ảnh sụt mạnh tuỳ chủ đề~~ ✅ ĐÃ CHỮA bằng SD 1.5 local (2026-10-04)`, chèn:

```markdown
> **Cập nhật 2026-10-10:** bỏ SD, quay về ảnh stock nhưng có **Claude chấm điểm**
> (Unsplash + Pexels + Openverse, lô 4 ảnh, ngưỡng 72). Vấn đề gốc của #13 — ảnh
> stock lệch câu — giờ được bắt bằng điểm thay vì bằng máy vẽ; cảnh không đạt
> vẫn dùng ảnh tốt nhất và ghi `pass:false` trong record. Xem CLAUDE.md, "Claude
> chấm ảnh stock".
```

Ngay trước mục `### Trang kết cuối video ✅ (2026-10-05)`, chèn:

```markdown
### Ảnh stock + Claude chấm điểm ✅ (2026-10-10)

Thay SD bằng ảnh Unsplash/Pexels/Openverse. Claude chấm 0–100 theo lô 4, dùng ảnh
cao nhất ≥ 72, không đạt thì vẫn dùng ảnh cao nhất và ghi FAIL. Không ảnh nào lặp
trong một video. Ảnh bìa tìm bằng `coverQuery` qua slot `idx 0`. Spec:
`docs/superpowers/specs/2026-10-10-stock-images-claude-review-design.md`.
```

- [ ] **Step 7: Kiểm tàn dư trong docs**

```bash
rtk proxy grep -n -E "imageSource: auto \(mặc định\) \| ai|05_collect_pexels|bản vẽ đầu tiên" CLAUDE.md docs.md; echo "exit=$?"
```

Expected: không in gì, `exit=1`.

- [ ] **Step 8: Commit**

```bash
git add CLAUDE.md docs.md
git commit -m "docs: stock photos scored by Claude replace SD scene generation"
```
