# AI Shadowing Video Generator — trạng thái & roadmap

Cập nhật: 2026-10-04

- **Workflow chính**: `JwSXDLLsNxY3e9CV` — active, `POST http://localhost:5678/webhook/shadowing`
- **Workflow stub**: `jyx9sYJhVo74D48Q` — active, `/webhook/shadowing-stub`, thay node Groq bằng hội thoại canned (test pipeline không tốn quota)
- **Chạy tự động**: workflow `daily` — dựng 18:00, Buffer đăng 19:00 mỗi ngày (Asia/Ho_Chi_Minh). Chủ đề xoay vòng từ `topics.json` theo *ít dùng gần đây nhất*.
- **Workflow đăng TikTok**: `/webhook/buffer-publish` — S3 → Buffer → TikTok công khai. **Chờ điền khoá**, xem mục B.
- **Đường dự phòng**: `/webhook/tiktok-publish` — gọi thẳng TikTok, chỉ bỏ được draft vào hộp thư. Bị chặn ở Login Kit, xem mục B.
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
| Nhạc nền | bed CC0 ở **-24 LUFS dưới giọng**; cùng một bed, khoảng lặng -38.5 dB (ở -30 là -44.5), giọng vẫn -14.8 dB |
| Thumbnail | title card 1.2s đốt vào đầu video, **nền là cảnh sinh riêng theo chủ đề**; `thumbnailOffset` trỏ giữa thẻ |
| Đồng bộ sau khi thêm thẻ | drift **0.0 ms**, onset đo trên mp4 thật **276 ms** (ngưỡng 350) |
| Dọn rác | `work/<runId>` xoá sạch; `output/` giữ `.mp4` + `.srt` + `.json` + `_cover.jpg` |

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

### 13. ~~Chất lượng ảnh sụt mạnh tuỳ chủ đề~~ ✅ ĐÃ CHỮA bằng SD 1.5 local (2026-10-04)

Chạy lại đúng chủ đề tệ nhất — standup với team dev, trước đây **2/8** ảnh đúng —
bằng model sinh ảnh local: **6/6 đúng chủ đề**, ~7.2s mỗi ảnh.

`host/imagegen/server.py`: SD 1.5 + LCM-LoRA (2.68 GB, chọn vì đo được so với
6.46 GB của SDXL), chạy **native trên macOS** vì Docker không với được GPU Metal.
`fetch_scenes.js` thử generator trước, không có thì rơi về Pexels rồi Openverse —
nên quên bật service chỉ làm ảnh xấu đi, không làm hỏng run.

**Phát hiện đắt giá nhất:** prompt cho máy tìm ảnh **không dùng được** cho máy vẽ
ảnh. `"team standup meeting office whiteboard"` cho ra một bức tranh thảm Ba Tư,
đổi seed vẫn hỏng. Viết thành câu thì đúng ngay. Groq giờ sinh cả `imageQuery`
(stock) lẫn `imagePrompt` (một câu, cho máy vẽ).

Đo thêm: `guidance` 1.0 nhanh **gấp đôi** 1.5 và đẹp hơn; 8 bước làm ảnh sụp thành
mảng phẳng; style dài làm nhoè hết. Ảnh sinh ra gần như xám (SATAVG 5.1) và thêm
từ khoá màu vô tác dụng — phải tăng bão hoà sau khi sinh.

**Hai nhân vật anime cố định** (`assets/characters/A.png`, `B.png`) **do chính
pipeline sinh ra** theo mỹ học Shinkai — không dùng nhân vật phim có bản quyền.
Khoá bằng IP-Adapter `-plus-face` ở scale **0.40**: đo trên cùng prompt+seed,
0.55 nuốt mất phong cảnh (nền trơn của ảnh tham chiếu bị kéo sang), 0.28 giữ cảnh
nhưng tóc trôi khỏi tham chiếu, 0.40 giữ được cả hai. Speaker A/B của hội thoại quyết định cảnh
đó vẽ ai, nên cả series có một bộ nhân vật nhất quán mà không cần nhập thêm gì.
Thay nhân vật = thay hai file PNG. Cần thêm ~2.5 GB (image encoder 2.41 GB).
Giống chứ không trùng khít — tóc/mắt/trang phục giữ được, mặt trôi nhẹ.

