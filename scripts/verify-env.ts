/**
 * Verify that every key in .env.example exists in .env (if present in CWD).
 * Exits non-zero on missing keys.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const examplePath = join(root, '.env.example');
const envPath = join(root, '.env');

function parseEnvKeys(text: string): string[] {
  const keys: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    keys.push(line.slice(0, eq).trim());
  }
  return keys;
}

if (!existsSync(examplePath)) {
  console.error('[verify-env] .env.example not found');
  process.exit(2);
}
const required = parseEnvKeys(readFileSync(examplePath, 'utf8'));

if (!existsSync(envPath)) {
  console.log('[verify-env] .env missing — bootstrap should copy it; skipping strict check');
  process.exit(0);
}
const actual = new Set(parseEnvKeys(readFileSync(envPath, 'utf8')));
const missing = required.filter((k) => !actual.has(k));
if (missing.length > 0) {
  console.error(`[verify-env] missing keys in .env: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`[verify-env] ok (${required.length} keys)`);
