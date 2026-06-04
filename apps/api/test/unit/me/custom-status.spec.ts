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

// ── S74 (FR-PS-05 · Fork1 Option C): dndDuringStatus 만료 시 DND ───────────────
import type { PrismaService } from '../../../src/prisma/prisma.module';
import type { PresenceService } from '../../../src/realtime/presence/presence.service';

function makeStatusDeps(opts: {
  row: {
    customStatus: string | null;
    customStatusEmoji: string | null;
    customStatusExpiresAt: Date | null;
    dndDuringStatus: boolean;
  } | null;
  memberships?: { workspaceId: string }[];
}): {
  service: CustomStatusService;
  userUpdate: ReturnType<typeof vi.fn>;
  setDndForUser: ReturnType<typeof vi.fn>;
} {
  const userUpdate = vi.fn(async () => opts.row);
  const setDndForUser = vi.fn(async () => (opts.memberships ?? []).map((m) => m.workspaceId));
  const prisma = {
    user: {
      findUnique: vi.fn(async () => opts.row),
      update: userUpdate,
    },
    workspaceMember: {
      findMany: vi.fn(async () => opts.memberships ?? []),
    },
  } as unknown as PrismaService;
  const presence = { setDndForUser } as unknown as PresenceService;
  return { service: new CustomStatusService(prisma, presence), userUpdate, setDndForUser };
}

describe('CustomStatusService.getEffective — dndDuringStatus 만료 시 DND (FR-PS-05)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  it('만료 + dndDuringStatus=true → clear + setDndForUser(true)', async () => {
    const { service, setDndForUser } = makeStatusDeps({
      row: {
        customStatus: 'busy',
        customStatusEmoji: null,
        customStatusExpiresAt: new Date('2024-12-31T23:59:00Z'), // 과거(만료)
        dndDuringStatus: true,
      },
      memberships: [{ workspaceId: 'w1' }, { workspaceId: 'w2' }],
    });
    const view = await service.getEffective('u1');
    // 만료분은 빈 상태로 보이고 옵션값은 노출한다.
    expect(view.text).toBeNull();
    expect(view.dndDuringStatus).toBe(true);
    // 비동기 lazy clear+DND 가 마이크로태스크에서 실행되도록 한 틱 양보.
    await Promise.resolve();
    await Promise.resolve();
    expect(setDndForUser).toHaveBeenCalledWith('u1', ['w1', 'w2'], true);
  });

  it('만료 + dndDuringStatus=false → clear 만, DND 미호출', async () => {
    const { service, setDndForUser } = makeStatusDeps({
      row: {
        customStatus: 'busy',
        customStatusEmoji: null,
        customStatusExpiresAt: new Date('2024-12-31T23:59:00Z'),
        dndDuringStatus: false,
      },
      memberships: [{ workspaceId: 'w1' }],
    });
    const view = await service.getEffective('u1');
    expect(view.text).toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    expect(setDndForUser).not.toHaveBeenCalled();
  });

  it('미만료(미래 expiresAt) → DND 미호출, 상태 그대로', async () => {
    const { service, setDndForUser } = makeStatusDeps({
      row: {
        customStatus: 'busy',
        customStatusEmoji: '🔧',
        customStatusExpiresAt: new Date('2025-01-02T00:00:00Z'), // 미래
        dndDuringStatus: true,
      },
    });
    const view = await service.getEffective('u1');
    expect(view.text).toBe('busy');
    expect(view.emoji).toBe('🔧');
    expect(view.dndDuringStatus).toBe(true);
    await Promise.resolve();
    expect(setDndForUser).not.toHaveBeenCalled();
  });
});

describe('CustomStatusService.set — dndDuringStatus 옵션 저장 (FR-PS-05)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  it('dndDuringStatus 가 입력에 있으면 컬럼을 갱신', async () => {
    const { service, userUpdate } = makeStatusDeps({
      row: {
        customStatus: null,
        customStatusEmoji: null,
        customStatusExpiresAt: null,
        dndDuringStatus: false,
      },
    });
    const view = await service.set('u1', { text: 'lunch', dndDuringStatus: true });
    expect(view.dndDuringStatus).toBe(true);
    const updateArg = userUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(updateArg.data.dndDuringStatus).toBe(true);
  });

  it('dndDuringStatus 미지정이면 컬럼을 건드리지 않음', async () => {
    const { service, userUpdate } = makeStatusDeps({
      row: {
        customStatus: null,
        customStatusEmoji: null,
        customStatusExpiresAt: null,
        dndDuringStatus: false,
      },
    });
    await service.set('u1', { text: 'lunch' });
    const updateArg = userUpdate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect('dndDuringStatus' in updateArg.data).toBe(false);
  });
});