**Model: Counterfeit V2.5** (anime, 1.99 GB, ~8s/ảnh). Đổi từ Realistic Vision
sang vì mặt vẽ không có thung lũng kỳ lạ. Đánh đổi đã đo: bám prompt lỏng hơn, và
**hỏng hẳn với cảnh nhóm** — nên Groq giờ phải viết "một nhân vật, một hành động".

**Ghi chú cũ — Realistic Vision V6** (finetune ảnh thật của SD1.5, file fp16 1.99 GB).
Đổi từ SD1.5 gốc sang nó không tốn thêm giây nào vì cùng kiến trúc — LCM-LoRA vẫn
áp được, vẫn ~7.3s/ảnh. Đo trên cùng prompt+seed: bão hoà **5-8 → 18-28**, mặt
người từ biến dạng thành bình thường.

**Mặt người méo — đã chữa bằng prompt, không bằng tham số.** Bản đầu sinh ra năm
khuôn mặt biến dạng mỗi cảnh. SD 1.5 vốn yếu ở mặt và tay, và không tổ hợp
guidance/steps/style nào sửa được. Cách chữa là **cấm mặt chính diện ngay trong
prompt**: `SYSTEM_PROMPT` buộc Groq tả đồ vật, không gian, bàn tay đang thao tác,
hoặc người quay lưng. Chạy lại cùng chủ đề standup cho ra tường giấy nhớ sắc nét,
tay gõ bàn phím, rack server — không còn gì để méo, và màu cũng rực hơn hẳn vì
chủ thể vốn nhiều màu.

Kèm theo hai chỗ dễ nhầm. Một: `NEGATIVE` prompt **vô tác dụng ở guidance 1.0**,
vì diffusers chỉ mã hoá nó khi CFG bật. Hai: **phủ định trong prompt dương cũng vô
tác dụng** — bắt Groq ghi "no faces visible" mà generator vẫn vẽ mặt. Thứ có hiệu
quả là tả đồ vật thay vì tả người. Sau khi lên Realistic Vision thì luật này được
nới, vì mặt đã vẽ tốt.

**Giá:** +45-70s mỗi run (86s so với ~20s).

<details>
<summary>Mô tả hạn chế gốc</summary>

#### Chất lượng ảnh sụt mạnh tuỳ chủ đề (khi chỉ có Openverse)

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

</details>

### Câu thoại thương hiệu đầu video ✅ (2026-10-04)

Title card trước đây im lặng; giờ có một câu đọc lên để nhận diện kênh.

| Tham số | Mặc định | Ghi chú |
|---|---|---|
| `introLine` | `"Welcome to {brand}. Let's practice shadowing."` | `{brand}`/`{topic}` được thay. `false` = card im lặng như cũ |
| `introSpeed` | `1.0` | Hội thoại đọc 0.9 để nhại theo; câu này không nhại nên đọc tốc độ thường |
| `introTailMs` | `500` | Khoảng nghỉ trước câu đầu tiên |
| `introMs` | `1200` | Giờ chỉ là **fallback** khi không có câu thoại |

**Vì sao mặc định không đọc chủ đề**: đo trên Edge TTS, nhắc chủ đề tốn thêm
**1.4–2.4s** *và độ dài thay đổi theo từng video* — ngược hẳn mục đích nhận diện,
vốn cần mở đầu giống hệt nhau. Chủ đề đã hiện trên card và nằm trong caption.
Muốn đọc thì thêm `{topic}` vào `introLine`.

Đo thực tế với chủ đề *"a daily standup with the dev team"*: có chủ đề + tốc độ 0.9
= **7484 ms**; mặc định hiện tại = **4628 ms**, và không đổi theo chủ đề.

Sync giữ nguyên **0.0 ms** ở cả ba đường: có câu thoại, `introLine:false`, và câu
tuỳ biến.

### Đăng 2 video/ngày + kho chủ đề 124 + sửa lỗi picker ✅ (2026-10-04)

**Lịch**: `daily` giờ có **hai trigger — 07:00 và 19:00 ICT**, dựng trước mỗi slot
một tiếng, Buffer đăng lúc **08:00 và 20:00**. Slot do `01_pick_topic.js` chọn
**theo đồng hồ**, không theo trigger nào vừa chạy, nên một lần chạy tay hoặc một
build trễ vẫn nhắm vào slot kế tiếp chưa qua thay vì đưa Buffer một mốc quá khứ.
Đã kiểm lúc 23:55 ICT: tự chuyển sang 08:00 hôm sau.

