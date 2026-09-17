# AI Shadowing Video Generator — trạng thái & roadmap

Cập nhật: 2026-09-16

- **Workflow chính**: `JwSXDLLsNxY3e9CV` — active, `POST http://localhost:5678/webhook/shadowing`
- **Workflow stub**: `jyx9sYJhVo74D48Q` — active, `/webhook/shadowing-stub`, thay node Groq bằng hội thoại canned (test pipeline không tốn quota)
- **Stack**: n8n 2.36.9 (+ffmpeg static) · `travisvn/openai-edge-tts` · Groq `openai/gpt-oss-120b`
- **Chi phí**: $0

## Đã chạy được

| Hạng mục | Kết quả đo được |
|---|---|
| E2E 6 câu, "asking a stranger for directions" | 12/12 node success, 14.5s wall-clock, xuất cả 2 tỉ lệ |
| Đồng bộ phụ đề | drift **0.0 ms**; đối chiếu mp4 thật qua `silencedetect`: lệch 220 ms (độ trễ ngưỡng năng lượng, không phải drift) |
| Video | 1280×720 **và** 1080×1920, h264+aac, 41.54s — hai file trùng độ dài tới ms |
| Âm lượng | **-15.0 LUFS**, peak -1.3 dBFS (trước khi làm: -23.6 LUFS) |
| Hai giọng | A/B luân phiên; dải 80-165 Hz chênh **~10 dB** giữa hai speaker |
| Normalize TTS | `$4.75` → "four dollars seventy-five cents"; `#12` → "twelve"; subtitle giữ nguyên |
| Skip câu lỗi | 3/8 câu hỏng → video 29.35s từ 5 câu, SRT đánh số lại, không fail |
| Dọn rác | `work/<runId>` xoá sạch; `output/` giữ `.mp4` + `.srt` + `.json` |

---

## Chưa làm được / hạn chế đã biết

Xếp theo mức độ nên xử lý trước.

### 1. Không có word-level boundary metadata
Spec gốc yêu cầu lấy word/sentence boundary từ edge-tts. Container `openai-edge-tts`
**không expose** cái này — grep source container xác nhận zero code liên quan
`WordBoundary` / `SubMaker` / `srt`; nó chỉ có `/v1/audio/speech`, `/voices`, `/models`.

Hiện tại timing lấy từ duration PCM của từng câu (`container/cli/probe_durations.js`),
chính xác tuyệt đối ở **mức câu** — đủ cho shadowing, nhưng không làm được
karaoke highlight từng từ.

**Cách sửa**: thêm container thứ ba chạy `edge-tts` CLI Python với
`--write-subtitles` (trả VTT có word boundary), gọi song song với call audio.
Ước lượng: 1 Dockerfile + 1 node HTTP + sửa `container/nodes/shadowing/03_build_srt.js`.

### 2. Retry backoff không phải exponential
n8n chỉ hỗ trợ interval **cố định** (`waitBetweenTries`), không có exponential.
Node Groq đang set 5 lần × 5s = chịu được cửa sổ 429 khoảng 25s.

**Cách sửa**: `onError: continueErrorOutput` → nhánh lỗi → Wait node với
expression `{{ 2 ** $runIndex }}` giây → nối ngược về node Groq. n8n cho phép
cycle. Đánh đổi: graph khó đọc hơn.

### 3. ~~Một giọng cho cả hai người nói~~ ✅ ĐÃ LÀM
Groq trả thêm `speaker: "A"|"B"`, map sang `voiceA`/`voiceB` trong
`container/nodes/shadowing/02_parse_normalize.js` (mặc định `en-US-AvaNeural` /
`en-US-AndrewNeural`). Model quên field thì fallback luân phiên theo vị trí.

Đã đo trên run thật: câu của A có năng lượng dải 80-165 Hz **thấp hơn ~10 dB** so
với câu của B — hai giọng tách bạch rõ, không phải chỉ đổi tham số trên giấy.

Truyền `voice` (số ít) vẫn được: cả hai speaker dùng chung giọng đó.

### 4. ~~Audio hơi nhỏ~~ ✅ ĐÃ LÀM
Đo `ebur128` rồi áp gain tĩnh + `alimiter` ở -1.5 dBTP. Kết quả thực đo trên file
xuất ra: **-15.0 LUFS** (trước: -23.6), peak -1.3 dBFS.

