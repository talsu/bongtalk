import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ENFORCEMENT_BITS,
  bitTriState,
  applyTriState,
  nextTriState,
  parseMaskToNumber,
} from './channelPermissionCatalog';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const READ = ENFORCEMENT_BITS.READ;
const WRITE = ENFORCEMENT_BITS.WRITE_MESSAGE;

describe('S62 channel override tri-state', () => {
  it('bitTriState: allow/deny/inherit 판정(deny 우선)', () => {
    expect(bitTriState(READ, 0, READ)).toBe('allow');
    expect(bitTriState(0, READ, READ)).toBe('deny');
    expect(bitTriState(0, 0, READ)).toBe('inherit');
    // 같은 비트가 allow·deny 둘 다면 deny 우선.
    expect(bitTriState(READ, READ, READ)).toBe('deny');
  });

  it('nextTriState: inherit → allow → deny → inherit 순환', () => {
    expect(nextTriState('inherit')).toBe('allow');
    expect(nextTriState('allow')).toBe('deny');
    expect(nextTriState('deny')).toBe('inherit');
  });

  it('applyTriState: allow 설정 시 deny 에서 제거하고 allow 만 켠다', () => {
    const r = applyTriState(0, READ, READ, 'allow');
    expect(r.allowMask & READ).toBe(READ);
    expect(r.denyMask & READ).toBe(0);
  });

  it('applyTriState: deny 설정 시 allow 에서 제거하고 deny 만 켠다', () => {
    const r = applyTriState(READ, 0, READ, 'deny');
    expect(r.allowMask & READ).toBe(0);
    expect(r.denyMask & READ).toBe(READ);
  });

  it('applyTriState: inherit 설정 시 양쪽 모두 제거', () => {
    const r = applyTriState(READ, 0, READ, 'inherit');
    expect(r.allowMask & READ).toBe(0);
    expect(r.denyMask & READ).toBe(0);
  });

  it('applyTriState: 다른 비트는 보존한다', () => {
    const r = applyTriState(WRITE, 0, READ, 'allow');
    expect(r.allowMask & WRITE).toBe(WRITE);
    expect(r.allowMask & READ).toBe(READ);
  });

  it('parseMaskToNumber: string(BigInt) → 집행 number(0x1FF 마스킹)', () => {
    expect(parseMaskToNumber('1')).toBe(1);
    expect(parseMaskToNumber('256')).toBe(256); // BYPASS_SLOWMODE 0x100
    // 0x1FF 밖 비트는 잘려나간다(집행 도메인 안전).
    expect(parseMaskToNumber(String(0x8000))).toBe(0);
  });
});
