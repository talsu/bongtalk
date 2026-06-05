import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AccountAnonymizationCron,
  anonymizedUserData,
} from '../../../src/me/account-anonymization.cron';
import { resolveSystemAnonUserId } from '../../../src/common/anon-user';

/**
 * S77c (D14 / FR-PS-19): 30일 익명화 크론 + 순수 변환 단위 검증.
 * 외부 모킹 라이브러리 금지 — vi.fn() 으로만 prisma/storage/redis 를 흉내낸다.
 */
beforeEach(() => {
  vi.setSystemTime('2025-01-01T00:00:00Z');
});

describe('anonymizedUserData — PII null화 + 자격증명 무효화 + UNIQUE 충돌 회피 placeholder', () => {
  const NOW = new Date('2025-02-01T00:00:00Z');

  it('전 PII 컬럼을 null 로 두고 email/username 만 결정론 placeholder 로 교체', () => {
    const userId = '11111111-1111-1111-1111-111111111111';
    const data = anonymizedUserData(userId, NOW);
    // UNIQUE 충돌 회피 placeholder(멱등 — userId 결정론).
    expect(data.email).toBe(`deleted-${userId}@deleted.qufox`);
    expect(data.username).toBe(`deleted-${userId}`);
    // PII 전수 null.
    expect(data.handle).toBeNull();
    expect(data.displayName).toBeNull();
    expect(data.fullName).toBeNull();
    expect(data.pronouns).toBeNull();
    expect(data.title).toBeNull();
    expect(data.bio).toBeNull();
    expect(data.timezone).toBeNull();
    expect(data.customStatus).toBeNull();
    expect(data.customStatusEmoji).toBeNull();
    expect(data.customStatusExpiresAt).toBeNull();
    expect(data.avatarKey).toBeNull();
    expect(data.bannerKey).toBeNull();
    expect(data.handleChangedAt).toBeNull();
    // isDeactivated/deactivatedAt 은 건드리지 않는다(멱등 cutoff 보존) — 키 부재.
    expect('isDeactivated' in data).toBe(false);
    expect('deactivatedAt' in data).toBe(false);
  });

  it('CF5 — 잔류 자격증명 무효화(passwordHash placeholder · totp 해제)', () => {
    const userId = '11111111-1111-1111-1111-111111111111';
    const data = anonymizedUserData(userId, NOW);
    // 어떤 비번과도 verify 실패하는 결정론 placeholder(argon2 형식 아님).
    expect(data.passwordHash).toBe(`deactivated-${userId}`);
    expect(data.totpSecretEnc).toBeNull();
    expect(data.totpEnabled).toBe(false);
  });

  it('CF3 — anonymizedAt 를 now 로 세팅(다음 배치 후보 제외 마커)', () => {
    const userId = '11111111-1111-1111-1111-111111111111';
    const data = anonymizedUserData(userId, NOW);
    expect(data.anonymizedAt).toBe(NOW);
  });

  it('멱등 — 같은 userId/now 는 항상 같은 값으로 수렴', () => {
    const u = '22222222-2222-2222-2222-222222222222';
    expect(anonymizedUserData(u, NOW)).toEqual(anonymizedUserData(u, NOW));
  });
});

describe('resolveSystemAnonUserId — seed system-anon 재사용', () => {
  it('env ANON_AUTHOR_UUID 우선', () => {
    const prev = process.env.ANON_AUTHOR_UUID;
    process.env.ANON_AUTHOR_UUID = '33333333-3333-3333-3333-333333333333';
    expect(resolveSystemAnonUserId()).toBe('33333333-3333-3333-3333-333333333333');
    if (prev === undefined) delete process.env.ANON_AUTHOR_UUID;
    else process.env.ANON_AUTHOR_UUID = prev;
  });

  it('env 미설정 시 결정론 uuid v5(SEED_NAMESPACE + user:system-anon)', () => {
    const prevAnon = process.env.ANON_AUTHOR_UUID;
    const prevNs = process.env.SEED_NAMESPACE;
    delete process.env.ANON_AUTHOR_UUID;
    delete process.env.SEED_NAMESPACE;
    const a = resolveSystemAnonUserId();
    const b = resolveSystemAnonUserId();
    expect(a).toBe(b); // 결정론.
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    if (prevAnon !== undefined) process.env.ANON_AUTHOR_UUID = prevAnon;
    if (prevNs !== undefined) process.env.SEED_NAMESPACE = prevNs;
  });
});