**Không** dùng filter `loudnorm`: nó có thể đổi số sample và làm trôi phụ đề.
`alimiter` đã kiểm chứng giữ nguyên độ dài PCM từng byte.

### 5. Tham số `background` chưa từng được test qua workflow
Code có nhận `background` (đường dẫn ảnh) và `container/cli/build_video.js` có nhánh xử lý
scale/crop, nhưng **chưa chạy thử lần nào** — mọi lần test đều dùng nền màu đơn.
Nhánh ảnh có thể có bug chưa lộ.

### 6. ~~Không dọn thư mục `work/`~~ ✅ ĐÃ LÀM
`04_build_response.js` ghi `output/<runId>.srt` + `output/<runId>.json` (run record:
câu, speaker, duration, gap, loudness) rồi xoá cả `work/<runId>`. Truyền
`keepWorkDir: true` để giữ lại khi debug.

### 7. Webhook không có xác thực
Bất kỳ ai truy cập được `localhost:5678` đều POST được. Hiện chỉ bind localhost
nên rủi ro thấp, nhưng nếu expose ra ngoài thì phải thêm Header Auth vào
Webhook node trước.

### 8. `NODES_EXCLUDE=[]` là nới lỏng bảo mật
Để dùng Execute Command (spec yêu cầu), phải bật lại node mà n8n 2.0 **cố ý
disable mặc định**. Nghĩa là workflow nào trong instance này cũng chạy được lệnh
shell tùy ý. Chấp nhận được với instance local dùng riêng; **không** nên giữ nếu
sau này có người khác dùng chung n8n này.

### 9. ~~Không đăng nhập được UI n8n~~ ✅ ĐÃ SỬA
Chạy `n8n user-management:reset` rồi setup lại owner bằng `N8N_OWNER_EMAIL` /
`N8N_OWNER_PASSWORD` trong `.env`. Đăng nhập `http://localhost:5678` đã được.

Lệnh reset **không** đụng tới workflow và credential (`makeOwnerOfAllWorkflows` /
`makeOwnerOfAllCredentials` gán lại chúng cho owner mới), nên Groq key vẫn nguyên
— đã kiểm chứng bằng một run thật sau khi reset.

### 10. Free tier Groq: ~1 video/phút
Giới hạn OTPM = 1000 output token/phút. Một request tốn ~260 token, nhưng nếu
trả lời dài bất thường thì chạm trần. Không làm batch lớn được ở tier này.

### 11. Thư viện `ms` không dùng
Spec có nhắc `ms` để convert duration. Image n8n hardened không có (`MODULE_NOT_FOUND`)
và cũng không cần — silence gap là số giây thuần, đưa thẳng vào `apad=pad_dur=`.
Không nhét `node_modules` vào hardened image cho việc này.

### 12. Thuật ngữ kỹ thuật bị dịch nghĩa đen sang tiếng Việt

Groq dịch sát nghĩa từng chữ với các thuật ngữ mà người Việt vẫn nói nguyên tiếng
Anh. Đo được trên video chủ đề standup (`20260916162109_irmz84`, câu 8):

| tiếng Anh | Groq dịch | đúng ra phải là |
|---|---|---|
| `just the usual stand-up` | "chỉ là buổi **đứng lên** thường lệ" | "chỉ là buổi **họp standup** thường lệ" |

Cùng nhóm rủi ro: sprint, deploy, merge, commit, bug, release, branch, review.
Lỗi này chỉ ảnh hưởng **phụ đề tiếng Việt** — phần đọc tiếng Anh vẫn đúng.

**Cách sửa**: thêm một dòng vào `SYSTEM_PROMPT` ở `host/workflows/shadowing.js`,
yêu cầu giữ nguyên thuật ngữ kỹ thuật/ngành nghề thay vì dịch. Sửa xong phải chạy
lại `node host/deploy.js`. Ước lượng: 5 phút, nhưng cần vài run để kiểm chứng.

### 13. Chất lượng ảnh sụt mạnh tuỳ chủ đề (khi chỉ có Openverse)