**Kho chủ đề**: 30 → **124** (thêm 94, đã khử trùng lặp). Ở nhịp 2 video/ngày là
**62 ngày** mới quay vòng. Nhóm mới gồm công việc/IT, y tế, du lịch, mua sắm, học
hành, xã giao.

**Sửa lỗi picker — bắt buộc phải làm cùng lúc.** `rank()` trả thẳng `indexOf` trên
`history` vốn **newest-first**, nên index nhỏ = *mới dùng*, và sort tăng dần chọn
đúng cái vừa dùng. Khi mọi chủ đề đã chạy một lượt, kênh sẽ đăng **một chủ đề duy
nhất mãi mãi**, không lỗi nào bắn ra. Tăng lên 2 video/ngày khiến nó cắn nhanh gấp
đôi.

Đã sửa thành `-i` (và `-Infinity` cho chủ đề chưa dùng), chứng minh bằng mô phỏng:

| | kết quả |
|---|---|
| pool 3, chạy 12 lần | `c a b c a b c a b c a b` — mỗi chủ đề 4 lần |
| pool 5, chạy 25 lần | khoảng cách lặp gần nhất = **5** = đúng kích thước pool |

Chủ đề **chưa từng dùng** được chọn ngẫu nhiên trong nhóm đó thay vì theo thứ tự
file, để một lô vừa thêm không đi ra thành khối liền nhau.

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

### B. ~~Workflow đăng TikTok~~ ✅ ĐÃ CHUYỂN SANG BUFFER (2026-10-04) — chờ điền khoá

**Đường trực tiếp bị chặn ở thực tế, không phải ở code.** Đã dựng xong và test hết
(xem phần dưới), nhưng khi uỷ quyền thì TikTok trả `client_key` error. Đã chẩn
đoán tách bạch: gọi `client_credentials` **thành công** → key và secret đều đúng,
app hoạt động. Nghĩa là vướng ở cấu hình Login Kit phía portal, không phải code.

**Nên chuyển sang Buffer.** Buffer là đối tác được TikTok duyệt, nên:

| | TikTok trực tiếp | **Buffer** |
|---|---|---|
| Audit Content Posting API | bắt buộc, nếu không thì SELF_ONLY | **không cần** |
| Kết quả | draft trong hộp thư, phải bấm tay | **đăng công khai, tự động** |
| Caption/hashtag | bị bỏ qua, phải gõ trong app | **API mang theo được** |
| Hẹn giờ | không | **có, `dueAt` ISO 8601** |
| Video ở đâu | local là đủ | **phải ở URL công khai** |

**Cái giá: Buffer không có endpoint upload.** Asset phải "reachable over the public
internet without authentication" và "stay reachable **until the post publishes**".
Vì `mode` chỉ có `addToQueue` / `customScheduled` — **không có đăng ngay** — khe
hàng đợi có thể chạy vài giờ sau, nên tunnel tạm và URL ký đều loại. Đã chọn **S3**.

Google Drive đã cân nhắc và **loại**: Buffer gọi đích danh "a Google Drive or
Dropbox 'share' link — will not work", và Drive trả HTTP 200 kèm HTML khi quá
quota — đúng kiểu hỏng âm thầm mà `CLAUDE.md` đã cảnh báo.

**Đã làm:**

| Thành phần | Vai trò |
|---|---|
| Node `Upload To S3` | node `awsS3` gốc, dùng credential `aws` của n8n |
| Node `Verify Public URL` | GET **ẩn danh** để tái hiện đúng thứ Buffer sẽ thấy |
| Node `Create Buffer Post` | HTTP Request gốc, dùng credential `httpHeaderAuth` |
| `container/nodes/buffer-publish/*` | Chọn video, chặn 16:9, kiểm giới hạn TikTok của Buffer |
| `host/workflows/buffer-publish.js` | `/webhook/buffer-publish` |
| `publish.config.json` | bucket/region/channelId — **không phải secret**, có trong git |
| Credential `AWS S3` + `Buffer API` | **khoá nằm trong credential store của n8n**, sửa trên UI |

**Đã kiểm chứng, không đoán:**

1. **SigV4 khớp test vector chính thức của AWS** (`examplebucket/test.txt` →
   `f0e8bdb87c96…`). Chạy lại phép đối chiếu này mỗi khi sửa `authorize()`.
