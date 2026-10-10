# Bổ sung topic bằng Claude, giữ 10 video gần nhất, tách pool / state

- Ngày: 2026-10-10
- Phạm vi: `data/workflow/` — workflow `daily`, `topics.json`, server Claude trên host
- Trạng thái: đã duyệt thiết kế, chờ kế hoạch triển khai

## 1. Mục tiêu

1. Sau mỗi lần `daily` dựng video, `output/` chỉ giữ **10 run gần nhất**.
2. Khi **≥ 90%** topic trong pool đã được dùng ít nhất một lần, `daily` gọi Claude
   chạy trên host để **thêm** topic mới (mặc định 30).
3. Tách `topics.json` thành phần người sửa (`topics/pool.json`, trong git) và trạng
   thái workflow ghi (`topics/state.json`, gitignored).

Không đạt mục tiêu:
- Claude không sửa / xoá topic có sẵn.
- Không gộp hay đổi tên service trên host (vẫn là `host/imagereview/`, cổng 7861).
- Không đổi logic dựng video hay đăng Buffer.

## 2. Quyết định đã chốt

| Câu hỏi | Quyết định |
|---|---|
| "Cấu trúc dễ maintain" | Cấu trúc dữ liệu topic (không tái cấu trúc service) |
| Claude được làm gì với pool | Chỉ thêm mới |
| Định dạng | Tách `topics/pool.json` (git) + `topics/state.json` (gitignored) |
| "Đã dùng 90%" | số topic trong pool có trong `state.used` / tổng pool ≥ `threshold` |
| Nơi gọi Claude | Route `POST /topics` trên server host sẵn có (:7861) |
| Logic topic có test | Hàm thuần trong `container/nodes/daily/lib/topics.js`, nhúng vào Code node lúc deploy |
| Chạy thử không đăng bài | Webhook riêng `daily-dry-run`, luôn bỏ qua bước đăng |

## 3. Dữ liệu

### 3.1 `topics/pool.json` (trong git)

```json
{
  "_comment": "Topic pool for the daily run. Edit freely. Claude appends to `topics` when most of it has been used; review its additions in git diff.",
  "refill": { "threshold": 0.9, "batch": 30 },
  "topics": [
    { "topic": "ordering breakfast at a small cafe", "addedAt": "2026-10-10", "source": "manual" }
  ]
}
```

- `source`: `"manual"` | `"claude"`.
- `addedAt`: `YYYY-MM-DD` (giờ ICT).
- `refill.threshold` ∈ (0, 1], `refill.batch` ∈ [1, 100]; thiếu / sai → 0.9 / 30.

### 3.2 `topics/state.json` (gitignored)

```json
{
  "used": { "ordering breakfast at a small cafe": { "count": 1, "lastAt": "2026-10-04T01:00:00.000Z" } },
  "history": [ { "topic": "…", "runId": "…", "at": "…", "postsAt": "…", "published": true, "postId": "…", "error": null, "dryRun": false } ],
  "refills": [ { "at": "…", "before": 124, "added": 30, "rejected": 2, "error": null } ]
}
```

- Khoá của `used` là chuỗi topic **nguyên văn** như trong pool.
- `history`: newest-first, giới hạn 200 (giữ như hiện tại), chỉ để tra cứu.
- `refills`: newest-first, giới hạn 50.
- File thiếu → coi như `{used:{}, history:[], refills:[]}`.
- Mọi lần ghi: atomic (`.tmp` + `rename`).

### 3.3 Migration một lần — `host/migrate-topics.js`

- Đọc `topics.json` (bản làm việc hiện tại, gồm cả history chưa commit).
- Ghi `topics/pool.json`: mọi chuỗi trong `pool` → `{topic, addedAt: <hôm nay ICT>, source: "manual"}`,
  bỏ trùng; `refill` mặc định; `_comment` như 3.1.
- Ghi `topics/state.json`: `history` giữ nguyên (thêm `dryRun:false`); `used` dựng
  từ `history` — `count` = số lần xuất hiện, `lastAt` = `at` mới nhất; `refills: []`.
- Từ chối chạy nếu `topics/pool.json` hoặc `topics/state.json` đã tồn tại.
- In tóm tắt: số topic, số mục history, số topic đã dùng.
- Sau khi chạy: `git rm topics.json`, thêm `topics/state.json` vào `.gitignore`.

## 4. Logic dùng chung — `container/nodes/daily/lib/topics.js`

Hàm thuần, không I/O, test bằng `node --test` trên host:

- `normalizeTopic(s) => string` — chữ thường, bỏ ký tự không phải chữ/số/khoảng
  trắng, gộp khoảng trắng, trim. Dùng để so trùng.
- `pickTopic(topics: string[], used: object, random = Math.random) => {topic, fresh: number}`
  — topic chưa có trong `used` được ưu tiên, chọn ngẫu nhiên trong nhóm đó; hết thì
  chọn topic có `used[t].lastAt` nhỏ nhất (hoà → topic đứng trước). `fresh` = số
  topic chưa dùng.