Kho CC0 của Openverse lệch nặng về lưu trữ chính phủ, ảnh scan bảo tàng và dữ
liệu khoa học. Nó **không** phải kho ảnh stock đời thường. Hệ quả đo được:

| Chủ đề | Ảnh đúng | Ghi chú |
|---|---|---|
| gọi đồ ăn sáng ở quán | **6/6** | kho CC0 nhiều ảnh đồ ăn |
| mua vé tàu | 4/6 | |
| standup với team dev | **2/8** | "team meeting morning" ra hai chính trị gia; "front end coding" ra bản đồ phao biển; "team waving goodbye" ra cầu thủ bóng đá |

Chủ đề **văn phòng / IT / công nghệ hiện đại** là tệ nhất — gần như không có ảnh
phù hợp trong kho CC0.

**Cách sửa**: nạp key vào credential `Pexels API` (id `WDuL96mPAxBXPRp7`).
Kho Pexels đầy ảnh lập trình viên, họp nhóm, văn phòng. **Không phải sửa code** —
nhánh Pexels đã lắp sẵn và đã test đường degrade. Lấy key free tại pexels.com/api.

**Nếu vẫn muốn $0 tuyệt đối**: cân nhắc Stable Diffusion self-host (xem lại bảng
so sánh ở mục A) — đổi lấy ~4GB model và 20-40s mỗi ảnh.

---

## Roadmap

### A. ~~Thêm cảnh (visual) vào video~~ ✅ ĐÃ LÀM (2026-09-16)

Mỗi câu một ảnh riêng, giữ đúng bằng khoảng `duration + gap` của câu đó, chuyển
cảnh bằng `xfade` 0.6s. Ảnh được làm tối nhẹ và có scrim dưới chân để phụ đề
luôn đọc được trên nền ảnh sáng.

**Nguồn ảnh — hai tầng**, ở `container/cli/fetch_scenes.js`:

| Tầng | Cần key | Ghi chú |
|---|---|---|
| Pexels | có (free) | Ảnh stock chuyên nghiệp. Node `Search Pexels` giữ credential, ghi URL ra `pexels.json`; script CLI **không bao giờ thấy key**. |
| Openverse | không | Ảnh Creative Commons. Lọc `cc0,pdm` trước rồi mới `by`; **loại hẳn `by-sa`** vì điều khoản share-alike sẽ lan sang cả video upload. |

Groq sinh thêm `imageQuery` cho từng câu (danh từ cụ thể, chụp ảnh được).
Chất lượng phụ thuộc rất nhiều vào query này: với `"cafe counter coffee croissant"`
Openverse cho ảnh đúng, còn khi rơi về topic chung chung thì ra ảnh tư liệu lạc đề.

**Đo thực tế** (6 câu, chủ đề gọi đồ ăn sáng): 6/6 ảnh, toàn `cc0` nên không phải
ghi nguồn; 5 ảnh rất khớp, 1 tạm được. Thêm ~20s vào thời gian dựng.

**Chưa xong**: `PEXELS_API_KEY` chưa có nên hiện 100% ảnh đến từ Openverse.
Thêm key vào credential `Pexels API` là ảnh đẹp hơn ngay, không phải sửa code.
Mức độ ảnh hưởng thay đổi rất mạnh theo chủ đề — xem hạn chế **#13**.

**Đã thử và loại**: Pollinations (AI gen, keyless) — ảnh mờ, sai chủ đề và **có
watermark** dù đã `nologo=true`.

---

### B. Workflow đăng TikTok

**Chặn đầu tiên**: TikTok Content Posting API **bắt buộc đăng ký developer app
và duyệt** — không có đường tắt bằng API key đơn giản. Cần:
1. Tài khoản TikTok Developer, tạo app
2. Xin scope `video.publish` (phải qua review của TikTok, thường vài ngày)
3. OAuth flow lấy `access_token` + `refresh_token` (token hết hạn, phải refresh)
4. Tài khoản chưa được duyệt chỉ đăng được ở chế độ **private / SELF_ONLY**

**Việc phải làm khi đã có quyền**:
- n8n Credential kiểu OAuth2 cho TikTok
- Sub-workflow refresh token tự động (token sống 24h)
- Node upload: TikTok dùng flow 2 bước — `POST /v2/post/publish/video/init/`
  lấy `upload_url`, rồi `PUT` file lên đó
