# CLAUDE.md — AI Shadowing Video Generator

Hướng dẫn bắt buộc cho mọi code mới trong thư mục này.
Trạng thái và roadmap: [`docs.md`](docs.md).

---

## Nguyên tắc tổ chức: chia theo **runtime**, không theo loại file

Mọi lỗi tốn thời gian nhất khi build dự án này đều đến từ việc **nhầm runtime** —
viết code cho môi trường A rồi chạy ở môi trường B. Cây thư mục tồn tại để câu hỏi
*"file này chạy ở đâu?"* trả lời được chỉ bằng đường dẫn.

| Thư mục | Chạy ở đâu | Có gì dùng được |
|---|---|---|
| `host/` | macOS, Node của bạn | Toàn bộ toolchain: `npm`, `jq`, `curl`, `docker`, mọi package |
| `container/cli/` | Trong container n8n, gọi bởi Execute Command node | **Chỉ** `node` + `ffmpeg` + `ffprobe` + `sh` |
| `container/nodes/` | Trong task runner của n8n, nội dung Code node | `node` + builtin trong `NODE_FUNCTION_ALLOW_BUILTIN` |
| `infra/` | Không chạy — định nghĩa image | — |
| `host/imagegen/` | ⚠ **không còn trong pipeline** (2026-10-10) — macOS, Python qua `uv` | torch + diffusers |
| `host/imagereview/` | macOS, Node, gọi CLI `claude` đã đăng nhập | `claude -p` |

### ⛔ Ràng buộc của container (đọc kỹ trước khi viết `container/**`)

Image n8n 2.x là **Docker Hardened Image**. Đã xác minh **không có**:

```
apk   apt   bash   jq   curl   wget   python3   pip
```

Hệ quả bắt buộc:

- **Viết bằng Node, không viết shell script.** Không có `bash`; `sh` có nhưng không
  có `jq`/`curl` nên script shell vô dụng. Node có sẵn `JSON`, `fetch`, `child_process`.
- **Không `npm install` được gì.** Không có package manager trong image. Thư viện
  ngoài phải thêm vào `infra/n8n.Dockerfile` bằng multi-stage `COPY` (xem cách
  ffmpeg được đưa vào), hoặc đừng dùng.
  - Ví dụ thực tế: `ms` **không có** trong image. Đừng `require('ms')`.
- **Code node muốn `require` builtin** thì tên module phải nằm trong
  `NODE_FUNCTION_ALLOW_BUILTIN` ở `docker-compose.yml`. Hiện cho phép:
  `fs, path, child_process, crypto`.
- **Chỉ ghi được trong `/data/workflow`.** n8n 2.x chặn bằng
  `N8N_RESTRICT_FILE_ACCESS_TO`. Ghi ra ngoài → `Access to the file is not allowed.`

---

## Cây thư mục

```
data/workflow/
├── CLAUDE.md                 ← file này
├── docs.md                   ← trạng thái + roadmap + hạn chế đã biết
├── docker-compose.yml        ← nguồn sự thật cho mọi env var runtime
├── .env                      ← secret, chmod 600, gitignored
│
├── infra/
│   └── n8n.Dockerfile        ← n8n + static ffmpeg + font (multi-stage)
│
├── host/                     ← chạy trên máy bạn
│   ├── deploy.js             ← điểm vào duy nhất để deploy
│   ├── inspect-execution.js  ← debug một lần chạy
│   ├── verify-sync.js        ← regression test cho drift phụ đề
│   ├── lib/
│   │   ├── config.js         ← đọc .env
│   │   └── n8n.js            ← REST client + upsertWorkflow
│   ├── tiktok-auth.js        ← OAuth một lần; uỷ quyền token cho container
│   ├── imagegen/             ← ⚠ KHÔNG CÒN DÙNG (ảnh giờ lấy từ stock), giữ để tham khảo
│   │   ├── server.py         ← SD1.5 + LCM trên MPS, HTTP :7860
│   │   └── run.sh
│   ├── imagereview/          ← Claude chấm điểm ảnh stock theo lô, HTTP 127.0.0.1:7861
│   │   ├── server.js
│   │   ├── check.js          ← kiểm thang điểm trên fixture
│   │   └── fixtures/
│   └── workflows/            ← MỘT FILE = MỘT WORKFLOW
│       ├── shadowing.js
│       ├── shadowing-stub.js
│       ├── tiktok-publish.js  ← đường trực tiếp, chỉ bỏ draft vào hộp thư
│       └── buffer-publish.js  ← đường đang dùng, đăng công khai
│
├── container/                ← chạy trong container n8n
│   ├── cli/                  ← gọi bởi Execute Command node
│   │   ├── probe_durations.js
│   │   ├── lib/pick_best.js  ← chọn ảnh theo điểm (+ pick_best.test.js, chạy trên host)
│   │   ├── fetch_scenes.js
│   │   ├── fetch_music.js
│   │   ├── build_video.js
│   │   ├── tiktok_token.js   ← CHỦ SỞ HỮU DUY NHẤT của vòng đời OAuth token
│   │   └── tiktok_publish.js
│   └── nodes/                ← nội dung Code node, nhóm theo workflow
│       ├── shadowing/
│       │   ├── 01_prepare_run.js
│       │   ├── 02_parse_normalize.js
│       │   ├── 03_build_srt.js
│       │   ├── 04_build_response.js
│       │   ├── 05_collect_stock.js
│       │   └── 06_unsplash_downloads.js
│       ├── tiktok-publish/
│       │   ├── 01_resolve_video.js
│       │   └── 02_build_response.js
│       └── buffer-publish/
│           ├── 01_resolve_video.js
│           ├── 02_build_buffer_request.js
│           └── 03_build_response.js
│
├── build/                    ← SINH RA bởi deploy.js, không sửa tay
│   ├── shadowing.json
│   ├── shadowing-stub.json
│   ├── tiktok-publish.json
│   └── buffer-publish.json
│
├── publish.config.json       ← bucket/region/channel — KHÔNG phải secret, có trong git
│
├── secrets/                  ← chmod 600, gitignored (trừ file .example)
│   └── tiktok.json           ← ngoại lệ duy nhất, vì token xoay vòng
│
├── assets/                   ← input do người dùng đưa vào (ảnh nền, nhạc)
│   └── music/                ← bed nhạc bạn tự bỏ vào; `.openverse/` là cache tải về
├── output/                   ← mp4 + .srt + .json + _cover.jpg (đường dẫn nằm trong spec gốc)
├── work/                     ← scratch theo từng run, xoá được bất cứ lúc nào
└── n8n_data/                 ← volume DB của n8n, ĐỪNG ĐỤNG
```