2. Bắn thật lên AWS bằng khoá mẫu → `InvalidAccessKeyId`, tức request **được AWS
   phân tích đúng**, chỉ khoá là giả.
3. **Buffer hỏng ở ba chỗ khác nhau**, và "luôn trả 200" chỉ đúng với hai: `errors[]`,
   `MutationError` nằm trong `data`, và **HTTP 401 thẳng** khi API key sai (đã đo).
   Một response có thể 200, `errors` rỗng, mà không đăng gì.
4. Bucket S3 tạo từ 2023 trở đi **tắt ACL** và **bật Block Public Access** sẵn —
   cả hai đều khiến Buffer nhận 403. Nên có hẳn một node GET lại URL công khai
   **ẩn danh** và đòi thấy `ftyp` trong 64 byte đầu.
5. Mọi nhánh lỗi đã test qua webhook: thiếu tham số, runId sai, `dueAt` sai định
   dạng, chưa có khoá S3. Khi S3 hỏng, workflow **dừng trước khi gọi Buffer** —
   không đốt một trong 100 request/ngày của Free plan, và lỗi trả về chỉ đúng vào
   credential cần sửa thay vì một thông báo vô nghĩa từ Buffer.
6. **IF node thay cho error output.** Node có hai đầu ra làm `$('Tên node')` trả
   `undefined` từ phía dưới, mà ba node ở đây cần đọc `$('Resolve Video')`. Nên
   rẽ nhánh bằng IF riêng để node nguồn giữ một đầu ra.

**Đã chạy thật thành công (2026-10-04)** — `postId 6ac1f7d75829d2489a08c6ed`, video
2.7MB lên `shadowing-english` (ap-southeast-2), caption + 6 hashtag đi kèm,
thumbnail khớp cover ở 2680ms, vào khe tiếp theo của hàng đợi Buffer.

⚠️ **Lần post đầu ngay sau khi mở công khai bucket hỏng một lần** với
`Invalid post: Video could not be read from its URL`, trong khi URL đó tải đầy đủ
và decode bình thường từ máy khác. Gửi lại y nguyên thì thành công. Gặp lại thì
thử lần hai trước khi nghi ngờ chỗ khác.

**Còn lại để chạy được:**
1. `http://localhost:5678` → **Credentials** → điền `AWS S3` (region + key + secret)
   và `Buffer API` (`Authorization` = `Bearer <key>`).
2. `publish.config.json` → điền `s3.bucket`, chỉnh `s3.region` cho **trùng** credential.
3. Bucket phải **tắt Block Public Access** và có bucket policy cho `s3:GetObject` tới `"*"`.

**Không còn khoá nào trong file** — đúng quy tắc ở `CLAUDE.md`. Ngoại lệ duy nhất
còn lại là `secrets/tiktok.json` của đường trực tiếp, vì refresh token xoay vòng
mà API v1 không sửa được giá trị credential.

<details>
<summary>Đường trực tiếp tới TikTok (đã dựng xong, đang bị chặn ở Login Kit)</summary>

#### Workflow đăng TikTok — inbox draft

**Phân tích cũ ở dưới đã bỏ sót một đường, và đường đó đổi hẳn bài toán.**

Ngoài Direct Post (`video.publish`, bắt buộc audit, chưa duyệt thì mọi post bị ép
`SELF_ONLY`), TikTok còn có **inbox draft**: `POST /v2/post/publish/inbox/video/init/`
với scope **`video.upload`**. Đường này **không bị gate bởi audit**, vì người thật
bấm nút đăng. Video rơi vào hộp thư trong app, bạn mở ra gõ caption rồi đăng —
công khai bình thường. Nên **không phải chọn giữa "chờ duyệt vài tuần" và "đăng
tay hoàn toàn"** như đoạn dưới viết.

Đánh đổi: TikTok **bỏ qua toàn bộ `post_info`** với inbox draft. Caption/hashtag
không gửi qua API được, nên mỗi run ghi thêm `output/<runId>_caption.txt` để copy.
Và hạn mức **~5 draft chờ / 24h**.

**Đã làm:**

| Thành phần | Vai trò |
|---|---|
| `container/cli/tiktok_token.js` | Chủ sở hữu **duy nhất** của vòng đời token — exchange, refresh, ghi atomic |
| `container/cli/tiktok_publish.js` | init → PUT theo chunk → poll status |
| `container/nodes/tiktok-publish/*` | Chọn video, từ chối cái không hợp lệ, dựng câu trả lời |
| `host/tiktok-auth.js` | OAuth một lần; không tự tính token mà gọi container qua `docker exec` |
| `secrets/tiktok.json` | app key + token, chmod 600, gitignored |
| Caption + hashtag | Groq sinh **cùng call** với hội thoại (thêm ~40 token, không tốn request) |