- Poll `POST /v2/post/publish/status/fetch/` cho tới khi xử lý xong
- Caption + hashtag do Groq sinh luôn cùng lúc với hội thoại (tiết kiệm 1 call)

**Điều kiện tiên quyết ở phía video**: TikTok cần **9:16 (1080×1920)**, video hiện
tại là 16:9 1280×720. Phải làm mục *Ý tưởng bổ sung #3 — xuất bản dọc 9:16* trước.

**Cần bạn cấp**: tài khoản TikTok Developer + xác nhận có muốn đi qua quy trình
duyệt không. Nếu không muốn duyệt, phương án thay thế là xuất file ra thư mục
rồi đăng tay — vẫn tiết kiệm 90% công.

---

### C. Google Sheet lưu topic mỗi ngày, tránh trùng

Đây là **việc dễ nhất và đáng làm sớm nhất** trong 3 mục.

**Thiết kế đề xuất** — sheet `shadowing_topics`:

| cột | ý nghĩa |
|---|---|
| `date` | ngày tạo |
| `topic` | chủ đề |
| `runId` | khớp với tên file mp4 |
| `sentences` | số câu thực tế (sau khi trừ câu skip) |
| `videoPath` | đường dẫn output |
| `status` | `generated` / `posted` / `failed` |
| `tiktokUrl` | điền sau khi đăng (nối với mục B) |

**Luồng**:
1. Node Google Sheets `Read` ngay sau `Prepare Run` → lấy toàn bộ cột `topic`
2. Nhét danh sách đó vào system prompt Groq: *"Avoid these topics already covered: ..."*
3. Sau khi video xong, node `Append` ghi một dòng mới

**Hai cải tiến đáng cân nhắc**:
- **Tránh trùng ngữ nghĩa, không chỉ trùng chữ**: "ordering coffee" và "at a cafe"
  là hai chuỗi khác nhau nhưng cùng một tình huống. Cho Groq tự chọn topic mới
  dựa trên danh sách cũ (thay vì mình truyền topic vào) sẽ giải quyết được — đồng
  thời biến workflow thành **tự động hoàn toàn**, chỉ cần một Schedule Trigger.
- **Cho phép chạy không cần `topic`**: nếu body rỗng thì Groq tự chọn chủ đề chưa
  dùng. Sửa nhẹ `container/nodes/shadowing/01_prepare_run.js` (bỏ `throw` khi thiếu topic).

**Cần bạn cấp**: Google Service Account JSON (tạo free tại console.cloud.google.com,
bật Google Sheets API, share sheet cho email của service account).

**Phương án $0 không cần Google**: dùng một file `topics.json` trong
`/data/workflow/` — code node đọc/ghi trực tiếp, không cần credential, không
cần mạng. Mất tính năng xem/sửa trên điện thoại. Nếu bạn chỉ cần chống trùng thì
cách này **làm xong trong 15 phút**.

---

## Ý tưởng bổ sung

Xếp theo tỉ lệ **giá trị / công sức**, cao xuống thấp.

### ~~Đáng làm ngay~~ ✅ ĐÃ LÀM HẾT (2026-09-16)

1. ✅ **Hai giọng cho hai người nói** — xem hạn chế #3.
2. ✅ **Chuẩn hoá âm lượng** — xem hạn chế #4.
3. ✅ **Xuất bản dọc 9:16** — param `orientation`: `landscape` | `portrait` | `both`.
   Portrait 1080×1920. Audio dựng 1 lần, encode 2 lần. Tên file phụ có hậu tố
   `_portrait`; file đầu giữ tên `<runId>.mp4` để không phá hợp đồng cũ.
4. ✅ **Dọn `work/`** — xem hạn chế #6.
5. ❌ **Đếm ngược trong khoảng lặng** — đã làm xong rồi **gỡ bỏ** theo yêu cầu:
   nhìn thực tế thấy không hợp. Khoảng lặng giờ hoàn toàn trống như cũ.

Kèm theo: **`host/verify-sync.js`** — biến kiểm tra drift thành tool chạy được,
đối chiếu SRT với phép tính *và* với file mp4 thật (`silencedetect`). Exit code
khác 0 khi lệch, dùng được làm cổng kiểm tra.

