import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  PERMISSIONS,
  CHANNEL_OVERWRITE_FLAGS,
  ALL_PERMISSIONS,
  has,
  hasRaw,
  combine,
  resolvePermissions,
  serializePermissions,
  deserializePermissions,
} from './permissions';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('permissions bit table (ADR-4)', () => {
  it('matches the canonical hex values', () => {
    expect(PERMISSIONS.VIEW_CHANNEL).toBe(0x0001n);
    expect(PERMISSIONS.SEND_MESSAGES).toBe(0x0002n);
    expect(PERMISSIONS.READ_HISTORY).toBe(0x0004n);
    expect(PERMISSIONS.MANAGE_MESSAGES).toBe(0x0008n);
    expect(PERMISSIONS.ATTACH_FILES).toBe(0x0010n);
    expect(PERMISSIONS.ADD_REACTIONS).toBe(0x0020n);
    expect(PERMISSIONS.USE_SLASH_COMMANDS).toBe(0x0040n);
    expect(PERMISSIONS.MENTION_EVERYONE).toBe(0x0080n);
    expect(PERMISSIONS.MANAGE_CHANNEL).toBe(0x0100n);
    expect(PERMISSIONS.MANAGE_WEBHOOKS).toBe(0x0200n);
    expect(PERMISSIONS.CREATE_INVITES).toBe(0x0400n);
    expect(PERMISSIONS.USE_EXTERNAL_EMOJI).toBe(0x0800n);
    expect(PERMISSIONS.BYPASS_SLOWMODE).toBe(0x1000n);
    expect(PERMISSIONS.ADMINISTRATOR).toBe(0x8000000000000000n);
  });

  it('uses 1n << 63n for ADMINISTRATOR', () => {
    expect(PERMISSIONS.ADMINISTRATOR).toBe(1n << 63n);
  });

  it('defines exactly 14 flags (13 overwrite + ADMINISTRATOR)', () => {
    expect(Object.keys(PERMISSIONS)).toHaveLength(14);
    expect(CHANNEL_OVERWRITE_FLAGS).toHaveLength(13);
    expect(CHANNEL_OVERWRITE_FLAGS).not.toContain('ADMINISTRATOR');
  });

  it('all 13 overwrite bits are distinct and below bit 63', () => {
    const bits = CHANNEL_OVERWRITE_FLAGS.map((f) => PERMISSIONS[f]);
    expect(new Set(bits).size).toBe(13);
    for (const b of bits) {
      expect(b < PERMISSIONS.ADMINISTRATOR).toBe(true);
    }
  });

  it('ALL_PERMISSIONS is the OR of every flag', () => {
    let expected = 0n;
    for (const v of Object.values(PERMISSIONS)) expected |= v;
    expect(ALL_PERMISSIONS).toBe(expected);
    expect(has(ALL_PERMISSIONS, PERMISSIONS.ADMINISTRATOR)).toBe(true);
  });
});

describe('has / hasRaw / combine', () => {
  it('has() detects a present flag', () => {
    const mask = combine(PERMISSIONS.VIEW_CHANNEL, PERMISSIONS.SEND_MESSAGES);
    expect(has(mask, PERMISSIONS.VIEW_CHANNEL)).toBe(true);
    expect(has(mask, PERMISSIONS.SEND_MESSAGES)).toBe(true);
    expect(has(mask, PERMISSIONS.MANAGE_MESSAGES)).toBe(false);
  });

  it('ADMINISTRATOR grants every other flag via has()', () => {
    const mask = PERMISSIONS.ADMINISTRATOR;
    expect(has(mask, PERMISSIONS.MANAGE_MESSAGES)).toBe(true);
    expect(has(mask, PERMISSIONS.BYPASS_SLOWMODE)).toBe(true);
    // and ADMINISTRATOR itself
    expect(has(mask, PERMISSIONS.ADMINISTRATOR)).toBe(true);
  });

  it('hasRaw() ignores the ADMINISTRATOR shortcut', () => {
    const mask = PERMISSIONS.ADMINISTRATOR;
    expect(hasRaw(mask, PERMISSIONS.MANAGE_MESSAGES)).toBe(false);
    expect(hasRaw(mask, PERMISSIONS.ADMINISTRATOR)).toBe(true);
  });

  it('combine() folds flags with OR; empty is 0n', () => {
    expect(combine()).toBe(0n);
    expect(combine(PERMISSIONS.VIEW_CHANNEL)).toBe(PERMISSIONS.VIEW_CHANNEL);
    expect(combine(PERMISSIONS.VIEW_CHANNEL, PERMISSIONS.VIEW_CHANNEL)).toBe(
      PERMISSIONS.VIEW_CHANNEL,
    );
  });
});