---

## Quy tắc khi thêm code

### Thêm workflow mới

1. Tạo `host/workflows/<slug>.js`, export `definition({ credentials })` trả về
   `{ name, slug, webhookPath, nodes, connections, settings }`.
2. Code node của nó đặt ở `container/nodes/<slug>/NN_ten_buoc.js` — đánh số theo
   thứ tự chạy.
3. Đăng ký vào `REGISTRY` trong `host/deploy.js`.
4. `node host/deploy.js <slug>`.

Nếu workflow mới là biến thể của cái đã có (như `shadowing-stub`), **import
definition gốc rồi sửa trên bản sao trong bộ nhớ** — đừng copy file. Xem
`host/workflows/shadowing-stub.js`.

### Thêm bước xử lý media

Vào `container/cli/`. Phải:
- Nhận đường dẫn qua `process.argv`, không đọc env
- In **một dòng JSON** ra stdout (Code node phía sau `JSON.parse($json.stdout)`)
- Ghi lỗi ra stderr, exit code khác 0 khi hỏng
- Bỏ qua file thiếu thay vì throw — xem `probe_durations.js`, một câu TTS hỏng
  không được làm sập cả video

### Sửa Code node

Sửa file trong `container/nodes/`, rồi **phải chạy lại `host/deploy.js`**. n8n giữ
bản sao nội dung trong DB; sửa file trên đĩa không tự áp dụng.

### Không bao giờ

- ❌ Hardcode API key vào node JSON hay `host/workflows/*.js` — dùng n8n Credentials,
  truyền id qua `.env`
- ❌ Sửa tay `build/*.json` — sinh ra tự động, sẽ bị ghi đè
- ❌ Ghi ngoài `/data/workflow`
- ❌ Dùng `jq`/`curl`/`bash` trong `container/**`
- ❌ Đổi `NODES_EXCLUDE` hay `N8N_RESTRICT_FILE_ACCESS_TO` mà không ghi lý do ngay
  tại chỗ trong `docker-compose.yml` — cả hai đều đang nới lỏng mặc định bảo mật

---

## Lệnh thường dùng

```bash
cd /Users/sangnguyen/Projects/ad-test/data/workflow

docker compose up -d --build        # dựng lại sau khi sửa infra/n8n.Dockerfile
docker compose ps                   # trạng thái 2 container
docker compose logs -f n8n

node host/deploy.js                 # deploy tất cả, upsert theo tên (giữ id + URL)
node host/deploy.js shadowing       # chỉ một cái
node host/deploy.js --no-activate   # push nhưng không activate

node host/inspect-execution.js      # xem lần chạy gần nhất, từng node
node host/inspect-execution.js 12   # một execution cụ thể

node host/verify-sync.js            # audit drift phụ đề của run mới nhất
node host/verify-sync.js <runId>    # exit code != 0 nếu lệch — dùng được làm cổng kiểm tra

# Claude chấm ảnh stock (tuỳ chọn; không bật thì mỗi cảnh lấy ứng viên đầu tiên)
node host/imagereview/server.js &   # dùng `claude` đã đăng nhập, cổng 127.0.0.1:7861
curl -s localhost:7861/health
node host/imagereview/check.js      # kiểm thang điểm sau mỗi lần sửa prompt/model
#   reviewImages: true (mặc định) | false
#   passScore: 72 (mặc định) — ảnh cao nhất ≥ ngưỡng được dùng; không đạt vẫn dùng, ghi FAIL

node --test container/cli/lib/*.test.js      # test logic chọn ảnh

# test không tốn quota Groq (free tier chỉ ~1 video/phút)
curl -X POST http://localhost:5678/webhook/shadowing-stub \
  -H 'Content-Type: application/json' -d '{"topic":"smoke test"}'

# chạy thật
curl -X POST http://localhost:5678/webhook/shadowing \
  -H 'Content-Type: application/json' \
  -d '{"topic":"asking for directions","sentenceCount":6,"gapSeconds":3}'
```

### Chạy tự động mỗi ngày

Workflow **`daily`** (`host/workflows/daily.js`) dựng lúc **18:00** và hẹn Buffer
đăng lúc **19:00** cùng ngày, múi giờ `Asia/Ho_Chi_Minh`. Nó gọi lại chính hai
webhook `shadowing` và `buffer-publish` chứ không nhân bản node của chúng — hai
endpoint đó là thứ đã được bấm tay suốt quá trình, một đường chạy khác sẽ là thêm
một thứ nữa phải tin. Một tiếng dự phòng giữa dựng và đăng là có chủ ý: dựng mất
~100s khi mọi thứ ngoan, nhưng nó phải với tới Groq, ảnh stock, Claude và S3.

**Chủ đề lấy từ `topics.json`, chọn theo *ít dùng gần đây nhất*** — không phải
ngẫu nhiên, vì ngẫu nhiên lặp lại sớm hơn người ta tưởng nhiều. Danh sách tự xoay
vòng và sửa lúc nào cũng được; `history` do workflow ghi, đừng sửa tay.

⚠ **`schedulingType` bắt buộc trên MỌI post Buffer, kể cả post hẹn giờ.** Thiếu nó
là `GRAPHQL_VALIDATION_FAILED`. Và nó **không** phải thứ đặt giờ — enum chỉ có
`automatic` (Buffer đăng) và `notification` (Buffer chỉ nhắc); giờ do `mode:
customScheduled` + `dueAt` quyết định. Lỗi này ngốn nguyên một lần chạy lịch mới
lộ, vì video dựng xong hoàn hảo và chỉ khâu đăng chết.

