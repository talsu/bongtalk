import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CustomStatusService, maskExpiredStatus } from '../../../src/me/custom-status.service';
import { DomainError } from '../../../src/common/errors/domain-error';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('CustomStatusService.isValidTimezone (S28 FR-P04)', () => {
  it('유효 IANA tz → true', () => {
    expect(CustomStatusService.isValidTimezone('Asia/Seoul')).toBe(true);
    expect(CustomStatusService.isValidTimezone('UTC')).toBe(true);
    expect(CustomStatusService.isValidTimezone('America/New_York')).toBe(true);
  });
  it('잘못된 tz → false', () => {
    expect(CustomStatusService.isValidTimezone('Not/AZone')).toBe(false);
    expect(CustomStatusService.isValidTimezone('garbage')).toBe(false);
  });
});

describe('CustomStatusService.computePreset (S28 FR-P04)', () => {
  // 2025-01-01T00:00:00Z = Wed
  const now = new Date('2025-01-01T00:00:00Z');

  it('dont_clear → null (무기한)', () => {
    expect(CustomStatusService.computePreset('dont_clear', now, 'Asia/Seoul')).toBeNull();
  });

  it('상대 프리셋은 tz 무관하게 now + Δ', () => {
    expect(CustomStatusService.computePreset('thirty_min', now, 'Asia/Seoul')?.toISOString()).toBe(
      '2025-01-01T00:30:00.000Z',
    );
    expect(CustomStatusService.computePreset('one_hour', now, null)?.toISOString()).toBe(
      '2025-01-01T01:00:00.000Z',
    );
    expect(CustomStatusService.computePreset('four_hours', now, 'UTC')?.toISOString()).toBe(
      '2025-01-01T04:00:00.000Z',
    );
  });

  it('today: UTC 기준 다음날 자정', () => {
    // now=2025-01-01T00:00Z, UTC 오늘 자정(다음날 00:00) = 2025-01-02T00:00Z
    expect(CustomStatusService.computePreset('today', now, 'UTC')?.toISOString()).toBe(
      '2025-01-02T00:00:00.000Z',
    );
  });

  it('today: Asia/Seoul(UTC+9) 기준 — 서울 로컬 자정을 UTC 로 환산', () => {
    // now=2025-01-01T00:00Z = 서울 2025-01-01 09:00. 서울 오늘 자정(다음날 00:00) =
    // 서울 2025-01-02 00:00 = UTC 2025-01-01 15:00.
    expect(CustomStatusService.computePreset('today', now, 'Asia/Seoul')?.toISOString()).toBe(
      '2025-01-01T15:00:00.000Z',
    );
  });

  it('this_week: UTC 기준 다음 일요일 자정 (Wed → +4일)', () => {
    // 2025-01-01 = Wed(dow=3). 다음 일요일 자정 = 2025-01-05T00:00Z.
    expect(CustomStatusService.computePreset('this_week', now, 'UTC')?.toISOString()).toBe(
      '2025-01-05T00:00:00.000Z',
    );
  });

  it('알 수 없는 preset → DomainError(VALIDATION_FAILED)', () => {
    try {
      CustomStatusService.computePreset('bogus' as never, now, 'UTC');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      expect((e as DomainError).code).toBe(ErrorCode.VALIDATION_FAILED);
    }
  });

  it('security HIGH-1: preset 에러 메시지에 사용자 입력을 반영하지 않는다', () => {
    const injected = '<script>alert(1)</script>';
    try {
      CustomStatusService.computePreset(injected as never, now, 'UTC');
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      // 입력 문자열이 메시지에 그대로 들어가면 안 된다(reflected-input 차단).
      expect((e as DomainError).message).not.toContain(injected);
      expect((e as DomainError).message).toContain('preset must be one of');
    }
  });
});