describe('resolvePermissions (ADR-4 order)', () => {
  it('applies role allow then deny then user allow then deny', () => {
    const out = resolvePermissions({
      base: PERMISSIONS.VIEW_CHANNEL,
      roleAllow: PERMISSIONS.SEND_MESSAGES,
      roleDeny: PERMISSIONS.VIEW_CHANNEL,
      userAllow: PERMISSIONS.VIEW_CHANNEL,
      userDeny: PERMISSIONS.SEND_MESSAGES,
    });
    // role denies VIEW, user re-allows VIEW; role allows SEND, user denies SEND
    expect(hasRaw(out, PERMISSIONS.VIEW_CHANNEL)).toBe(true);
    expect(hasRaw(out, PERMISSIONS.SEND_MESSAGES)).toBe(false);
  });

  it('personal DENY wins over personal ALLOW for the same flag', () => {
    const out = resolvePermissions({
      base: 0n,
      userAllow: PERMISSIONS.MANAGE_MESSAGES,
      userDeny: PERMISSIONS.MANAGE_MESSAGES,
    });
    expect(hasRaw(out, PERMISSIONS.MANAGE_MESSAGES)).toBe(false);
  });
});

describe('BigInt <-> string serialization (ADR-11)', () => {
  it('round-trips through string', () => {
    const mask = combine(PERMISSIONS.ADMINISTRATOR, PERMISSIONS.VIEW_CHANNEL);
    const s = serializePermissions(mask);
    expect(typeof s).toBe('string');
    expect(s).toBe('9223372036854775809');
    expect(deserializePermissions(s)).toBe(mask);
  });

  it('serializes zero', () => {
    expect(serializePermissions(0n)).toBe('0');
    expect(deserializePermissions('0')).toBe(0n);
  });

  it('rejects non-numeric strings', () => {
    expect(() => deserializePermissions('0x10')).toThrow(RangeError);
    expect(() => deserializePermissions('abc')).toThrow(RangeError);
    expect(() => deserializePermissions('')).toThrow(RangeError);
  });

  // 리뷰 [M4]/[H-02]: 음수 마스크는 2의 보수로 ADMINISTRATOR 비트 포함
  // → 권한 상승. 거부되어야 한다.
  it('rejects negative bitmasks (no privilege escalation via two-complement)', () => {
    expect(() => deserializePermissions('-1')).toThrow(RangeError);
    expect(() => deserializePermissions('-9223372036854775808')).toThrow(RangeError);
  });

  it('rejects leading-zero and out-of-range bitmasks', () => {
    expect(() => deserializePermissions('01')).toThrow(RangeError);
    // ALL_PERMISSIONS + 1 비트(정의되지 않은 비트 13) → 범위 밖
    const undefinedBit = (1n << 13n).toString();
    expect(() => deserializePermissions(undefinedBit)).toThrow(RangeError);
  });

  it('accepts the full valid mask (ALL_PERMISSIONS round-trip)', () => {
    expect(deserializePermissions(serializePermissions(ALL_PERMISSIONS))).toBe(ALL_PERMISSIONS);
  });
});