- `usageRatio(topics: string[], used: object) => number` — số topic có trong `used`
  / `topics.length` (pool rỗng → 1).
- `recordUse(state, entry) => state` — trả state mới: `used[topic].count += 1`,
  `lastAt = entry.at`, `history` thêm đầu và cắt 200.
- `mergeTopics(pool, candidates: string[], {batch, today}) => {pool, added: string[], rejected: string[]}`
  — loại ứng viên không phải chuỗi, < 3 hoặc > 12 từ, trùng (theo `normalizeTopic`)
  với pool hoặc với ứng viên trước đó; giữ tối đa `batch`; nối vào `pool.topics` dạng
  `{topic: <trim, chữ thường>, addedAt: today, source: "claude"}`.

**Nhúng vào Code node.** Code node không `require` được file dự án. File kết thúc
bằng dòng đánh dấu `// --- exports (stripped when embedded) ---` rồi
`module.exports = {...}`. `host/workflows/daily.js` có `nodeCodeWithLib(file)`: đọc
`lib/topics.js`, cắt từ dòng đánh dấu trở đi, nối trước nội dung Code node. Một bản
cài đặt, test được, không chép tay.

## 5. Workflow `daily`

### 5.1 Chuỗi node

```
Twice Daily ──┐
Dry Run Hook ─┴→ Pick Topic → Build Video → Built? ─┬→ Publish To Buffer → Record Run
                                                    └────────────────────→ Record Run
Record Run → Prune Output → Check Topics → Topics Low? ─true→ Refill Topics → Merge Topics
```

- **Dry Run Hook** (mới): Webhook `POST /webhook/daily-dry-run`,
  `responseMode: onReceived` (trả ngay; dựng mất vài phút). Không nhận tham số —
  luôn là dry run.
- **Pick Topic** (`01_pick_topic.js`): đọc `pool.json` + `state.json`, gọi `pickTopic`;
  `dryRun = $input.first().json.body !== undefined` (chỉ webhook có `body`; schedule
  trigger thì không). Trả thêm `dryRun`. Pool rỗng → throw (giữ như cũ, không dấu hai chấm).
- **Built?**: điều kiện thành `ok === true && !!runId && !$('Pick Topic').first().json.dryRun`.
  Nhánh false (build hỏng **hoặc** dry run) đi thẳng Record Run.
- **Record Run** (`02_record_run.js`): `recordUse` vào `state.json`; entry có `dryRun`;
  dry run → `published:false`, `error:"dry run"`. Vẫn tính là đã dùng topic (video
  đã dựng — cùng lý lẽ hiện có trong file).
- **Prune Output** (mới, Execute Command):
  `node /data/workflow/container/cli/prune_output.js /data/workflow/output 10`.
  `KEEP_RUNS = 10` là hằng số trong `host/workflows/daily.js`.
- **Check Topics** (mới, `03_check_topics.js`): đọc pool + state, trả
  `{need, ratio, threshold, batch, existing: string[], recent: string[30]}`;
  `recent` = 30 topic mới nhất trong `history`.
- **Topics Low?** (mới, IF): `need === true`. Nhánh false không nối gì.
- **Refill Topics** (mới, HTTP): `POST http://host.docker.internal:7861/topics`,
  body `{existing, recent, count: batch}`, timeout 180 000, `onError: continueRegularOutput`.
- **Merge Topics** (mới, `04_merge_topics.js`): nếu response có `error` hoặc không có
  mảng `topics` → không ghi pool, ghi `refills` với `error`. Ngược lại `mergeTopics`,
  ghi pool (atomic) rồi ghi `refills`. Trả `{added, rejected, ratioBefore}`.

Vị trí node: theo thứ tự chuỗi như hiện tại (`at()`); Dry Run Hook đặt ngay dưới
Twice Daily.

### 5.2 Prune — `container/cli/prune_output.js <outputDir> <keep>`

- Nhóm file theo runId = tiền tố khớp `^\d{14}_[a-z0-9]{6}` (mọi đuôi: `.mp4`,
  `_portrait.mp4`, `_landscape.mp4`, `.srt`, `.json`, `_caption.txt`, `_cover*.jpg`).
- Sắp runId giảm dần (tiền tố là timestamp → sắp chuỗi = sắp thời gian).
- Giữ `keep` run đầu, xoá mọi file của run còn lại. File không khớp mẫu: không đụng.
- stdout một dòng JSON `{kept: number, removed: string[], files: number}`.
- Lỗi xoá từng file → stderr, tiếp tục; luôn exit 0 trừ khi argv sai (exit 1).
- `keep` không phải số nguyên ≥ 1 → exit 1.

## 6. Route `/topics` trên `host/imagereview/server.js`

- Tách phần spawn `claude -p` thành `host/imagereview/claude.js`:
  `askClaude({ systemPrompt, schema, content, timeoutMs }) => Promise<{output, ms}>`
  (content = mảng block của user message). `/review` dùng lại, hành vi không đổi.