⚠ **Máy ngủ thì lịch không chạy.** n8n sống trong Docker trên máy bạn; macOS ngủ
là container dừng:

```bash
caffeinate -s                                      # giữ thức, chạy trong 1 terminal
sudo pmset repeat wakeorpoweron MTWRFSU 17:55:00   # hoặc tự thức trước 18:00
```

**Generator ảnh không còn dùng** (2026-10-10). Nếu LaunchAgent cũ còn nạp thì gỡ
để khỏi chiếm ~3 GB RAM vô ích:

```bash
launchctl unload ~/Library/LaunchAgents/com.shawnspace.imagegen.plist
rm ~/Library/LaunchAgents/com.shawnspace.imagegen.plist
```

**Reviewer phải chạy lúc 18:00**, không thì mọi cảnh lấy ứng viên đầu tiên, không ai chấm:

```bash
cp host/imagereview/com.shawnspace.imagereview.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.shawnspace.imagereview.plist
```

### TikTok

App phải đăng ký **platform Desktop** trong Login Kit, redirect
`http://localhost:3455/callback/`. Đó là lý do có loopback: platform **Web** bị ép
"absolute and begins with https", không có ngoại lệ cho localhost. Đổi lại Desktop
**bắt buộc PKCE**.

⚠️ **PKCE của TikTok không theo RFC 7636.** Chuẩn là `BASE64URL(SHA256(verifier))`;
TikTok muốn **HEX** (`CryptoJS.SHA256(v).toString(CryptoJS.enc.Hex)`). Gửi bản
base64url thì bước authorize bị từ chối mà không có gì chỉ ra nguyên nhân. Xem
`pkce()` trong `host/tiktok-auth.js`.

Cần **hai** product trong portal: **Login Kit** (giữ redirect URI + OAuth) và
**Content Posting API** (mở scope `video.upload`).

```bash
# một lần duy nhất: uỷ quyền
cp secrets/tiktok.example.json secrets/tiktok.json && chmod 600 secrets/tiktok.json
# điền clientKey / clientSecret rồi:
node host/tiktok-auth.js            # mở trình duyệt, tự bắt callback trên :3455
node host/tiktok-auth.js --manual   # nếu cổng bị chiếm: in URL rồi dán lại
node host/tiktok-auth.js --status   # không in secret

# đẩy một run vào hộp thư TikTok
curl -X POST http://localhost:5678/webhook/tiktok-publish \
  -H 'Content-Type: application/json' -d '{"runId":"20261003160036_3tk7w2"}'

# thử đường ống mà không gọi TikTok (không cần credential)
curl -X POST http://localhost:5678/webhook/tiktok-publish \
  -H 'Content-Type: application/json' -d '{"runId":"<id>","dryRun":true}'
```

### Buffer (đường đang dùng)

```bash
# 1. khoá: http://localhost:5678 > Credentials
#    - "AWS S3"     (aws)            region + accessKeyId + secretAccessKey
#    - "Buffer API" (httpHeaderAuth) name=Authorization  value=Bearer <key>
# 2. phần không phải khoá: sửa publish.config.json (bucket, region, channelId)

# đăng vào khe tiếp theo của hàng đợi
curl -X POST http://localhost:5678/webhook/buffer-publish \
  -H 'Content-Type: application/json' -d '{"runId":"20261003161149_66yqew"}'

# hoặc hẹn giờ cụ thể (ISO 8601 UTC)
curl -X POST http://localhost:5678/webhook/buffer-publish \
  -H 'Content-Type: application/json' \
  -d '{"runId":"<id>","dueAt":"2026-10-05T09:00:00.000Z"}'

```

**Free plan của Buffer: 100 request/15 phút, 100/24h, 3000/30 ngày.**

**Hạn mức ~5 draft chờ / 24h.** Vì thế `01_resolve_video.js` **từ chối** video
không phải 9:16 thay vì tiêu một suất vào bản letterbox, và node upload **không
retry** — retry sau một lần upload dở dang là tiêu suất thứ hai.

---

## Secret

- `.env` (chmod 600, gitignored) chỉ giữ **khoá hạ tầng** và **id của credential** —
  không giữ khoá nhà cung cấp.
- Khoá nhà cung cấp (Groq, và sau này TikTok/Google) nằm **duy nhất** trong
  credential store đã mã hoá của n8n.
- **Public API v1 không cho sửa giá trị credential.** Muốn đổi khoá: `DELETE` rồi
  `POST` tạo lại, cập nhật `CRED_*_ID` trong `.env`, chạy lại `host/deploy.js`.
  Đừng tốn công với internal `/rest` API — nó cần session cookie và payload đổi
  theo từng bản n8n.
- Đừng in khoá ra log. Khi cần kiểm tra thì in độ dài và 4 ký tự đầu.

**Ngoại lệ có chủ ý: TikTok ở `secrets/tiktok.json`, không ở credential store.**

Lý do nằm ngay trong gạch đầu dòng phía trên: *Public API v1 không cho sửa giá trị
credential*. Mà `refresh_token` của TikTok **xoay mỗi lần refresh** — TikTok nói rõ
"the returned refresh_token may be different than the one passed in", và bản cũ
chết ngay. Một giá trị đổi hằng ngày thì credential store **không chứa nổi**. Đã
cân nhắc tách đôi (client secret ở n8n, token ở file) và loại: n8n không có
credential type nào nhét được `client_key`/`client_secret` vào **body**
form-urlencoded, và chia một bí mật ra hai nơi thì khó lý giải hơn là gộp.

Hệ quả phải tôn trọng:
- File `chmod 600`, `secrets/` gitignored (chừa `tiktok.example.json`).
- Mọi lần ghi phải **atomic** (temp + rename). Mất `refresh_token` giữa chừng là
  phải quay lại màn hình consent trên trình duyệt.
- **Chỉ `container/cli/tiktok_token.js` được đụng vào file này.** `host/tiktok-auth.js`
  gọi qua `docker exec` chứ không tự tính toán token — một bản cài đặt, không có
  bản thứ hai để lệch.

**Đổi tài khoản owner n8n** (email/password đăng nhập UI):

