import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit';

/**
 * Task-011-C MED-1 — the 009 reviewer flagged the audit log as
 * unbounded append-only. This spec pins the new size-based rotation:
 * after maxBytes, audit.jsonl rotates to .1, .1 → .2, etc, capped at
 * maxFiles; the oldest file is dropped.
 */
describe('AuditLog size-based rotation', () => {
  let tmp: string;
  let logPath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'qufox-audit-'));
    logPath = join(tmp, 'audit.jsonl');
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  async function listRotated(): Promise<string[]> {
    const entries = await readdir(tmp);
    return entries.filter((e) => e.startsWith('audit.jsonl')).sort();
  }

  it('writes to audit.jsonl with no rotation below threshold', async () => {
    const audit = new AuditLog(logPath, { maxBytes: 1024, maxFiles: 3 });
    await audit.append('test.event', { i: 1 });
    await audit.append('test.event', { i: 2 });
    const files = await listRotated();
    expect(files).toEqual(['audit.jsonl']);
  });

  it('rotates once max size is exceeded', async () => {
    // Small threshold so a handful of writes trips rotation deterministically.
    const audit = new AuditLog(logPath, { maxBytes: 256, maxFiles: 3 });
    for (let i = 0; i < 20; i++) {
      await audit.append('test.event', {
        seq: i,
        // Pad each line so we cross 256 bytes quickly.
        padding: 'x'.repeat(50),
      });
    }
    const files = await listRotated();
    // audit.jsonl is the live file; .1, .2, .3 are rotated (up to maxFiles).
    expect(files).toContain('audit.jsonl');
    expect(files).toContain('audit.jsonl.1');
    // Live file stays below the threshold on the next rotation boundary.
    const liveSize = (await stat(logPath)).size;
    expect(liveSize).toBeLessThanOrEqual(256 + 200); // most recent append fits
  });

  it('caps rotated files at maxFiles and drops the oldest', async () => {
    const audit = new AuditLog(logPath, { maxBytes: 128, maxFiles: 2 });
    for (let i = 0; i < 50; i++) {
      await audit.append('flood', { seq: i, pad: 'x'.repeat(50) });
    }
    const files = await listRotated();
    // Allowed: audit.jsonl + audit.jsonl.1 + audit.jsonl.2 (but NOT .3+).
    const rotated = files.filter((f) => /\.jsonl\.\d+$/.test(f));
    expect(rotated.length).toBeLessThanOrEqual(2);
    expect(files).not.toContain('audit.jsonl.3');
  });

  it('preserves JSON line shape across rotations (most recent marker survives)', async () => {
    const audit = new AuditLog(logPath, { maxBytes: 200, maxFiles: 3 });
    for (let i = 0; i < 10; i++) {
      await audit.append('filler', { seq: i, pad: 'x'.repeat(40) });
    }
    await audit.append('last', { marker: 'omega' });
    // omega is in the live file (most recent append), and every line
    // across every rotated file still parses as JSON.
    const entries = await readdir(tmp);
    const contents = await Promise.all(
      entries.filter((e) => e.startsWith('audit.jsonl')).map((e) => readFile(join(tmp, e), 'utf8')),
    );
    expect(contents.join('')).toContain('"marker":"omega"');
    for (const block of contents) {
      for (const line of block.split('\n').filter(Boolean)) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }
  });
});
