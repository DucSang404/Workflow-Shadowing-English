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
│   └── workflows/            ← MỘT FILE = MỘT WORKFLOW
│       ├── shadowing.js
│       └── shadowing-stub.js
│
├── container/                ← chạy trong container n8n
│   ├── cli/                  ← gọi bởi Execute Command node
│   │   ├── probe_durations.js
│   │   ├── fetch_scenes.js
│   │   ├── fetch_music.js
│   │   └── build_video.js
│   └── nodes/                ← nội dung Code node, nhóm theo workflow
│       └── shadowing/
│           ├── 01_prepare_run.js
│           ├── 02_parse_normalize.js
│           ├── 03_build_srt.js
│           ├── 04_build_response.js
│           └── 05_collect_pexels.js
│
├── build/                    ← SINH RA bởi deploy.js, không sửa tay
│   ├── shadowing.json
│   └── shadowing-stub.json
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

# test không tốn quota Groq (free tier chỉ ~1 video/phút)
curl -X POST http://localhost:5678/webhook/shadowing-stub \
  -H 'Content-Type: application/json' -d '{"topic":"smoke test"}'

# chạy thật
curl -X POST http://localhost:5678/webhook/shadowing \
  -H 'Content-Type: application/json' \
  -d '{"topic":"asking for directions","sentenceCount":6,"gapSeconds":3}'
```

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

**Bốn cái bẫy của ffmpeg đã cắn một lần.** Cả bốn đều **không báo lỗi**, chỉ cho ra
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
4. **`drawtext` với `textfile` đo mỗi dòng bằng BYTE rồi vẽ ra bấy nhiêu KÝ TỰ.**
   Mỗi ký tự non-ASCII ăn mất một ký tự ở **cuối chính dòng đó**. `"… · 0:38"` ra
   `"… · 0:"`; tiêu đề tiếng Việt mất một chữ mỗi dòng. Cách chữa nằm ở
   `writeTextFile()` trong `build_video.js`: đệm mỗi dòng thêm một dấu cách cho mỗi
   byte UTF-8 dôi ra — phần bị cắt chính là mấy dấu cách đó nên không vẽ thừa gì.
   **Đừng đổi sang `text=`**: chủ đề là input người dùng, phải escape qua hai tầng
   parser của ffmpeg.

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

**Index của câu sau node TTS.** HTTP Request node thay `json` bằng binary response,
nên `$json.idx` biến mất. `Write Sentence Audio` lấy lại qua paired item:
`$('Parse & Normalize').item.json.idx`. Đừng đổi tên node `Parse & Normalize` mà
quên sửa biểu thức này.