describe('CustomStatusService — control-char strip + maskExpiredStatus (S28 MED/HIGH-2)', () => {
  const now = new Date('2025-01-01T00:00:00Z');

  it('MED 방어: text/emoji 의 제어문자를 제거한다(일반 텍스트·이모지는 보존)', () => {
    // text 사이에 C0 제어문자(NUL/BEL/US)와 DEL 을 끼워 넣는다 → 모두 제거되어야 한다.
    const dirty = 'a\u0000b\u0007c\u001fd\u007f';
    const out = CustomStatusService.normalizeInput({ text: dirty, emoji: '\u0007🍜' }, now);
    expect(out.text).toBe('abcd');
    expect(out.emoji).toBe('🍜');
  });

  it('HIGH-2: maskExpiredStatus 는 expiresAt<=now 면 text/emoji 를 null 로 가린다', () => {
    const expired = maskExpiredStatus({
      text: '점심중',
      emoji: '🍜',
      expiresAt: new Date('2024-12-31T23:59:00Z'),
      now,
    });
    expect(expired).toEqual({ text: null, emoji: null });

    const live = maskExpiredStatus({
      text: '점심중',
      emoji: '🍜',
      expiresAt: new Date('2025-01-01T02:00:00Z'),
      now,
    });
    expect(live).toEqual({ text: '점심중', emoji: '🍜' });

    const noExpiry = maskExpiredStatus({ text: '상시', emoji: null, expiresAt: null, now });
    expect(noExpiry).toEqual({ text: '상시', emoji: null });
  });
});

describe('CustomStatusService.normalizeInput (S28 FR-P04)', () => {
  const now = new Date('2025-01-01T00:00:00Z');

  it('text/emoji 트림 + 빈 문자열 → null', () => {
    const out = CustomStatusService.normalizeInput({ text: '  hi  ', emoji: '  🎉 ' }, now);
    expect(out.text).toBe('hi');
    expect(out.emoji).toBe('🎉');
    expect(out.expiresAt).toBeNull();
  });

  it('text/emoji 빈/누락 → null', () => {
    const out = CustomStatusService.normalizeInput({ text: '', emoji: null }, now);
    expect(out.text).toBeNull();
    expect(out.emoji).toBeNull();
  });

  it('text 100자 초과 → throw', () => {
    expect(() => CustomStatusService.normalizeInput({ text: 'a'.repeat(101) }, now)).toThrow(
      /text too long/,
    );
  });

  it('explicit expiresAt(미래 ISO) 통과', () => {
    const out = CustomStatusService.normalizeInput(
      { text: 'x', expiresAt: '2025-01-01T02:00:00Z' },
      now,
    );
    expect(out.expiresAt?.toISOString()).toBe('2025-01-01T02:00:00.000Z');
  });

  it('과거 expiresAt → throw', () => {
    expect(() =>
      CustomStatusService.normalizeInput({ expiresAt: '2024-12-31T00:00:00Z' }, now),
    ).toThrow(/must be in the future/);
  });

  it('잘못된 ISO expiresAt → throw', () => {
    expect(() => CustomStatusService.normalizeInput({ expiresAt: 'not-a-date' }, now)).toThrow(
      /not a valid ISO/,
    );
  });

  it('preset 으로 expiresAt 계산 (timezone 기준)', () => {
    const out = CustomStatusService.normalizeInput(
      { text: 'lunch', preset: 'one_hour', timezone: 'Asia/Seoul' },
      now,
    );
    expect(out.expiresAt?.toISOString()).toBe('2025-01-01T01:00:00.000Z');
    expect(out.timezone).toBe('Asia/Seoul');
  });

  it('explicit expiresAt 가 preset 보다 우선', () => {
    const out = CustomStatusService.normalizeInput(
      { preset: 'four_hours', expiresAt: '2025-01-01T00:30:00Z' },
      now,
    );
    expect(out.expiresAt?.toISOString()).toBe('2025-01-01T00:30:00.000Z');
  });

  it('잘못된 timezone → throw', () => {
    expect(() => CustomStatusService.normalizeInput({ timezone: 'Bogus/Zone' }, now)).toThrow(
      /valid IANA/,
    );
  });
});
