/**
 * Reads .env from the project root.
 *
 * Deliberately not dotenv: .env is also consumed by docker compose, so it has to
 * stay a plain KEY=VALUE file with no expansion, and adding a dependency to the
 * host side for six lines is not worth it.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) {
    throw new Error(`.env not found at ${file} - see CLAUDE.md, "First-time setup"`);
  }
  return Object.fromEntries(
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.includes('=') && !line.trimStart().startsWith('#'))
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
      }),
  );
}

function requireEnv(env, ...keys) {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) throw new Error(`.env is missing: ${missing.join(', ')}`);
  return env;
}

module.exports = { ROOT, loadEnv, requireEnv };