describe('AccountAnonymizationCron.anonymizeBatch — 대상 선별 + 멱등 + 미접근 가드', () => {
  const ANON = resolveSystemAnonUserId();

  type Tx = {
    message: { updateMany: ReturnType<typeof vi.fn> };
    attachment: { updateMany: ReturnType<typeof vi.fn> };
    attachmentUploadSession: { deleteMany: ReturnType<typeof vi.fn> };
    workspaceMemberProfile: { deleteMany: ReturnType<typeof vi.fn> };
    refreshToken: { deleteMany: ReturnType<typeof vi.fn> };
    backupCode: { deleteMany: ReturnType<typeof vi.fn> };
    user: { update: ReturnType<typeof vi.fn> };
  };

  function makeCron(opts: { targets: Array<{ id: string }>; anonExists: boolean }) {
    const findManyUser = vi.fn().mockResolvedValue(opts.targets);
    const findUniqueUser = vi.fn().mockResolvedValue(opts.anonExists ? { id: ANON } : null);
    const findManyAttachment = vi.fn().mockResolvedValue([]);
    const findManyWsProfile = vi.fn().mockResolvedValue([]);

    const tx: Tx = {
      message: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      attachment: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      attachmentUploadSession: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      workspaceMemberProfile: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      refreshToken: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      backupCode: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      user: { update: vi.fn().mockResolvedValue({}) },
    };
    const $transaction = vi.fn(async (fn: (t: Tx) => Promise<void>) => fn(tx));

    const prisma = {
      user: { findMany: findManyUser, findUnique: findUniqueUser },
      attachment: { findMany: findManyAttachment },
      workspaceMemberProfile: { findMany: findManyWsProfile },
      $transaction,
    } as unknown as ConstructorParameters<typeof AccountAnonymizationCron>[0];

    const storage = {
      deleteObject: vi.fn().mockResolvedValue(undefined),
    } as unknown as ConstructorParameters<typeof AccountAnonymizationCron>[1];

    const redis = {
      del: vi.fn().mockResolvedValue(1),
    } as unknown as ConstructorParameters<typeof AccountAnonymizationCron>[2];

    const cron = new AccountAnonymizationCron(prisma, storage, redis);
    return { cron, findManyUser, tx };
  }

  it('대상 필터는 isDeactivated=true AND deactivatedAt < now-30d AND anonymizedAt=null 만 스캔', async () => {
    const { cron, findManyUser } = makeCron({
      targets: [{ id: '44444444-4444-4444-4444-444444444444' }],
      anonExists: true,
    });
    const now = new Date('2025-02-01T00:00:00Z');
    await cron.anonymizeBatch(now);

    const call = findManyUser.mock.calls[0][0];
    expect(call.where.isDeactivated).toBe(true);
    // cutoff = now - 30d.
    const expectedCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    expect((call.where.deactivatedAt.lt as Date).getTime()).toBe(expectedCutoff.getTime());
    // CF3(reviewer M1·GDPR): 이미 익명화한 row 제외 — anonymizedAt: null 필터.
    expect(call.where.anonymizedAt).toBeNull();
    // LIMIT 500 배치.
    expect(call.take).toBe(500);
  });

  it('대상이 있으면 Message.authorId → SYSTEM_ANON 재배치 + PII/자격증명 정리 + 백업코드 삭제', async () => {
    const target = '55555555-5555-5555-5555-555555555555';
    const now = new Date('2025-02-01T00:00:00Z');
    const { cron, tx } = makeCron({ targets: [{ id: target }], anonExists: true });
    const res = await cron.anonymizeBatch(now);

    expect(res.processed).toBe(1);
    expect(tx.message.updateMany).toHaveBeenCalledWith({
      where: { authorId: target },
      data: { authorId: ANON },
    });
    expect(tx.attachment.updateMany).toHaveBeenCalledWith({
      where: { uploaderId: target },
      data: { uploaderId: ANON },
    });
    expect(tx.refreshToken.deleteMany).toHaveBeenCalledWith({ where: { userId: target } });
    // CF5: 잔류 자격증명 — 백업코드 행 전체 삭제.
    expect(tx.backupCode.deleteMany).toHaveBeenCalledWith({ where: { userId: target } });
    // PII null + 자격증명 무효화 + anonymizedAt=now.
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: target },
      data: anonymizedUserData(target, now),
    });
  });

  it('SYSTEM_ANON 행이 없으면(시드 누락) 익명화를 중단(processed=0)', async () => {
    const { cron, tx } = makeCron({
      targets: [{ id: '66666666-6666-6666-6666-666666666666' }],
      anonExists: false,
    });
    const res = await cron.anonymizeBatch(new Date('2025-02-01T00:00:00Z'));
    expect(res.processed).toBe(0);
    expect(tx.message.updateMany).not.toHaveBeenCalled();
  });

  it('대상이 없으면 no-op(processed=0)', async () => {
    const { cron } = makeCron({ targets: [], anonExists: true });
    const res = await cron.anonymizeBatch(new Date('2025-02-01T00:00:00Z'));
    expect(res.processed).toBe(0);
  });
});
