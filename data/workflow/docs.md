# AI Shadowing Video Generator — trạng thái & roadmap

Cập nhật: 2026-09-16

- **Workflow chính**: `JwSXDLLsNxY3e9CV` — active, `POST http://localhost:5678/webhook/shadowing`
- **Workflow stub**: `jyx9sYJhVo74D48Q` — active, `/webhook/shadowing-stub`, thay node Groq bằng hội thoại canned (test pipeline không tốn quota)
- **Stack**: n8n 2.36.9 (+ffmpeg static) · `travisvn/openai-edge-tts` · Groq `openai/gpt-oss-120b`
- **Chi phí**: $0

## Đã chạy được

| Hạng mục | Kết quả đo được |
|---|---|
| E2E 8 câu, topic "ordering coffee" | 12/12 node success, 9.8s wall-clock |
| Đồng bộ phụ đề | drift **0.0 ms** trên cả 8 cue |
| Video | 1280×720 h264+aac, 50.07s, 571 KB |
| Normalize TTS | `$4.75` → đọc "four dollars seventy-five cents", subtitle giữ `$4.75` |
| Skip câu lỗi | 3/8 câu hỏng → video 29.35s từ 5 câu, SRT đánh số lại, không fail |

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

### 3. Một giọng cho cả hai người nói
Hội thoại do Groq sinh là trao đổi **2 người** (khách / barista), nhưng cả 8 câu
đều dùng `en-US-AvaNeural`. Nghe như một người tự nói chuyện một mình.

Đây là hạn chế ảnh hưởng chất lượng học nhiều nhất trong danh sách này.

**Cách sửa**: cho Groq trả thêm field `speaker: "A"|"B"`, rồi map sang 2 voice
(vd `en-US-AvaNeural` / `en-US-AndrewNeural`) trong `container/nodes/shadowing/02_parse_normalize.js`.
Thay đổi nhỏ, tác động lớn.

### 4. Audio hơi nhỏ
Mean volume **-23.6 dB**, max -3.1 dB. Chuẩn phát mobile/TikTok khoảng -14 LUFS.
Nghe trên điện thoại ngoài đường sẽ phải vặn to.

**Cách sửa**: thêm `loudnorm=I=-14:TP=-1.5:LRA=11` vào filter audio trong
`container/cli/build_video.js`. Một dòng.

### 5. Tham số `background` chưa từng được test qua workflow
Code có nhận `background` (đường dẫn ảnh) và `container/cli/build_video.js` có nhánh xử lý
scale/crop, nhưng **chưa chạy thử lần nào** — mọi lần test đều dùng nền màu đơn.
Nhánh ảnh có thể có bug chưa lộ.

### 6. Không dọn thư mục `work/`
Mỗi run 8 câu để lại **~4 MB** (mp3 + wav + full_audio.wav). Không có cơ chế xoá.
Chạy 100 video là 400 MB rác.

**Cách sửa**: thêm bước xoá `work/<runId>` sau khi mp4 xong, hoặc cron dọn
thư mục cũ hơn N ngày. Cân nhắc giữ lại `manifest.json` + `subtitle.srt` (nhẹ).

### 7. Webhook không có xác thực
Bất kỳ ai truy cập được `localhost:5678` đều POST được. Hiện chỉ bind localhost
nên rủi ro thấp, nhưng nếu expose ra ngoài thì phải thêm Header Auth vào
Webhook node trước.

### 8. `NODES_EXCLUDE=[]` là nới lỏng bảo mật
Để dùng Execute Command (spec yêu cầu), phải bật lại node mà n8n 2.0 **cố ý
disable mặc định**. Nghĩa là workflow nào trong instance này cũng chạy được lệnh
shell tùy ý. Chấp nhận được với instance local dùng riêng; **không** nên giữ nếu
sau này có người khác dùng chung n8n này.