**Bốn ràng buộc đã xác minh từ tài liệu TikTok, không đoán:**

1. `redirect_uri` **tuỳ platform**: **Web** bị ép https, không có ngoại lệ localhost;
   **Desktop** thì chỉ cho `localhost`/`127.0.0.1`, bắt buộc có cổng, và **http được
   chấp nhận**. Đã chọn Desktop + `http://localhost:3455/callback/` nên
   `host/tiktok-auth.js` tự dựng server bắt callback — một lệnh, không phải dán gì.
   Giá phải trả là **PKCE bắt buộc**, và **PKCE của TikTok lệch RFC 7636**: challenge
   là **HEX** của SHA256 chứ không phải base64url. Gửi base64url thì authorize bị từ
   chối không rõ lý do.
2. `total_chunk_count` = **`floor(size/chunk)`**, không phải `ceil`. Chunk cuối
   được phép to hơn `chunk_size` (tới 128MB) để nuốt phần dư. Dùng `ceil` sẽ tạo
   chunk cuối < 5MB và TikTok **từ chối sau khi đã upload xong phần còn lại**.
   Đã kiểm thử ở 2.6MB / 5MB / 7MB / 12MB / 100MB / 4GB — luôn phủ đủ byte.
3. Video **< 5MB phải đi nguyên khối** (`chunk_size = video_size`). Video hiện tại
   2.6–3.4MB nên luôn rơi vào nhánh này.
4. `refresh_token` **xoay mỗi lần refresh**; bản cũ chết ngay.

**Đã kiểm thử không cần credential:** dry-run toàn tuyến, từ chối 16:9, từ chối
runId sai định dạng, chặn path traversal, báo chưa uỷ quyền kèm hướng dẫn. Endpoint
token thật đã trả `invalid_grant - Authorization code is expired` với code giả —
tức TikTok **chấp nhận định dạng request**, chỉ thiếu uỷ quyền thật.

**Còn lại để chạy được:** trong portal thêm **Login Kit** (platform Desktop,
redirect `http://localhost:3455/callback/`) và **Content Posting API** (scope
`video.upload`); điền `clientKey`/`clientSecret` vào `secrets/tiktok.json` rồi chạy
`node host/tiktok-auth.js`. Xem `CLAUDE.md`, mục "TikTok".

**Nếu sau này muốn zero-touch** thì nộp audit cho Content Posting API và đổi sang
Direct Post — dùng chung OAuth, refresh token và bước upload, chỉ khác endpoint
`init` và việc `post_info` bắt đầu có tác dụng.

**Trạng thái:** bế tắc ở bước authorize. Cần thêm product **Login Kit** (platform
Desktop, redirect `http://localhost:3455/callback/`) và bật scope `video.upload`
trong portal. Code không có lỗi gì đã biết.

</details>

---

<details>
<summary>Phân tích ban đầu (giữ lại — nó đúng về Direct Post, chỉ thiếu đường inbox)</summary>

#### Workflow đăng TikTok

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

</details>

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

### ~~Đợt 2~~ ✅ ĐÃ LÀM (2026-09-17)

Số thứ tự giữ nguyên theo danh sách *Ý tưởng bổ sung* gốc ở dưới.

