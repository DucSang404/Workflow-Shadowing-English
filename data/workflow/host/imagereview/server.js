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