```bash
docker exec shadowing-n8n n8n user-management:reset   # xoá user, GIỮ workflow + credential
docker compose restart n8n
# rồi POST /rest/owner/setup với N8N_OWNER_EMAIL / N8N_OWNER_PASSWORD mới trong .env
```

`user-management:reset` gán lại toàn bộ workflow và credential cho owner mới, nên
Groq key không mất. Dù vậy **hãy backup `n8n_data/` trước** — key nhà cung cấp chỉ
tồn tại ở đó, không có bản sao nào khác. API key cũ vẫn dùng được vì user id không đổi.

---

## Bốn env var không được xoá

Ở `docker-compose.yml`, mỗi cái đã có comment giải thích ngay tại chỗ:

| Var | Vì sao cần |
|---|---|
| `NODES_EXCLUDE=[]` | n8n 2.0 **disable Execute Command mặc định**; đây là cách bật lại |
| `N8N_RESTRICT_FILE_ACCESS_TO=/data/workflow` | mặc định chỉ cho ghi `~/.n8n-files` |
| `NODE_FUNCTION_ALLOW_BUILTIN=fs,path,child_process,crypto` | Code node cần `fs` |
| `N8N_RUNNERS_ENABLED=true` | Code node trong n8n 2.x cần task runner |

`.env` còn giữ **id** của credential (`CRED_GROQ_ID`, `CRED_EDGETTS_ID`,
`CRED_UNSPLASH_ID`, `CRED_AWS_ID`, `CRED_BUFFER_ID`) — chỉ là id,
không phải giá trị. `host/deploy.js` nối chúng vào node lúc deploy.

**Unsplash** là credential `httpHeaderAuth`: name `Authorization`, value
`Client-ID <access key>`. Bản demo 50 request/giờ — một run ~7–9 request. API
guidelines của họ bắt gọi `download_location` cho mỗi ảnh dùng; nhánh phụ
`Unsplash Downloads → Track Unsplash Download` sau `Fetch Scenes` làm việc đó.

**Pexels đã gỡ (2026-10-10).** Key chưa từng hợp lệ, mỗi run tốn 14 request 401,
và Pexels đã ngừng cấp key mới. Credential `Pexels API` vẫn còn trong n8n nhưng
không node nào dùng.

---

## Những chỗ dễ sập nhất

**Timing phụ đề.** `container/nodes/shadowing/03_build_srt.js` và
`container/cli/build_video.js` **phải đồng ý về cùng một phép tính**: câu thứ `i`
bắt đầu tại tổng của mọi `(duration + gap)` trước nó. Sửa một bên mà quên bên kia
thì phụ đề lệch dần và không ai nhận ra cho tới khi xem hết video. Hiện drift đo được là **0.0 ms**.

**Chạy `node host/verify-sync.js` sau mọi thay đổi động tới audio hoặc timeline.** Nó
đối chiếu SRT với phép tính, rồi đối chiếu tiếp với **file mp4 thật** bằng
`silencedetect` — vì một độ trễ đều toàn bộ track vẫn thoả mãn phép tính mà vẫn sai
trên màn hình. Đây cũng là lý do **không dùng filter `loudnorm`**: nó có thể đổi số
sample. Dùng `volume` + `alimiter` (đã kiểm chứng giữ nguyên độ dài PCM).

Đây cũng là lý do `probe_durations.js` chuyển mp3 sang WAV rồi mới đo: mp3 mang
padding của encoder, lệch vài ms mỗi file, cộng dồn 8 câu là thấy rõ.

**Nhạc nền lấp khoảng lặng, nên onset check tự bỏ qua khi có bed.** Thay vào đó
`build_video.js` **so số sample** trước/sau khi mix và ghi vào run record; verify-sync
fail nếu hai số khác nhau. Nhưng đó là kiểm tra số học — **sau mỗi lần sửa timeline,
chạy thêm một run `{"music": false}`** để onset check (thứ duy nhất nhìn vào pixel
thật) được thực thi.

**`amix` mặc định `normalize=1`** — nó chia biên độ cho số input, tức là hạ giọng
6 dB để nhường chỗ cho bed thấp hơn giọng 30 dB. Luôn viết `normalize=0`.

**Sáu cái bẫy của ffmpeg đã cắn một lần.** Hầu hết đều **không báo lỗi**, chỉ cho ra
video sai — nên phải kiểm chứng bằng pixel, đừng tin là nó chạy:

1. **`force_style` dùng *script unit* của ASS, không phải pixel.** SRT chuyển sang ASS
   có `PlayResY=288`, libass nhân mọi thứ với `frameHeight/288`. Đưa thẳng pixel vào
   thì đúng *tình cờ* ở 720p và đẩy chữ ra ngoài khung ở 1920 — ra video **trắng trơn**.
   `original_size` **không** sửa được. `Outline`/`Shadow` cũng là script unit.
2. **`drawbox` chỉ evaluate `w`/`h`/`x`/`y` một lần lúc config, không phải mỗi frame.**
   Expression có `t` sẽ ra 0 tại t=0, mà drawbox hiểu `w=0` là "kéo tới mép khung".
   Muốn animate thì chia thành nhiều box width tĩnh + `enable='between(t,...)'`.
3. **Trong nháy đơn của ffmpeg, đừng escape dấu phẩy bằng `\\,`.** Nháy đơn đã bỏ
   ý nghĩa phân tách rồi; thêm backslash làm expression fail lặng lẽ.
4. **`text=` của `drawtext` đứt ở dấu hai chấm.** `text='0:39'` làm ffmpeg báo
   `No option name near '39...'` và **từ chối cả filter graph**. Nháy đơn không cứu
   được vì parser tách option trước. Luôn dùng `textfile=` — cũng là lý do mọi
   chuỗi trong `renderCard()` đều đi qua `writeTextFile()`.
5. **`drawbox` với `x=(w-N)/2` dán vào mép trái.** Đây là hệ quả cụ thể của bẫy #2
   ở trên: geometry chỉ evaluate một lần lúc config, lúc đó `w` chưa có nên đọc ra
   0, thành `(0-N)/2` âm và bị kẹp về 0. **Tính sẵn bằng JS** rồi đưa số vào. Đã
   cắn một lần ở gạch nhấn của title card.
