# Ảnh cảnh từ kho stock, Claude chấm điểm chọn ảnh

- Ngày: 2026-10-10
- Phạm vi: `data/workflow/` — workflow `shadowing`, `container/cli/fetch_scenes.js`,
  `host/imagereview/server.js`
- Trạng thái: đã duyệt thiết kế, chờ kế hoạch triển khai

## 1. Mục tiêu

Bỏ việc sinh ảnh bằng SD 1.5. Mỗi khung hình lấy ảnh từ **Unsplash, Pexels,
Openverse**, Claude chấm độ khớp của từng ứng viên với câu thoại trên thang 0–100.
Ảnh đạt **≥ 72** là PASS và được dùng cho khung đó; chọn ảnh điểm cao nhất trong
số ảnh đạt.

Không đạt mục tiêu:
- Không giữ nhân vật A/B — ảnh stock chứa người lạ bất kỳ. Bản sắc nhân vật cố
  định mất là đánh đổi đã chấp nhận.
- Không xoá code SD; chỉ gỡ khỏi pipeline.
- Không đổi timeline, audio, phụ đề, title card, trang kết.

## 2. Quyết định đã chốt

| Câu hỏi | Quyết định |
|---|---|
| Nguồn ảnh | Unsplash + Pexels + Openverse |
| Không ứng viên nào ≥ 72 | Dùng ảnh điểm cao nhất, đánh dấu FAIL trong run record |
| Cách chấm | Claude chấm 0–100 theo thang có mốc (mục 4.2); ngưỡng áp ở `fetch_scenes.js` |
| Code SD | Gỡ khỏi pipeline, giữ `host/imagegen/` và `assets/characters/` |
| Điều phối review | Theo lô: 4 ứng viên / lần gọi, tối đa 2 lô / cảnh |
| Ghi công Unsplash | Lưu vào run record, không đưa vào caption (Unsplash License không bắt buộc) |

## 3. Luồng dữ liệu

Đoạn chuỗi node thay đổi trong `host/workflows/shadowing.js`:

```
Parse & Normalize ─ … TTS … ─▶ Search Unsplash ─▶ Search Pexels ─▶ Collect Stock ─▶ Fetch Scenes ─▶ Track Unsplash ─▶ Fetch Music …
```

### 3.1 Search Unsplash (node mới)

- `n8n-nodes-base.httpRequest`, chạy theo từng item (mỗi câu, kể cả `idx 0`).
- `GET https://api.unsplash.com/search/photos` với `query`, `per_page=6`,
  `orientation=landscape`, `content_filter=high`.
- Credential `httpHeaderAuth` mới: name `Authorization`, value `Client-ID <access key>`.
  Id nằm ở `.env` dưới tên `CRED_UNSPLASH_ID`; `host/deploy.js` nối vào như các
  credential khác.
- `onError: continueRegularOutput`, `retryOnFail` 2 lần — giống Search Pexels.
  Thiếu khoá / hết quota không làm hỏng run.
- Quota: bản demo 50 req/giờ. Một run ≈ 7–9 request (câu + bìa), hai run/ngày →
  dư nhiều.

### 3.2 Search Pexels

Giữ nguyên, chỉ đổi `per_page` từ `3` → `6`. Query vẫn lấy từ
`$('Parse & Normalize').item.json.imageQuery`.

### 3.3 Collect Stock (`05_collect_pexels.js` → `05_collect_stock.js`)

- Đọc `$('Search Unsplash').all()` và `$('Search Pexels').all()` theo index item,
  ghép với `$('Parse & Normalize').all()[i].json.idx`.
- Ghi `stock.json` (đường dẫn `cfg.stockPath`, thay `pexelsPath` trong
  `01_prepare_run.js`):

  ```json
  { "0": [ {"source":"unsplash","id":"…","url":"…","photographer":"…",
            "link":"…","downloadLocation":"…"} ],
    "1": [ {"source":"pexels","id":"…","url":"…","photographer":"…","link":"…"} ] }
  ```

- URL Unsplash dùng `urls.regular` kèm `&w=1920`; Pexels dùng `src.large2x`.
- **Xen kẽ** Unsplash / Pexels trong danh sách mỗi idx (u1, p1, u2, p2, …) để lô 1
  có cả hai nguồn.
- Không còn bỏ qua `idx 0`: đó là slot ảnh bìa (mục 3.5).
- Trả về `{stockPath, unsplashHits, pexelsHits, failed}`.

### 3.4 Groq prompt (`SYSTEM_PROMPT` trong `shadowing.js`)

- Bỏ `imagePrompt`, `coverPrompt` và toàn bộ luật "A girl / A boy", "exactly ONE
  person".
- Giữ `imageQuery`.
- Thêm `coverQuery`: 2–4 từ, tả bối cảnh nơi hội thoại diễn ra, không có người
  (vd `"empty train platform"`).
