/**
 * One `claude -p` call with a structured answer, shared by every route of the
 * host server (/review, /topics).
 *
 * The flags are the point of this file, so they are in one place:
 *   - content goes in over stream-json, so images need no tool to be read
 *   - `--tools ""`: the model can answer and do nothing else
 *   - `--json-schema`: the answer is parsed, never scraped out of prose
 *   - its own system prompt and a cwd outside the repo, so neither Claude Code's
 *     default prompt nor this project's CLAUDE.md is paid for on every call
 * `--bare` is not usable: it demands ANTHROPIC_API_KEY and skips the OAuth login
 * this relies on.
 */
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Sonnet over Haiku: judging photos and writing varied, natural topics both
// benefit, and the call is a few seconds either way.
const MODEL = process.env.IMAGEREVIEW_MODEL ?? 'sonnet';
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? 'claude';

/** Resolves to `{output, ms}` - output is the schema-shaped answer - or rejects. */
function askClaude({ systemPrompt, schema, content, timeoutMs }) {
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
      '--system-prompt', systemPrompt,
      '--json-schema', JSON.stringify(schema),
    ], {
      cwd: os.tmpdir(),
      env: { ...process.env, PATH: `${path.join(os.homedir(), '.local', 'bin')}:${process.env.PATH}` },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('claude timed out')); }, timeoutMs);
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
      resolve({ output: result.structured_output, ms: result.duration_ms ?? null });
    });

    child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`);
  });
}

module.exports = { MODEL, askClaude };