6. **`drawtext` với `textfile` đo mỗi dòng bằng BYTE rồi vẽ ra bấy nhiêu KÝ TỰ.**
   Mỗi ký tự non-ASCII ăn mất một ký tự ở **cuối chính dòng đó**. `"… · 0:38"` ra
   `"… · 0:"`; tiêu đề tiếng Việt mất một chữ mỗi dòng. Cách chữa nằm ở
   `writeTextFile()` trong `build_video.js`: đệm mỗi dòng thêm một dấu cách cho mỗi
   byte UTF-8 dôi ra — phần bị cắt chính là mấy dấu cách đó nên không vẽ thừa gì.
   **Đừng đổi sang `text=`**: chủ đề là input người dùng, phải escape qua hai tầng
   parser của ffmpeg.

### Hai cái bẫy của n8n khi viết Code node

1. **n8n cắt thông báo lỗi của Code node tại dấu hai chấm CUỐI CÙNG.** Phần phía
   trước không bao giờ tới được người gọi. Đã đo:
   `"... is 1280x720, not 9:16. TikTok allows..."` → người gọi nhận `"16. TikTok allows..."`;
   `'topic is required - POST e.g. {"topic":"x"}'` → nhận `'"x"}'`.
   Nên **mọi `throw` trong `container/nodes/**` phải không có dấu hai chấm** — dùng
   ` - `. Dump JSON thì phải `.replace(/:/g, '=')` trước khi nhét vào message, xem
   `brief()` trong `02_parse_normalize.js`.

2. **Node có hai đầu ra thì `$('Tên node')` không giải được từ phía dưới** — nó
   trả `undefined` và node sau chết ở chỗ đọc `.json`. Gặp khi `Resolve Video`
   được bật `onError: continueErrorOutput`. Cách chữa đã dùng: **ghi một file plan**
   rồi truyền đường dẫn, đúng khuôn `build_video.js` đã làm. Đừng cố vật lộn với
   biểu thức.

   Kèm theo: `Execute Command` khi exit code khác 0 thì n8n **vứt luôn stdout** và
   chỉ đưa ra `{error}`. Nên `tiktok_publish.js` cố ý in lỗi vận hành thành JSON
   rồi **exit 0** — ngoại lệ với quy tắc "exit khác 0 khi hỏng" ở trên, lý do ghi
   ngay trong file.

### Đăng lên TikTok qua Buffer

Chọn Buffer vì nó là **đối tác được TikTok duyệt**: post ra công khai, theo lịch,
không cần audit Content Posting API và không phải bấm tay trong app. Đường trực
tiếp (`tiktok-publish`) vẫn giữ nhưng chỉ bỏ được draft vào hộp thư.

**Buffer không có endpoint upload.** Tài liệu của họ: asset phải "reachable over
the public internet without authentication" và "must stay reachable **until the
post publishes**, not just when you create it". Mà `mode` chỉ có `addToQueue` hoặc
`customScheduled` — **không có đăng ngay** — nên khe hàng đợi có thể chạy vài giờ
sau. Hệ quả: tunnel tạm và URL ký/hết hạn đều **không dùng được**; file phải nằm ở
S3 công khai. Đó là lý do có hẳn một chặng S3 trước khi gọi Buffer.

Google Drive **không dùng được** — Buffer gọi đích danh: "Links that require a
viewer to be signed in — for example a Google Drive or Dropbox 'share' link — will
not work."

**Buffer hỏng ở BA chỗ khác nhau**, và "luôn trả 200" chỉ đúng với hai trong số đó.
API key sai là **HTTP 401 thẳng** — đã đo, không phải suy đoán:
- `body.errors[]` — `UNAUTHORIZED`, `NOT_FOUND`, `RATE_LIMIT_EXCEEDED`
- `data.createPost` trả về union; thất bại là `MutationError` **nằm trong `data`**,
  không phải trong `errors`

- HTTP **401** với token sai, node HTTP trả về dạng `{error:{message}}` hoàn toàn khác

Nên một response có thể 200, `errors` rỗng, mà **không đăng gì cả**. Phải xin
`__typename` và kiểm cả ba nhánh — xem `03_build_response.js`.

### Khoá nằm ở n8n, không nằm trong file

Mọi bước chạm vào khoá đều là **node gốc của n8n** — `awsS3` dùng credential `aws`,
HTTP Request dùng `httpHeaderAuth` cho Buffer. Khoá do credential store mã hoá giữ
và sửa trên UI; **không Code node nào nhìn thấy chúng**. Đúng kiểu Unsplash đã làm
(xem `05_collect_stock.js`).

Thứ không phải khoá — bucket, region, prefix, channelId — nằm ở
**`publish.config.json`**, có trong git để diff được. Lưu ý `s3.region` ở đây phải
**trùng** region đặt trên credential: credential ký request, config dựng URL công khai.

> Đã từng tự ký SigV4 bằng `crypto` trong một CLI script (image hardened không cài
> được `aws-sdk`), và nó chạy đúng — khớp test vector chính thức của AWS. Nhưng
> cách đó buộc khoá phải nằm trong file, nên đã bỏ khi chuyển sang node `awsS3`.

Hai thứ về bucket, cả hai đều là mặc định **mới** của AWS và đều làm Buffer nhận 403:
- **ACL bị tắt** trên bucket tạo từ 2023 trở đi. Gửi `x-amz-acl: public-read` sẽ bị
  từ chối với `AccessControlListNotSupported`. Để `s3.acl` rỗng và mở công khai
  bằng **bucket policy**.
- **Block Public Access** bật sẵn. Phải tắt thì policy mới có hiệu lực.

**Lần post đầu tiên ngay sau khi mở công khai bucket có thể hỏng một lần.** Đo
được: `Invalid post: Video could not be read from its URL` trong khi URL đó tải
đầy đủ 2.7MB và decode ra h264+aac bình thường từ máy khác. **Gửi lại y nguyên là
thành công.** Nhiều khả năng Buffer nhớ kết quả hỏng của lần thử trước đó (lúc
object còn 403), hoặc policy chưa lan hết. Nếu gặp lại thì cứ gọi lần hai trước
khi đi tìm nguyên nhân ở chỗ khác.