- `02_parse_normalize.js`: bỏ `imagePrompt`/`coverPrompt`; đọc `coverQuery`
  (fallback `cfg.topic`), ghi vào manifest, và đặt nó làm `imageQuery` của item
  `idx 0`.

### 3.5 Ảnh bìa dùng slot `idx 0`

Item `idx 0` (câu thương hiệu) vốn đã đi qua node search để giữ index khớp nhau,
kết quả bị vứt. Giờ query của nó là `coverQuery`, và `stock.json["0"]` là danh sách
ứng viên cho `cover_bg.jpg`. Không thêm node.

### 3.6 Fetch Scenes (`container/cli/fetch_scenes.js`, viết lại phần chọn ảnh)

Mỗi job (bìa trước, rồi từng câu):

1. **Ứng viên** = `stock.json[idx]` (đã xen kẽ) + Openverse (`openverseCandidates`,
   giữ nguyên logic query tiers / licence tiers) cho tới tối đa `MAX_CANDIDATES` = 12.
   Bỏ ứng viên có khoá `source:id` (hoặc URL với Openverse) đã nằm trong `used`.
2. **Tải + decode** lần lượt, giữ tối đa `MAX_REVIEW_POOL` = 8 ảnh hợp lệ
   (`download()` giữ nguyên: User-Agent, retry 429/5xx, ffmpeg decode + scale 1920).
   Mỗi ảnh hợp lệ tạo thêm bản thu nhỏ 768 px (`_thumb.jpg`) để gửi reviewer.
3. **Lô 1** = 4 ảnh đầu → `POST /review`. Áp `pickBest(scored, passScore, used)`.
   Có ảnh ≥ `passScore` → chọn, xong.
4. Không có và còn ảnh → **lô 2** = 4 ảnh kế → gộp điểm hai lô → `pickBest`.
5. Vẫn không đạt → ảnh điểm cao nhất trong mọi ảnh đã chấm, `pass:false`.
6. Ảnh được chọn → thêm khoá vào `used`, đổi tên thành `scene_NNN.jpg`
   (`cover_bg.jpg` với bìa); xoá mọi file ứng viên và thumb còn lại.

`pickBest` (hàm thuần, `container/cli/lib/pick_best.js`):
- Lọc bỏ ứng viên có khoá trong `used`.
- Xếp theo điểm giảm dần; hoà điểm thì giữ thứ tự nguồn (ứng viên đứng trước thắng).
- Trả `{ choice, pass }` với `pass = choice.score >= passScore`; không còn gì →
  `{ choice: null }`.

Việc chọn + thêm vào `used` diễn ra đồng bộ (không có `await` giữa hai bước), nên
các cảnh chạy song song không lấy trùng ảnh.

**Song song**: `mapWithLimit` với `MAX_PARALLEL` = 3 (như đường stock hiện tại).
Reviewer tự giới hạn 2 request đồng thời.

**Ngưỡng**: `manifest.passScore`, mặc định **72**, đặt ở `01_prepare_run.js`, ghi
đè qua body webhook (`{"passScore":80}`), kẹp vào `[0,100]`.

**Budget**: `REVIEW_BUDGET_MS` = 180 000 tính từ đầu script. Hết budget thì không
gửi lô mới; job đang dở lấy ảnh tốt nhất đã chấm, job chưa chấm lấy ứng viên hợp
lệ đầu tiên với `review: {pass:null, skipped:"budget"}`.

**Bỏ khỏi file**: `generateScene`, `onGpu`, `drawReviewed`, `generatorAvailable`,
`IMAGEGEN_*`, `MAX_DRAWS`, nhánh `wantsOnlyAi`, đọc `pexels.json`.
`reviewerAvailable()` không còn phụ thuộc generator.

**`imageSource`**: chỉ còn `auto | stock` (hiện tương đương nhau — cả hai là stock +
review). Giá trị `ai` được coi là `auto` và `01_prepare_run.js` ghi
`imageSourceWarning` vào manifest/record.

**stdout** (một dòng JSON, giữ hình dạng cũ để node sau không đổi nhiều):

```json
{ "scenes":[…], "missing":[…], "coverBackground":"…|null", "coverReview":{…}|null,
  "reviewer":"up|off", "passScore":72, "reviewCalls":11,
  "unsplashChosen":[ {"idx":3,"downloadLocation":"…"} ] }
```

Mỗi phần tử `scenes`:

```json
{ "idx":3, "file":"…/scene_003.jpg", "query":"…", "matchedQuery":"…",
  "source":"unsplash", "id":"abc", "photographer":"…", "link":"…",
  "license":"unsplash", "attribution":null,
  "review": { "score":81, "pass":true, "passScore":72, "required":[…], "missing":[…],
              "batches":1, "reviewed":4,
              "candidates":[ {"source":"pexels","id":"…","score":64}, … ] } }
```