8. ✅ **Nhạc nền nhẹ** — `container/cli/fetch_music.js` + nhánh mix trong
   `container/cli/build_video.js`. Hai tầng nguồn giống hệt ảnh: file trong
   `assets/music/` được ưu tiên, không có thì tìm nhạc **CC0** trên Openverse
   (keyless). Mức bed đặt theo **programme loudness**, không phải peak: đo cả bed
   lẫn giọng bằng `ebur128` rồi đặt gain để bed nằm đúng `musicDb` (mặc định
   **-24**) dưới giọng, nên file nhạc to nhỏ thế nào cũng ra cùng một kết quả.
   Mặc định ban đầu đặt -30; đo thì đúng nhưng nghe trên loa điện thoại gần như
   mất hẳn, nên nâng lên -24 (2026-10-03). Đổi mức chỉ dịch bed, **không** chạm
   vào giọng: A/B trên cùng một bed cho khoảng lặng -44.5 → -38.5 dB trong khi
   đoạn có giọng giữ nguyên -14.8 dB.
   Bed ngắn thì loop, dài thì cắt, luôn fade 2s vào / 2.5s ra.

   **Chỗ nguy hiểm đã chặn**: mix mà đổi độ dài audio thì *toàn bộ* phụ đề trôi.
   Nên `amix` dùng `duration=first:normalize=0`, rồi **so số sample** của bản mix
   với bản giọng; lệch một sample là vứt bản mix, xuất audio không nhạc. Số sample
   được ghi vào run record và `host/verify-sync.js` kiểm lại (`voice=890496
   final=890496`). `normalize=0` là bắt buộc — mặc định `amix` chia đều theo số
   input, tức là **hạ giọng 6 dB** để nhường chỗ cho bed thấp hơn nó 30 dB.

   **Cache**: tải một bed mất ~35s, pipeline chỉ có ~15s. Nên bản tải về nằm ở
   `assets/music/.openverse/` (gitignored) và được dùng lại; 3 run đầu tải, từ run
   thứ 4 chọn ngẫu nhiên trong kho mất **0.1s**.

   **Chỉ nhận `cc0,pdm`, loại hẳn `by`** — ảnh CC BY chỉ cần dòng credit trong
   file JSON, nhưng *nhạc nền* CC BY thì nghĩa vụ ghi nguồn đi theo video ở mọi
   nơi nó được phát, và pipeline không giữ được lời hứa đó trên TikTok.

11. ✅ **Thumbnail** — trích 1 frame thật từ mp4 đã xuất (nên cover không thể quảng
   cáo một video không tồn tại), làm tối -18%, **xoá dải phụ đề burn-in**, rồi vẽ
   tên chủ đề cỡ lớn. Mỗi tỉ lệ một file: `<runId>_cover.jpg`,
   `<runId>_portrait_cover.jpg`.

   Chiều cao dải che lấy **đúng công thức `frameMetrics()` đã vẽ scrim của video** —
   một nguồn sự thật duy nhất, không thể lệch. Vị trí tiêu đề tự đổi theo khung:
   9:16 dải chiếm ~32% nên tiêu đề nằm trong ảnh (cũng là chỗ duy nhất TikTok không
   crop mất ở lưới profile); 16:9 dải chiếm ~45% nên tiêu đề chuyển vào trong dải,
   thành lower-third.

Kèm theo: **`host/verify-sync.js`** giờ có thêm cổng kiểm tra số sample, và nói rõ
khi bỏ qua onset check vì nhạc nền lấp khoảng lặng.

### Đáng làm sau

6. **Kiểm tra chất lượng bằng Whisper** — Groq có sẵn `whisper-large-v3` **miễn phí**
   trong account của bạn. Transcribe lại audio vừa sinh rồi so với `ttsText`;
   lệch nhiều nghĩa là TTS đọc sai (tên riêng, viết tắt). Đây là vòng kiểm tra
   tự động gần như free, và bắt được đúng loại lỗi mà normalizer bỏ sót.
7. **Đọc chậm rồi đọc thường** — mỗi câu phát 2 lần: `speed 0.75` rồi `speed 1.0`.
   Cách luyện shadowing phổ biến. Chỉ cần sửa vòng lặp trong `container/cli/build_video.js`.
9. **Xuất Anki / CSV** — mỗi run kèm một file cặp câu EN/VI, import thẳng vào Anki.
   Manifest đã có sẵn dữ liệu, chỉ là format lại.
10. **Mức độ khó** (A2 / B1 / B2) — thêm tham số vào prompt Groq. Rẻ, mở rộng đối
    tượng người học.
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

### Tham số webhook mới

| Tham số | Mặc định | Ý nghĩa |
|---|---|---|
| `music` | `true` | `false` → tắt nhạc. Chuỗi (vd `"bed.mp3"`) → dùng đúng file đó trong `assets/music/` |
| `musicDb` | `-24` | bed thấp hơn giọng bao nhiêu LUFS; cho phép -60…-6 (số âm hơn = nhạc nhỏ hơn) |
| `musicQuery` | — | lái tìm kiếm Openverse khi `assets/music/` rỗng |
| `thumbnail` | `true` | `false` → không xuất cover |
| `thumbnailTime` | tự chọn | giây, ép thời điểm trích frame |

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