Node **`Verify Public URL`** kiểm lại sau khi upload: GET **ẩn danh** (cố tình
không gắn credential, vì phải tái hiện đúng thứ server của Buffer thấy), lấy 64
byte đầu, và đòi trong đó có `ftyp`. S3 trả lỗi bằng XML kèm HTTP 200 nên chỉ nhìn
status là không đủ. Hỏng ở đây thì biết ngay, chứ không phải vài giờ sau trong
hàng đợi Buffer nơi không có gì nói lý do.

### Title card thương hiệu

**Buffer không nhận ảnh bìa riêng.** Chỉ có `thumbnailOffset` — một mốc mili giây
để lấy frame **từ chính video**. Tài liệu còn ghi rõ nếu gửi kèm URL thumbnail thì
Buffer *nhận nhưng không áp dụng*. Nên muốn bìa có thương hiệu trên lưới profile,
nó **bắt buộc phải nằm trong video**, không thể là file jpg riêng.

Vì thế `build_video.js` đốt một thẻ 1.2s vào đầu video, và `coverTimestamp()` trỏ
vào **giữa thẻ**. File `_cover.jpg` giờ chỉ là ảnh chụp lại đúng frame đó, nên bìa
và video không thể nói hai điều khác nhau.

**`introMs` là số nguyên mili giây, và đó là bắt buộc.** Ở 24 kHz, một mili giây
đúng bằng 24 sample. Nhờ vậy khoảng lặng `adelay` chèn vào audio và độ dịch áp lên
mọi cue phụ đề là **cùng một số sample nguyên**. Một giá trị lẻ sẽ làm hai bên
lệch nhau vài sample — chính là thứ drift mà cả dự án này dựng lên để tránh.

Quyết định ở **một chỗ duy nhất**: `01_prepare_run.js`. Từ đó chảy sang
`03_build_srt.js` (dịch cue) và `build_video.js` (chèn im lặng). Sửa một bên mà
quên bên kia thì toàn bộ phụ đề lệch đúng bằng độ dài thẻ.

**`verify-sync.js` phải hạ ngưỡng `silencedetect` theo cái ngắn hơn giữa gap và
thẻ.** Đo được: thẻ 1.2s với gap 2.5s thì ngưỡng cũ (gap × 0.6 = 1.5s) **đi lướt
qua luôn khoảng mở đầu**, đếm thiếu một onset, và cả phép kiểm tự bỏ qua mà không
ai để ý.

Thẻ được đánh dấu `raw` trong scene chain nên **không bị làm tối và không bị phủ
scrim** như ảnh cảnh — nó đã được thiết kế sẵn, dimming sẽ làm chết màu nhấn.

**Trang kết** (`renderOutroCard()`) là phần cuối của cùng timeline đó, cũng `raw`. Nó
nằm sau cue cuối nên không dịch phụ đề, nhưng **file dài thêm `outroSec`** — audio
được nối thêm bằng `apad=pad_len` (sample), và `verify-sync.js` phải cộng
`record.outroSec` khi so độ dài mp4, không thì báo lệch đúng bằng độ dài trang kết.

### Sinh ảnh cảnh bằng SD 1.5 (chạy trên host)

> ⚠ **Lịch sử — không còn trong pipeline từ 2026-10-10.** Ảnh cảnh giờ lấy từ
> Unsplash/Openverse và được Claude chấm điểm (mục kế tiếp). Phần dưới giữ
> lại vì các con số đo được vẫn đúng nếu có ngày quay lại sinh ảnh.

**Không thể đưa vào `docker-compose`.** Docker Desktop trên macOS không với được
GPU Metal — đã kiểm `/dev` trong container, không có thiết bị GPU nào. Chạy trong
container nghĩa là rơi về CPU, mỗi ảnh vài phút. Nên nó chạy **native trên máy** ở
`:7860`, và container gọi sang bằng `host.docker.internal` (đã kiểm chứng phân
giải được từ bên trong).

Đây là ngoại lệ Python duy nhất của dự án. Mọi thứ khác vẫn là Node.

**Ba con số đo được, đừng chỉnh mò lại:**

| Tham số | Giá trị | Vì sao |
|---|---|---|
| `guidance` | **1.0** | Tắt CFG, đúng thứ LCM được chưng cất. Ở 1.5 ảnh bạc màu và **chậm gấp đôi** (14s so với 7s) vì CFG nhân đôi forward pass |
| `steps` | **4** | LCM là sampler 4 bước, không phải thanh trượt. Ở 8 bước ảnh **sụp thành một mảng phẳng** |
| style | 2 từ | Bản đầu thêm `shallow depth of field, 35mm, candid` và **mọi cảnh nhoè tới mức không nhận ra** — từ khoá style lấn át chủ thể ở 4 bước |

**Cái bẫy lớn nhất: prompt cho máy tìm ảnh ≠ prompt cho máy vẽ ảnh.**

`imageQuery` Groq sinh ra là từ khoá cho stock index — 2-4 danh từ rời. Đưa thẳng
cho diffusion model thì hỏng: `"team standup meeting office whiteboard"` trả về
**một bức tranh thảm Ba Tư**, và đổi seed vẫn hỏng. Viết lại thành câu tả cảnh —
`"colleagues standing around a whiteboard in a bright modern office"` — thì ra
đúng ngay. Nên prompt giờ xin Groq **hai trường**: `imageQuery` cho stock,
`imagePrompt` (một câu) cho máy vẽ.

**Hai nhân vật cố định, khoá bằng IP-Adapter.** Mỗi video dùng đúng hai nhân vật
anime trong `assets/characters/A.png` và `B.png`. Hội thoại vốn đã luân phiên
speaker A/B, nên `fetch_scenes.js` gửi kèm `character: sentence.speaker` và server
nạp đúng chân dung đó làm tham chiếu. Bộ nhân vật đồng nhất, miễn phí, không cần
thêm dữ liệu nào.