### 9. Không đăng nhập được UI n8n
Password owner lưu trong `.env` không khớp với password thật trong DB (login trả
401). Không cản trở gì vì mọi thao tác đều qua REST API, nhưng muốn mở
`http://localhost:5678` bằng trình duyệt thì phải reset password trước.

### 10. Free tier Groq: ~1 video/phút
Giới hạn OTPM = 1000 output token/phút. Một request tốn ~260 token, nhưng nếu
trả lời dài bất thường thì chạm trần. Không làm batch lớn được ở tier này.

### 11. Thư viện `ms` không dùng
Spec có nhắc `ms` để convert duration. Image n8n hardened không có (`MODULE_NOT_FOUND`)
và cũng không cần — silence gap là số giây thuần, đưa thẳng vào `apad=pad_dur=`.
Không nhét `node_modules` vào hardened image cho việc này.

---

## Roadmap

### A. Thêm cảnh (visual) vào video bằng AI

Hiện nền là màu đơn `#14161A`. Muốn có hình minh hoạ theo nội dung.

**Vấn đề cần giải trước**: image gen miễn phí thật sự thì hiếm. Groq **không có**
image model. Các hướng khả thi:

| Hướng | Chi phí | Ghi chú |
|---|---|---|
| Pollinations.ai (`image.pollinations.ai/prompt/...`) | $0, không cần key | Chất lượng khá, rate limit không công bố, có thể die bất kỳ lúc nào |
| Stable Diffusion self-host (ComfyUI / A1111) | $0 nhưng tốn máy | Mac M-series chạy SDXL ~20-40s/ảnh. Nặng, cần thêm container |
| Ảnh stock (Pexels / Unsplash API) | $0, có free tier key | Không phải AI nhưng **nhanh và ổn định nhất**, ảnh thật đẹp hơn SD free |
| Gemini / Imagen free tier | cần xác nhận hạn mức | Phải hỏi bạn trước vì có thể phát sinh phí |

**Đề xuất**: bắt đầu bằng **Pexels API** (1 ảnh/câu theo keyword Groq sinh kèm),
vì nó ổn định và cho kết quả nhìn chuyên nghiệp ngay. Thêm Pollinations như
fallback. SD self-host để sau nếu bạn muốn style nhất quán.

**Việc phải làm**:
- Groq trả thêm `imagePrompt` hoặc `keywords` cho mỗi câu
- Node HTTP tải ảnh → `work/<runId>/scene_NNN.jpg`
- `container/cli/build_video.js`: đổi từ 1 nền tĩnh sang **concat các đoạn ảnh theo đúng
  cue timing** (mỗi ảnh hiện đúng khoảng `duration + gap` của câu đó)
- Thêm crossfade giữa các cảnh (`xfade` filter) để không bị giật
- Ken Burns effect (`zoompan`) nếu muốn ảnh tĩnh đỡ chán

**Rủi ro**: ffmpeg filter graph sẽ phức tạp hơn nhiều so với hiện tại. Nên tách
thành script riêng `build_video_scenes.js` thay vì nhồi vào file cũ.

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

### Đáng làm ngay (mỗi cái dưới 1 giờ)

1. **Hai giọng cho hai người nói** — xem hạn chế #3. Cải thiện chất lượng học nhiều
   nhất so với công bỏ ra.
2. **Chuẩn hoá âm lượng** (`loudnorm`) — xem hạn chế #4. Một dòng ffmpeg.
3. **Xuất bản dọc 9:16** — bắt buộc cho TikTok/Shorts/Reels. Đổi `width`/`height`
   thành tham số và đặt subtitle `MarginV` cao hơn. Có thể xuất **cả hai tỉ lệ**
   trong một lần dựng.
4. **Dọn `work/` sau khi xong** — xem hạn chế #6.
5. **Đếm ngược trong khoảng lặng** — hiện khoảng lặng hoàn toàn trống, người học
   không biết còn bao lâu. Vẽ 3 chấm mờ dần hoặc thanh progress bằng `drawbox`.
   Rất hợp với mục đích shadowing.

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
