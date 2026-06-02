import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  NotifPreferencesService,
  KEYWORD_MAX_COUNT,
} from '../../../src/notifications/notif-preferences.service';
import { DomainError } from '../../../src/common/errors/domain-error';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const USER_A = '11111111-1111-4111-8111-111111111111';

function makeService(over?: {
  upsert?: ReturnType<typeof vi.fn>;
  findUnique?: ReturnType<typeof vi.fn>;
}) {
  const upsert = over?.upsert ?? vi.fn().mockResolvedValue({});
  // getGlobal 가 호출되는 후행 경로를 위해 findUnique 도 stub.
  const findUnique =
    over?.findUnique ??
    vi.fn().mockResolvedValue({
      notifTrigger: 'MENTIONS',
      keywords: [],
      dndUntil: null,
      dndSchedule: null,
    });
  const prisma = {
    userSettings: { upsert, findUnique },
  } as unknown as ConstructorParameters<typeof NotifPreferencesService>[0];
  return { svc: new NotifPreferencesService(prisma), upsert, findUnique };
}

describe('NotifPreferencesService.updateGlobal keywords (S48 FR-MN-10)', () => {
  it(`KEYWORD_MAX_COUNT 는 25`, () => {
    expect(KEYWORD_MAX_COUNT).toBe(25);
  });

  it('25개 키워드 → 통과(저장)', async () => {
    const { svc, upsert } = makeService();
    const keywords = Array.from({ length: 25 }, (_, i) => `kw${i}`);
    await svc.updateGlobal(USER_A, { keywords });
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('26개 키워드 → KEYWORD_LIMIT_EXCEEDED(400) throw, upsert 미호출', async () => {
    const { svc, upsert } = makeService();
    const keywords = Array.from({ length: 26 }, (_, i) => `kw${i}`);
    try {
      await svc.updateGlobal(USER_A, { keywords });
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      expect((e as DomainError).code).toBe(ErrorCode.KEYWORD_LIMIT_EXCEEDED);
    }
    expect(upsert).not.toHaveBeenCalled();
  });

  it('빈/공백 키워드 → VALIDATION_FAILED', async () => {
    const { svc } = makeService();
    await expect(svc.updateGlobal(USER_A, { keywords: ['ok', '   '] })).rejects.toBeInstanceOf(
      DomainError,
    );
  });

  it('길이 100 초과 키워드 → VALIDATION_FAILED', async () => {
    const { svc } = makeService();
    const tooLong = 'x'.repeat(101);
    await expect(svc.updateGlobal(USER_A, { keywords: [tooLong] })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_FAILED,
    });
  });

  it('키워드 trim 정규화 후 저장 + 중복 제거(대소문자 무관)', async () => {
    const { svc, upsert } = makeService();
    await svc.updateGlobal(USER_A, { keywords: ['  deploy ', 'Deploy', 'incident'] });
    const arg = upsert.mock.calls[0][0] as { create: { keywords: string[] } };
    expect(arg.create.keywords).toEqual(['deploy', 'incident']);
  });

  it('keywords 미지정 → upsert 는 keywords 를 건드리지 않음', async () => {
    const { svc, upsert } = makeService();
    await svc.updateGlobal(USER_A, { notifTrigger: 'ALL' });
    const arg = upsert.mock.calls[0][0] as { update: { keywords?: unknown } };
    expect(arg.update.keywords).toBeUndefined();
  });
});

describe('NotifPreferencesService.updateGlobal dndUntil snooze (S48 FR-MN-11)', () => {
  it('과거 dndUntil → VALIDATION_FAILED(최소 now+1분)', async () => {
    const { svc } = makeService();
    await expect(
      svc.updateGlobal(USER_A, { dndUntil: '2024-12-31T23:59:00.000Z' }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });

  it('미래 dndUntil → 저장', async () => {
    const { svc, upsert } = makeService();
    await svc.updateGlobal(USER_A, { dndUntil: '2025-01-01T01:00:00.000Z' });
    const arg = upsert.mock.calls[0][0] as { create: { dndUntil: Date } };
    expect(arg.create.dndUntil).toEqual(new Date('2025-01-01T01:00:00.000Z'));
  });

  it('dndUntil null → 해제(저장)', async () => {
    const { svc, upsert } = makeService();
    await svc.updateGlobal(USER_A, { dndUntil: null });
    const arg = upsert.mock.calls[0][0] as { create: { dndUntil: Date | null } };
    expect(arg.create.dndUntil).toBeNull();
  });
});