- Dùng bản **`-plus-face`**: bản thường copy cả bố cục ảnh gốc, cho ra sáu bức
  chân dung giống hệt nhau thay vì sáu cảnh khác nhau.
- `IP_SCALE` **0.40** — đây là mặc định trong `server.py`, đừng chép lại con số
  ở đâu khác. Đo trên cùng prompt+seed: **0.55 nuốt mất phong cảnh** (nền trơn
  của ảnh tham chiếu bị kéo sang), 0.28 giữ cảnh nhưng tóc trôi khỏi tham chiếu,
  0.40 giữ được cả hai. Lý lẽ đầy đủ nằm ngay trong `server.py:82-91`.
- Nạp **sau** `fuse_lora()`, không phải trước.
- ⚠ **Giống, không phải trùng khít.** Tóc, mắt, trang phục giữ được qua các cảnh;
  khuôn mặt trôi nhẹ, và tóc nhân vật nam ngả tím so với xanh navy của ảnh gốc.
  Muốn khoá tuyệt đối thì phải train LoRA riêng cho nhân vật — việc khác hẳn.
- Thay nhân vật = thay hai file PNG đó **và `assets/characters/traits.json`**,
  không đụng code. Bản trước nằm ở `assets/characters/previous/`.
- **`traits.json` là thứ adapter không mang được.** Bản `-plus-face` chỉ chuyển
  khuôn mặt, nên tóc và trang phục phải đi bằng chữ trong prompt. Đo trên cặp
  hiện tại: trước khi có traits, tóc nhân vật nữ ra ngang vai ở cảnh này và nâu
  đỏ ở cảnh kia; thêm traits thì tóc dài đen giữ được và blazer/cà vạt của nam
  ổn định.
  ⚠ **Chưa giải quyết xong**: màu tóc nam vẫn trôi sang đỏ ở khoảng 4/6 seed.
  Nguyên nhân là `guidance_scale` mặc định **1.0** — không có classifier-free
  guidance thì prompt bám rất yếu và thiên kiến của model thắng. Nâng guidance
  sẽ cải thiện nhưng tăng gấp đôi thời gian sinh; chưa thử.
- **Nguồn gốc bộ nhân vật hiện tại (2026-10-04)**: cắt từ một khung phim Your Name
  (`assets/characters/source.png`), theo yêu cầu rõ ràng của chủ kênh — mặt phải
  giống ảnh gốc, không chế.
  ⚠ **Rủi ro đã biết, không phải đã giải quyết**: đó là IP của CoMix Wave Films.
  Dùng làm dàn nhân vật cố định cho một kênh đăng công khai hằng ngày có rủi ro bị
  gỡ video, và buộc bản sắc kênh phụ thuộc tài sản của người khác. Trước đó bộ
  nhân vật do chính pipeline sinh ra nên không vướng điều này; bản cũ còn ở
  `assets/characters/previous/` nếu cần quay lại.
  Muốn vừa giống mỹ học vừa sở hữu hoàn toàn thì sinh nhân vật gốc theo cùng phong
  cách — gọi `/generate` không truyền `character`.
- **Sinh nhân vật mới**: gọi `/generate` **không truyền `character`**. Nhớ là một
  khi IP-Adapter đã nạp thì UNet luôn đòi `image_embeds`, nên server tự đưa ảnh
  trắng với scale 0 — thiếu cái đó là vỡ với
  `argument of type 'NoneType' is not iterable`.

**Model là Counterfeit V2.5 (anime), không phải Realistic Vision.** Đổi vì series
dùng nhân vật anime cố định, mà mặt vẽ thì không có thung lũng kỳ lạ để rơi vào.
Đánh đổi đã đo: model này **bám prompt lỏng hơn rõ rệt** — "server rack with a red
warning light" ra một hành lang đỏ, và cảnh nhóm không có nhân vật trung tâm ra
một lưới phác thảo vô nghĩa. Nó muốn **một nhân vật làm một việc**, nên
`SYSTEM_PROMPT` giờ bắt Groq viết đúng dạng đó.

Đổi model bằng `IMAGEGEN_MODEL`. Bản ảnh thật trước đó là
`SG161222/Realistic_Vision_V6.0_B1_noVAE`, file `..._NV_B1_fp16.safetensors`.

**Prompt không bẻ được phong cách.** Đã thử ép `anime illustration` và
`flat vector illustration` lên model ảnh thật: ra nửa nạc nửa mỡ, vẫn kết cấu ảnh
chụp và mặt vẫn gượng. Phong cách nằm ở trọng số, không nằm ở prompt.

**Ghi chú cũ về Realistic Vision V6 (vẫn đúng nếu quay lại dùng nó):** Cùng kiến trúc nên LCM-LoRA
của SD1.5 vẫn áp được và tốc độ không đổi (~7.3s), nhưng ảnh ra là ảnh thật.
Đo bằng `signalstats` trên cùng prompt và seed: bão hoà **5-8 → 18-28**, và mặt
người từ chỗ biến dạng thành bình thường.

Tải bằng **`from_single_file`** trỏ vào file fp16 **1.99 GB**, không phải
`from_pretrained` — thư mục diffusers của repo đó là `.bin` fp32 cộng safety
checker, khoảng **5 GB cho cùng bộ trọng số**.

⚠ **Tên repo có chữ `noVAE` không phải trang trí** — checkpoint không kèm VAE, phải
nạp riêng `stabilityai/sd-vae-ft-mse`, nếu không decoder cho ra màu loang.

**Đừng viết phủ định vào prompt dương.** Bản trước bắt Groq ghi `"no faces visible"`
và generator **vẫn vẽ mặt** — diffusion model đọc prompt dương như một túi thứ cần
có, nên phủ định trong đó bị bỏ qua, thậm chí phản tác dụng. Cái thật sự có hiệu
quả lúc đó là Groq chuyển sang tả **đồ vật** thay vì tả người. Giờ luật được viết
lại thành *nên tả gì* (bối cảnh, đồ vật, bàn tay đang thao tác) chứ không phải
*cấm gì*.