### Đáng làm sau

6. **Kiểm tra chất lượng bằng Whisper** — Groq có sẵn `whisper-large-v3` **miễn phí**
   trong account của bạn. Transcribe lại audio vừa sinh rồi so với `ttsText`;
   lệch nhiều nghĩa là TTS đọc sai (tên riêng, viết tắt). Đây là vòng kiểm tra
   tự động gần như free, và bắt được đúng loại lỗi mà normalizer bỏ sót.
7. **Đọc chậm rồi đọc thường** — mỗi câu phát 2 lần: `speed 0.75` rồi `speed 1.0`.
   Cách luyện shadowing phổ biến. Chỉ cần sửa vòng lặp trong `container/cli/build_video.js`.
8. **Nhạc nền nhẹ** — bed nhạc ở -30 dB dưới giọng nói, giúp video đỡ khô trên
   mạng xã hội. Cần nguồn nhạc không bản quyền.
9. **Xuất Anki / CSV** — mỗi run kèm một file cặp câu EN/VI, import thẳng vào Anki.
   Manifest đã có sẵn dữ liệu, chỉ là format lại.
10. **Mức độ khó** (A2 / B1 / B2) — thêm tham số vào prompt Groq. Rẻ, mở rộng đối
    tượng người học.
11. **Thumbnail** — trích 1 frame + overlay tên chủ đề, dùng làm cover TikTok.
12. **Chế độ batch** — một request sinh nhiều topic. Bị chặn bởi OTPM free tier
    (hạn chế #10), nên phải rải theo hàng đợi có delay.

### Hạ tầng

13. **Prune execution history** — n8n lưu toàn bộ payload mỗi lần chạy, gồm cả
    binary mp3. DB sẽ phình. Bật `EXECUTIONS_DATA_PRUNE` + `EXECUTIONS_DATA_MAX_AGE`.
14. **Workflow báo lỗi** — gắn Error Trigger gửi thông báo (Telegram/email) khi
    run fail, thay vì phát hiện lúc thấy thiếu video.
15. ~~**Giữ stub workflow đồng bộ**~~ — ✅ đã giải quyết khi restructure:
    `host/workflows/shadowing-stub.js` import definition gốc và sửa trên bản sao
    trong bộ nhớ, nên hai workflow không thể lệch nhau nữa.

---

## Ghi chú vận hành

```bash
cd /Users/sangnguyen/Projects/ad-test/data/workflow

docker compose ps                   # trạng thái 2 container
docker compose up -d --build        # dựng lại sau khi sửa infra/n8n.Dockerfile
node host/deploy.js                 # deploy tất cả (upsert theo tên, giữ id + URL)
node host/deploy.js shadowing       # chỉ một workflow
node host/inspect-execution.js [id] # xem chi tiết từng node của một lần chạy
```

Cấu trúc thư mục và quy tắc viết code mới: xem [`CLAUDE.md`](CLAUDE.md).

**Bốn env var bắt buộc** (trong `docker-compose.yml`, đã giải thích lý do ngay tại chỗ):
- `NODES_EXCLUDE=[]` — bật lại Execute Command (n8n 2.0 disable mặc định)
- `N8N_RESTRICT_FILE_ACCESS_TO=/data/workflow` — n8n 2.x mặc định chỉ cho ghi `~/.n8n-files`
- `NODE_FUNCTION_ALLOW_BUILTIN=fs,path,child_process,crypto` — Code node cần `fs`
- `N8N_RUNNERS_ENABLED=true` — Code node trong n8n 2.x

**Nơi cất secret**: `.env` (chmod 600, gitignored) chỉ giữ khoá hạ tầng. Groq key
nằm **duy nhất** trong credential store đã mã hoá của n8n — không có bản sao nào
trong file.

**Image n8n là Docker Hardened Image**: không có `apk`, `bash`, `jq`, `curl`.
Chỉ có `sh`, `node`, và ffmpeg/ffprobe do `infra/n8n.Dockerfile` copy vào. Mọi script
phải viết bằng Node, đừng viết shell script dựa vào `jq` hay `curl`.
