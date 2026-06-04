import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { hashIp, normalizeIp } from './ip-hash';

/**
 * S72 (D13 / FR-W22): IP soft-block 공유 헬퍼 단위 테스트.
 *
 * - normalizeIp: trim/소문자/IPv4-mapped IPv6 환원.
 * - hashIp: 정규화 IP 의 sha256(64hex), 동치 IP 동일 해시, 빈/unknown → null.
 *
 * 외부 의존 없음(순수 함수). 시간은 관례대로 고정한다.
 */
beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');

describe('normalizeIp', () => {
  it('trims and lowercases', () => {
    expect(normalizeIp('  2001:DB8::1  ')).toBe('2001:db8::1');
  });

  it('reduces IPv4-mapped IPv6 to the embedded IPv4', () => {
    expect(normalizeIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(normalizeIp('::FFFF:10.0.0.1')).toBe('10.0.0.1');
  });

  it('leaves a plain IPv4 untouched', () => {
    expect(normalizeIp('203.0.113.5')).toBe('203.0.113.5');
  });
});

describe('hashIp', () => {
  it('returns the sha256 hex (64 chars) of the normalized ip', () => {
    const h = hashIp('203.0.113.5');
    expect(h).toBe(sha256hex('203.0.113.5'));
    expect(h).toHaveLength(64);
  });

  it('hashes IPv4 and its IPv4-mapped IPv6 form to the same value', () => {
    expect(hashIp('1.2.3.4')).toBe(hashIp('::ffff:1.2.3.4'));
  });

  it('is case/whitespace insensitive', () => {
    expect(hashIp('  2001:DB8::1 ')).toBe(hashIp('2001:db8::1'));
  });

  it('returns null for empty, whitespace, unknown, or non-string input', () => {
    expect(hashIp('')).toBeNull();
    expect(hashIp('   ')).toBeNull();
    expect(hashIp('unknown')).toBeNull();
    expect(hashIp(undefined)).toBeNull();
    expect(hashIp(null)).toBeNull();
  });
});
