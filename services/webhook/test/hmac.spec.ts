import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { extractBranch, verifySignature } from '../src/hmac';

const SECRET = 'test-secret';

function sign(body: string): string {
  return 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
}

describe('verifySignature', () => {
  it('accepts a valid signature', () => {
    const body = Buffer.from('{"ref":"refs/heads/main"}');
    expect(verifySignature(SECRET, body, sign(body.toString()))).toBe(true);
  });

  it('rejects a tampered body', () => {
    const sig = sign('{"ref":"refs/heads/main"}');
    const tampered = Buffer.from('{"ref":"refs/heads/evil"}');
    expect(verifySignature(SECRET, tampered, sig)).toBe(false);
  });

  it('rejects a signature with the wrong secret', () => {
    const body = Buffer.from('{}');
    const sig = 'sha256=' + createHmac('sha256', 'other-secret').update(body).digest('hex');
    expect(verifySignature(SECRET, body, sig)).toBe(false);
  });

  it('rejects when the prefix is missing', () => {
    const body = Buffer.from('{}');
    const raw = createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifySignature(SECRET, body, raw)).toBe(false);
  });

  it('rejects a truncated signature without throwing', () => {
    const body = Buffer.from('{}');
    expect(verifySignature(SECRET, body, 'sha256=deadbeef')).toBe(false);
  });

  it('rejects non-hex signatures without throwing', () => {
    const body = Buffer.from('{}');
    expect(verifySignature(SECRET, body, 'sha256=' + 'z'.repeat(64))).toBe(false);
  });
});

describe('extractBranch', () => {
  it('parses a branch ref', () => {
    expect(extractBranch('refs/heads/main')).toBe('main');
    expect(extractBranch('refs/heads/feat/x')).toBe('feat/x');
  });

  it('returns null for tag refs', () => {
    expect(extractBranch('refs/tags/v1.2.3')).toBe(null);
  });

  it('returns null for garbage', () => {
    expect(extractBranch('main')).toBe(null);
    expect(extractBranch('refs/heads/')).toBe(null);
  });
});
