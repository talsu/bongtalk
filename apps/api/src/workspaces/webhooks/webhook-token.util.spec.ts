import { describe, it, expect } from 'vitest';
import { generateRawToken, hashToken, safeTokenEquals } from './webhook-token.util';

describe('S84a webhook token crypto (FR-RC11)', () => {
  it('generateRawToken returns a prefixed, unique, high-entropy token', () => {
    const a = generateRawToken();
    const b = generateRawToken();
    expect(a.startsWith('whk_')).toBe(true);
    expect(a).not.toEqual(b);
    expect(a.length).toBeGreaterThan(40);
  });

  it('hashToken returns a deterministic lowercase 64-hex (sha256)', () => {
    const raw = generateRawToken();
    const h = hashToken(raw);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(raw)).toEqual(h); // deterministic
    expect(hashToken(raw + 'x')).not.toEqual(h); // sensitive
  });

  it('safeTokenEquals matches the raw token against its stored hash', () => {
    const raw = generateRawToken();
    const stored = hashToken(raw);
    expect(safeTokenEquals(raw, stored)).toBe(true);
  });

  it('safeTokenEquals rejects a wrong token', () => {
    const stored = hashToken(generateRawToken());
    expect(safeTokenEquals(generateRawToken(), stored)).toBe(false);
  });

  it('safeTokenEquals rejects a malformed stored hash (not 64-hex)', () => {
    const raw = generateRawToken();
    expect(safeTokenEquals(raw, 'deadbeef')).toBe(false);
    expect(safeTokenEquals(raw, '')).toBe(false);
    expect(safeTokenEquals(raw, hashToken(raw).toUpperCase())).toBe(false); // not lowercase hex
  });

  it('never embeds the plaintext token in its hash', () => {
    const raw = generateRawToken();
    expect(hashToken(raw)).not.toContain(raw);
  });
});