`attribution` giữ ngữ nghĩa cũ: chỉ có giá trị với ảnh Openverse CC BY.

### 3.7 Track Unsplash (mới)

- Code node `06_unsplash_downloads.js`: đọc stdout của Fetch Scenes, phát một item
  `{downloadLocation}` cho mỗi phần tử `unsplashChosen` (kể cả bìa). Không có phần
  tử nào → vẫn phát **đúng một** item `{downloadLocation:""}`, vì node phát 0 item
  sẽ làm n8n dừng cả nhánh phía sau (Fetch Music trở đi không chạy).
- HTTP node `Track Unsplash Download`: `GET {{ $json.downloadLocation }}`, credential
  Unsplash, `onError: continueRegularOutput`. Item URL rỗng làm node báo lỗi và lỗi
  đó được nuốt — chủ ý, để chuỗi tuyến tính (`linearConnections`) không phải rẽ
  nhánh bằng IF node.
- Không ảnh hưởng tới video; lỗi chỉ ghi log.
- Node sau (Fetch Music) phải lấy dữ liệu bằng `$('Prepare Run')`/`$('Fetch Scenes')`
  như hiện nay, không dựa vào `$json` của node này. Kiểm lại mọi biểu thức
  `$json` ngay sau `Fetch Scenes` khi chèn node.

## 4. Reviewer (`host/imagereview/server.js`)

### 4.1 Giao diện

`POST /review`:

```json
{ "kind":"scene|cover", "topic":"…",
  "line":{"idx":3,"en":"…","vi":"…"}, "dialogue":[{"idx":1,"speaker":"A","en":"…"}],
  "images":[ {"id":"c1","mediaType":"image/jpeg","data":"<base64>"} ] }
```

- 1–4 ảnh; thiếu `images` hoặc quá 4 → 400.
- Message: với mỗi ảnh, một khối text `Candidate c1:` rồi khối image; cuối cùng là
  khối text ngữ cảnh (topic, dialogue có đánh dấu `>>`, câu, nghĩa tiếng Việt).

Trả về 200:

```json
{ "required":["cafe","coffee cup"],
  "scores":[ {"id":"c1","score":78,"present":[…],"missing":[…],"issues":[…]} ],
  "model":"sonnet", "ms":8200 }
```

Server kiểm `scores` có đủ mọi `id` đã gửi; thiếu → 503 (caller coi như reviewer
lỗi). Server **không** quyết PASS/FAIL.

### 4.2 System prompt — thang điểm

Giữ luật `required` hiện tại: chỉ bối cảnh + tối đa 2 đồ vật câu **nhắc tên**; không
đồ vật suy ra; bộ phận đại diện cho cả vật; gọi tên trơn; bỏ thứ không vẽ được.
Ảnh là **ảnh chụp stock**, không phải tranh vẽ.

| Điểm | Mốc |
|---|---|
| 90–100 | Đúng bối cảnh, đủ mọi đồ vật được nhắc tên, hành động/tình huống khớp câu |
| 72–89 | Đúng bối cảnh và đồ vật chính; thiếu chi tiết phụ hoặc hành động chỉ gần đúng |
| 50–71 | Đúng bối cảnh nhưng thiếu đồ vật chính, hoặc có đồ vật mà sai bối cảnh |
| 20–49 | Chỉ liên quan chủ đề chung chung |
| 0–19 | Không liên quan, hỏng, hoặc chữ/logo/watermark chiếm khung |

Luật thêm:
- Người trong ảnh là người lạ; không chấm ngoại hình, giới tính, số người.
- Trừ điểm ảnh dàn dựng lố (nền trắng studio, cười chỉ vào màn hình), logo/thương
  hiệu nổi bật, chữ lớn, watermark.
- Chấm từng ảnh độc lập theo thang, nhưng dùng các ảnh khác để giữ điểm nhất quán.
- `kind: cover`: `required` chỉ là bối cảnh; cộng điểm khi vùng giữa khung thoáng
  (tiêu đề in đè lên); trừ điểm khi một người chiếm trung tâm.

### 4.3 Bỏ / giữ

- Bỏ: `characterOk`, `revisedPrompt`, `pass`, `traitsFor()`, `TRAITS_FILE`.
- Giữ: `claude -p` + stream-json + `--json-schema`, `--tools ""`,
  `--strict-mcp-config`, `--no-session-persistence`, `cwd` = `os.tmpdir()`, bind
  `127.0.0.1`, `MAX_CONCURRENT` = 2, lỗi → 503.
- `CALL_TIMEOUT_MS` 90 s → 120 s; `MAX_BODY` 12 MB → 16 MB.
- Phía caller `IMAGEREVIEW_MS` 100 s → 150 s.