- `POST /topics` body `{existing: string[], recent: string[], count: 1..100}`;
  sai → 400.
- Schema: `{topics: string[]}`. Trả `{topics, model, ms}`; Claude lỗi → 503.
- Dùng chung semaphore `MAX_CONCURRENT` với `/review`.
- Timeout gọi Claude cho `/topics`: 150 000 ms.
- System prompt: mỗi topic là **một tình huống hằng ngày cụ thể giữa hai người** cho
  người Việt học tiếng Anh giao tiếp; tiếng Anh, chữ thường, 3–10 từ, cùng kiểu với
  `existing` (vd "asking about a warranty"); có **bối cảnh chụp ảnh được** (quán, phòng
  khám, sân bay, văn phòng…) vì ảnh cảnh lấy từ kho stock; trải đều các mảng (ăn
  uống, đi lại, công việc, sức khoẻ, mua sắm, nhà ở, ngân hàng, giải trí…); không
  trùng hay diễn đạt lại bất kỳ topic nào trong `existing`; ưu tiên mảng mà `recent`
  ít đụng tới; trả đúng `count` topic.

## 7. Xử lý lỗi

| Tình huống | Hành vi |
|---|---|
| `state.json` thiếu / hỏng JSON | Pick Topic coi như rỗng; Record Run ghi mới (hỏng → ghi đè, log lý do) |
| `pool.json` thiếu / rỗng | Pick Topic throw — run dừng trước khi dựng (như cũ) |
| Prune lỗi | Log, exit 0 — chuỗi tiếp tục |
| Server Claude tắt / timeout / 503 | Merge Topics ghi `refills[].error`; pool không đổi; lần chạy sau thử lại |
| Claude trả topic trùng / sai dạng | Bị `mergeTopics` loại, đếm vào `rejected` |
| Claude trả 0 topic hợp lệ | `added: 0` ghi vào `refills`; lần sau thử lại |

Mọi `throw` mới trong `container/nodes/**` không có dấu hai chấm.

## 8. Kiểm thử

1. `container/nodes/daily/lib/topics.test.js` (`node --test`): `normalizeTopic`;
   `pickTopic` ưu tiên chưa dùng, hết thì `lastAt` cũ nhất, hoà giữ thứ tự;
   `usageRatio` (bỏ qua topic trong `used` đã bị xoá khỏi pool; pool rỗng = 1);
   `recordUse` (count, lastAt, cắt 200); `mergeTopics` (trùng pool, trùng trong lô,
   độ dài, `batch`, định dạng phần tử).
2. `container/cli/prune_output.test.js` (`node --test`, spawn script trên thư mục
   tạm): 13 run giả (1 run có 2 mp4) + 1 file lạ → còn 10 run mới nhất, file lạ còn;
   `keep` sai → exit 1.
3. `/topics`: `curl` với 5 topic, `count: 5` → 5 chuỗi, không trùng `existing`.
   `/review`: `node host/imagereview/check.js` vẫn exit 0.
4. Migration: chạy trên bản sao trong thư mục tạm → 124 topic, số history khớp,
   `used` khớp số lần xuất hiện; chạy lần hai → từ chối.
5. End-to-end qua `POST /webhook/daily-dry-run`:
   - Lần 1 với `refill.threshold` tạm = 0.01 → `pool.json` có thêm topic
     `source:"claude"`, `state.refills[0].added > 0`, `history[0].dryRun === true`,
     Buffer không có post mới, `output/` ≤ 10 run.
   - Trả `threshold` về 0.9 → lần 2 dừng ở Topics Low? (không gọi Claude).
   - Revert thay đổi `pool.json` do lần 1 nếu không muốn giữ các topic đó.

## 9. Tài liệu

- `CLAUDE.md`: cây thư mục (`topics/`, `prune_output.js`, `container/nodes/daily/`
  với `lib/topics.js`, `03_check_topics.js`, `04_merge_topics.js`); mục "Chạy tự động
  mỗi ngày" (pool/state, refill 90%, giữ 10 run, `daily-dry-run`); quy ước nhúng lib
  vào Code node; route `/topics`.
- `docs.md`: mục mới cho thay đổi này.

## 10. Rủi ro đã biết

- **Pool tăng mãi** nếu không ai dọn — 30 topic mỗi lần refill, ~2 topic/ngày → một
  lần refill mỗi ~15 ngày khi pool ~150. Chấp nhận; xoá tay trong `pool.json` được.
- **Chất lượng topic của Claude** chỉ được code lọc ở mức trùng/độ dài. Topic kém
  vẫn có thể lọt — `git diff topics/pool.json` là chỗ duyệt.
- **`state.json` không có bản sao** ngoài máy. Mất nó → picker coi mọi topic là chưa
  dùng (lặp lại một vòng), không hỏng gì khác.
- Dry run vẫn tốn một lượt Groq và tính là đã dùng topic.
