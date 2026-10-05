#!/usr/bin/env node
/**
 * Scene reviewer: Claude looks at each generated still and says whether it fits
 * the line of dialogue it illustrates.
 *
 *   node host/imagereview/server.js        # :7861, loopback only
 *
 *   GET  /health
 *   POST /review   { image, mediaType, kind, topic, line, dialogue, character, prompt }
 *
 * Why it exists: SD 1.5 at guidance 1.0 binds the prompt loosely. A line about
 * syrup in a coffee order came back as a boy standing in a school corridor, and
 * nothing in the pipeline could tell - every pixel decoded fine. Claude can tell,
 * so fetch_scenes.js sends each still here and regenerates the ones that fail.
 *
 * It runs on the HOST, like the generator, because it drives the `claude` CLI
 * you are already logged in to. The n8n image has no `claude` and cannot get one
 * (see CLAUDE.md, container constraints). The call is `claude -p` with:
 *   - the image sent inline over stream-json, so no tool is needed to read it
 *   - `--tools ""`: the reviewer can look, and do nothing else
 *   - `--json-schema`, so the verdict is parsed, never scraped out of prose
 *   - its own system prompt, and a cwd outside the project, so neither Claude
 *     Code's default prompt nor this repo's 40 KB CLAUDE.md is paid for per image
 *
 * Bound to 127.0.0.1, not 0.0.0.0: Docker Desktop still routes
 * host.docker.internal to it (verified from inside shadowing-n8n), and nothing on
 * the LAN can spend your Claude usage.
 *
 * A reviewer that is down, slow or rate-limited answers 503 and the caller keeps
 * the unreviewed image. Review improves pictures; it must never cost a video.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.IMAGEREVIEW_PORT ?? 7861);
// Sonnet over Haiku: the call is ~5 s either way, and the whole point is judging
// whether a laptop is really a laptop.
const MODEL = process.env.IMAGEREVIEW_MODEL ?? 'sonnet';
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';
const CALL_TIMEOUT_MS = 90000;
// Reviews overlap with the GPU drawing the next scene, so two is enough to keep
// up, and more would only spend usage faster.
const MAX_CONCURRENT = 2;
const MAX_BODY = 12 * 1024 * 1024;

// Read per request, like server.py does, so editing traits needs no restart.
const TRAITS_FILE = path.join(__dirname, '..', '..', 'assets', 'characters', 'traits.json');
function traitsFor(name) {
  if (!name) return null;
  try {
    return JSON.parse(fs.readFileSync(TRAITS_FILE, 'utf8'))[name] ?? null;
  } catch {
    return null;
  }
}

const SCHEMA = {
  type: 'object',
  properties: {
    required: { type: 'array', items: { type: 'string' } },
    present: { type: 'array', items: { type: 'string' } },
    missing: { type: 'array', items: { type: 'string' } },
    characterOk: { type: 'boolean' },
    issues: { type: 'array', items: { type: 'string' } },
    score: { type: 'integer', minimum: 0, maximum: 10 },
    pass: { type: 'boolean' },
    revisedPrompt: { type: 'string' },
  },
  required: ['required', 'present', 'missing', 'characterOk', 'issues', 'score', 'pass', 'revisedPrompt'],
};

const SYSTEM_PROMPT = `You are the picture editor for a short English-shadowing video.
Each scene is an anime-style still drawn by Stable Diffusion 1.5 for ONE line of
dialogue. Decide whether the still fits that line.

1. required: what the line makes the viewer expect to SEE. Only two kinds:
   - the SETTING the topic or line puts it in (an office, a cafe, a street, a
     kitchen). "company", "work", "the team" mean an office.
   - objects the line NAMES - "laptop", "menu", "passport", "syrup". At most two.
     Never objects you infer: a price does not require a cash register, "cards
     are fine" does not require a payment terminal.
   A part of something stands for the whole: "the battery" or "the screen" of a
   laptop requires the laptop, not a visible battery or screen.
   Name each item plainly, without the line's adjectives: "coffee cup", not
   "large iced latte in a clear cup". Skip what cannot be drawn: times, feelings,
   abstract nouns (deadline, problem, tomorrow).
2. present / missing: check each required item against the image. An object is
   present if a viewer would recognise it at a glance on a phone; a vague shape
   is missing. The setting is present when the place clearly reads as that kind
   of place - one convincing cue is enough (a counter with cups or an espresso
   machine makes a cafe; desks with monitors make an office).
3. characterOk: when a character description is given, that one character must be
   the clear subject. Fail ONLY a clearly wrong person: wrong gender, a different
   hair colour family (red or blonde for black), or a second prominent person.
   Anime "black" hair is often drawn dark navy - that is black. Outfit drift is
   expected from this generator: note it in issues, but it does not fail.
   When no character is given, true only if no person is prominent.
4. issues: anything else that would embarrass the channel - broken anatomy that
   draws the eye (extra limbs, melted hands or faces), an incoherent or abstract
   image, garbled text dominating the frame, a setting that contradicts the line.
5. score: 0-10, how well the still serves the line.
6. pass: true only if nothing required is missing, characterOk is true and no
   issue is serious enough to embarrass the channel. Outfit drift alone is not.
7. revisedPrompt: when it fails, a new Stable Diffusion prompt that fixes it. One
   plain sentence, 12 to 30 words. Put the missing things first as concrete nouns.
   One person doing one concrete thing in a named, detailed setting. Start with
   "A girl" for character A or "A boy" for character B; with no character, describe
   only the place. Never write negations ("no X", "without X") - the model reads
   them as a request for X. Never describe hair or clothes; they are added
   automatically. When it passes, repeat the original prompt unchanged.`;

/** The user turn: the still, then everything needed to judge it. */
function reviewMessage(req) {
  const lines = (req.dialogue ?? []).map((d) =>
    `${d.idx === req.line?.idx ? '>>' : '  '}${d.idx} ${d.speaker}: ${d.en}`);
  const traits = traitsFor(req.character);
  const text = req.kind === 'cover'
    ? [
      `Topic: ${req.topic}`,
      'This still is the BACKDROP of the title card: an establishing shot of the place',
      'the conversation happens in. The topic is printed across it, so it should show',
      'the setting clearly with no prominent person. No character is given, and',
      'the only required item is the setting itself.',
      `Prompt it was drawn from: "${req.prompt}"`,
    ]
    : [
      `Topic: ${req.topic}`,
      `Dialogue (this scene illustrates the line marked >>):`,
      ...lines,
      `Line being illustrated: "${req.line?.en}"`,
      req.line?.vi ? `Its meaning in Vietnamese: "${req.line.vi}"` : null,
      traits
        ? `Character to show: ${req.character} - ${traits}`
        : 'No character description is given.',
      `Prompt it was drawn from: "${req.prompt}"`,
    ];
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: req.mediaType ?? 'image/jpeg', data: req.image } },
        { type: 'text', text: text.filter(Boolean).join('\n') },
      ],
    },
  };
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
      resolve({ ...result.structured_output, model: MODEL, ms: result.duration_ms ?? null });
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
    if (!body.image) {
      send(res, 400, { error: 'image (base64) is required' });
      return;
    }
    const started = Date.now();
    try {
      const verdict = await withSlot(() => askClaude(body));
      console.log(`[imagereview] ${((Date.now() - started) / 1000).toFixed(1)}s `
        + `${verdict.pass ? 'PASS' : 'FAIL'} ${verdict.score}/10 ${body.kind ?? 'scene'} `
        + `${body.line?.idx ?? ''} missing=${JSON.stringify(verdict.missing)}`);
      send(res, 200, verdict);
    } catch (e) {
      console.log(`[imagereview] error: ${e.message}`);
      send(res, 503, { error: e.message });
    }
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[imagereview] listening on 127.0.0.1:${PORT}, model ${MODEL}`);
});