## 5. Xử lý lỗi

| Tình huống | Hành vi |
|---|---|
| Reviewer tắt / `reviewImages:false` | Ứng viên hợp lệ đầu tiên theo thứ tự nguồn; `review:{pass:null, skipped:"…"}` |
| Lô 1 lỗi / timeout | Như trên cho cảnh đó; không thử lô 2 |
| Lô 2 lỗi | Ảnh tốt nhất của lô 1, `pass` theo điểm của nó |
| Hết budget | Mục 3.6 |
| Unsplash/Pexels không khoá / hết quota | Thiếu nguồn đó trong `stock.json`; Openverse lấp |
| Không ứng viên decode được | `missing`; `build_video.js` dùng nền trơn (như nay) |
| Bìa không có ứng viên | `coverBackground:null`; title card dùng nền thương hiệu trơn |
| Track Unsplash lỗi | Bỏ qua, ghi log |

Mọi `throw` mới trong `container/nodes/**` không chứa dấu hai chấm (bẫy n8n #1).

## 6. Run record (`04_build_response.js`)

`scenes`:
- `used`, `missing`, `attributions` (giữ).
- `reviewer`, `passScore`, `reviewCalls`.
- `passed`: số cảnh `review.pass === true`.
- `failed`: `[{idx, score, missing}]` cho `review.pass === false`.
- `sources`: đếm theo nguồn `{unsplash, pexels, openverse}`.
- `credits`: `[{idx, source, photographer, link}]` cho ảnh Unsplash/Pexels.
- Bỏ `redraws`.

`coverReview` giữ, hình dạng như `review` của một cảnh.

## 7. Kiểm thử

1. **`pickBest`**: `container/cli/lib/pick_best.test.js` dùng `node:assert`, chạy
   bằng `node` trên host. Các ca: có ảnh ≥ ngưỡng; không ảnh nào đạt (trả cao nhất,
   `pass:false`); ảnh cao nhất đã trong `used`; hoà điểm (giữ thứ tự); rỗng.
2. **Reviewer**: `host/imagereview/fixtures/` gồm 4 ảnh cố định cho một câu (2 đúng,
   2 sai rõ) và script `host/imagereview/check.js` gửi một lô, đòi 2 ảnh đúng ≥ 72 và
   2 ảnh sai < 50. Dùng lại mỗi khi sửa prompt.
3. **End-to-end** (`node host/deploy.js shadowing` trước):
   - Run thật `{"topic":"ordering coffee"}` → record có `reviewer:"up"`, mỗi cảnh có
     `review.score`, không hai cảnh trùng `source:id`; xem video.
   - Run `{"reviewImages":false}` → mọi cảnh `pass:null`, video ra bình thường.
   - Run với reviewer tắt → giống trên, `reviewer:"off"`.
4. `node host/verify-sync.js` trên run thật — timeline không đổi nhưng là cổng bắt
   buộc.
5. `shadowing-stub` phải deploy và chạy được (import definition gốc).

## 8. Tài liệu

- `data/workflow/CLAUDE.md`: bảng runtime (`host/imagegen/` ghi "không còn trong
  pipeline"); cây thư mục (`05_collect_stock.js`, `06_unsplash_downloads.js`,
  `lib/pick_best.js`); viết lại mục "Claude review ảnh cảnh"; thu gọn mục "Sinh ảnh
  cảnh bằng SD 1.5" thành ghi chú lịch sử; lệnh thường dùng (bỏ `imageSource: ai`,
  thêm `passScore`); `.env` thêm `CRED_UNSPLASH_ID`; mục chạy tự động: bỏ yêu cầu
  generator chạy lúc 18:00, kèm lệnh `launchctl unload` LaunchAgent imagegen.
- `docs.md`: cập nhật hạn chế #13 và roadmap.

## 9. Rủi ro đã biết

- **Điểm của LLM không hiệu chuẩn tuyệt đối.** Thang có mốc giảm trôi nhưng 70 và 74
  vẫn có thể đảo giữa hai lần gọi. Ngưỡng chỉnh được qua `passScore`; fixture ở mục
  7.2 là cách phát hiện trôi khi đổi prompt/model.
- **Câu trừu tượng / đồ vật hiếm** sẽ thường không có ảnh ≥ 72; khi đó dùng ảnh
  tốt nhất và record ghi FAIL — đúng như quyết định.
- **Unsplash demo 50 req/giờ**: đủ cho lịch hiện tại; chạy thử liên tục nhiều run
  trong một giờ có thể cạn, khi đó Pexels + Openverse gánh.
- **Ảnh Openverse CC BY** vẫn không có dòng credit trên bài đăng — vấn đề có sẵn,
  ngoài phạm vi.