**Nền của title card là ảnh sinh riêng, không phải cảnh số 1.** Groq trả thêm
`coverPrompt` — một cảnh toàn của bối cảnh, **không có người** — và
`fetch_scenes.js` sinh nó thành `cover_bg.jpg` với `character` bỏ trống nên
IP-Adapter về 0. Dùng lại cảnh số 1 thì có một nhân vật đứng đúng chỗ đặt tiêu đề.

Ảnh nền phải bị dìm **hai tầng** trước khi đặt chữ: `eq` rút sáng và màu, rồi một
lớp phủ toàn khung màu nền thương hiệu. Chỉ một tầng thì tiêu đề đánh nhau với
bất cứ thứ gì ngẫu nhiên nằm phía sau. Kèm `borderw` cho mọi dòng chữ trên thẻ —
nền giờ là ảnh, chữ trắng cắt ngang một ô cửa sổ sáng sẽ mất viền đúng chỗ cần rõ
nhất. Có viền rồi mới dám để nền sáng đủ để nhìn thấy.

⚠ **`NEGATIVE` trong `server.py` là đồ trang trí ở guidance 1.0.** diffusers chỉ mã
hoá negative prompt khi CFG bật, tức `guidance_scale > 1.0`. Mặc định là 1.0 nên
**không một từ nào trong đó có tác dụng**. Đừng thêm từ vào đó rồi tưởng đã sửa được
gì — mọi thứ điều khiển được đều nằm ở prompt dương.

**Ảnh sinh ra gần như xám.** Đo bằng `signalstats`: SATAVG 5.1/255. Thêm
`vivid saturated colours` vào prompt đẩy lên 5.14 — vô dụng. Cách có tác dụng là
tăng bão hoà **sau khi sinh** bằng PIL (5.1 → 8.0). Làm ở server chứ không ở
`build_video.js`, vì chỉ ảnh sinh mới cần; ảnh stock đã đủ màu, tăng nữa thì loè.

**Giá phải trả:** ~7s mỗi ảnh trên M2, tức **+45-70s mỗi run**. Run đo được 86s so
với ~20s khi dùng ảnh stock.

**Một GPU thì sinh tuần tự.** `fetch_scenes.js` hạ `MAX_PARALLEL` xuống 1 khi
generator bật — chạy song song chỉ xếp hàng chờ nhau trong khi nhân đôi bộ nhớ
đỉnh, và 16GB thì đó là đường dẫn tới swap chứ không phải tới tốc độ.

### Claude chấm ảnh stock (`host/imagereview/`)

Tìm ảnh stock khớp **từ khoá**, không khớp **câu**: tìm siro cho câu gọi cà phê ra
siro trên bánh pancake, decode hoàn hảo. Nên mỗi cảnh có tới 8 ứng viên
(10 kết quả Unsplash trong `stock.json`, hết thì Openverse), Claude chấm **0–100** từng
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

### Gọi API ảnh bên ngoài

Rút ra khi làm `fetch_scenes.js`, cả ba đều làm mất ảnh một cách im lặng:

- **Luôn gửi `User-Agent` có thật.** Wikimedia và Flickr trả **HTTP 429** cho
  client không khai báo. `fetch()` trần làm hỏng 4/6 ảnh trước khi phát hiện ra.
- **Tìm kiếm trả về *danh sách ứng viên*, không phải câu trả lời.** Openverse gom
  nhiều provider; có provider chặn, có provider phục vụ bình thường. Lấy mỗi kết
  quả đầu là hỏng. Phải thử lần lượt tới khi tải + decode được.
- **Rút gọn query thì bỏ chữ ở ĐẦU, không bỏ ở cuối.** Tiếng Anh đặt danh từ
  chính ở cuối: `"printed hotel invoice"` → `"hotel invoice"` → `"invoice"`.
  Cắt ngược lại ra `"printed hotel"` và trả về tranh khắc Hôtel des Invalides.
- **HTTP 200 không chứng minh đó là ảnh.** Trang lỗi cũng tải về ngon lành.
  Luôn để `ffmpeg`/`ffprobe` decode lại rồi mới tin.

**Câu thoại thương hiệu đầu video.** Nó đi qua **đúng đường TTS của hội thoại**, như
một item `idx 0`, nên không cần node mới và hỏng thì suy biến y hệt một câu hỏng
(không có `sent_000.mp3` → card im lặng, dùng lại `introMs` cấu hình).

Nó **không** nằm trong `manifest.sentences`. Mọi thứ phía sau coi mảng đó là hội
thoại: `fetch_scenes.js` đòi một ảnh cho mỗi phần tử, `03_build_srt.js` đòi một
cue cho mỗi phần tử. Câu thương hiệu không phải cả hai.

Khi có câu thoại, **độ dài đo được của nó thay thế `introMs` cấu hình** — audio
phải dài đúng bằng số chữ thực sự đọc ra. Làm tròn **lên** mili-giây nguyên: ở
24 kHz một mili-giây là đúng 24 sample, làm tròn xuống thì cụt âm cuối.

⚠️ **Pad bằng `apad=whole_len` (đếm sample), tuyệt đối không dùng `whole_dur`.**
Đo trên bản ffmpeg này: input 24000 sample, `whole_dur=2.0` ra **48017**, còn
`whole_len=48000` ra **đúng 48000**. Lệch 17 sample thì không ai nghe thấy — và
đó chính là lý do không được phép để nó bắt đầu.

Phụ lưu ý: khi intro có tiếng, **cue 1 không còn ranh giới im lặng phía trước**
(khoảng `introTailMs` ngắn hơn cửa sổ dò của `silencedetect`), nên
`verify-sync.js` đối chiếu onset với cue 2..N và in rõ điều đó. Đừng "sửa" bằng
cách hạ ngưỡng dò — sẽ bắt nhầm các quãng ngắt giữa câu.

**Index của câu sau node TTS.** HTTP Request node thay `json` bằng binary response,
nên `$json.idx` biến mất. `Write Sentence Audio` lấy lại qua paired item:
`$('Parse & Normalize').item.json.idx`. Đừng đổi tên node `Parse & Normalize` mà
quên sửa biểu thức này.
