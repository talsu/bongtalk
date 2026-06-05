import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticator } from 'otplib';
import { compare as bcryptCompare } from 'bcryptjs';
import { TwoFactorService } from '../../../src/auth/services/two-factor.service';
import { CryptoService } from '../../../src/auth/services/crypto.service';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';
import { TOTP_BACKUP_CODE_COUNT } from '@qufox/shared-types';

const KEY_32 = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');

type UserRow = { totpEnabled: boolean; totpSecretEnc: string | null };

function makeRedis() {
  const store = new Map<string, string>();
  const delCalls: string[] = [];
  return {
    store,
    delCalls,
    set: vi.fn(async (key: string, val: string) => {
      store.set(key, val);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    del: vi.fn(async (key: string) => {
      delCalls.push(key);
      return store.delete(key) ? 1 : 0;
    }),
  };
}

function makePrisma(user: UserRow) {
  const backupCodes: Array<{ id: string; userId: string; codeHash: string }> = [];
  const tx = {
    user: {
      update: vi.fn(async ({ data }: { data: Partial<UserRow> }) => {
        Object.assign(user, data);
        return user;
      }),
    },
    backupCode: {
      deleteMany: vi.fn(async () => {
        const n = backupCodes.length;
        backupCodes.length = 0;
        return { count: n };
      }),
      createMany: vi.fn(async ({ data }: { data: Array<{ id: string; userId: string; codeHash: string }> }) => {
        backupCodes.push(...data);
        return { count: data.length };
      }),
    },
  };
  return {
    backupCodes,
    user: {
      findUnique: vi.fn(async () => ({ ...user })),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    __tx: tx,
  };
}

function makeService(user: UserRow) {
  process.env.APP_ENCRYPTION_KEY = KEY_32;
  const redis = makeRedis();
  const prisma = makePrisma(user);
  const crypto = new CryptoService();
  const svc = new TwoFactorService(prisma as never, redis as never, crypto);
  return { svc, redis, prisma, crypto };
}

describe('S77b TwoFactorService (FR-PS-15·20)', () => {
  const original = process.env.APP_ENCRYPTION_KEY;
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    process.env.APP_ENCRYPTION_KEY = KEY_32;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = original;
    vi.useRealTimers();
  });

  it('setup 은 Redis 단일키(totp:setup:{userId})에 시크릿을 SET 하고 재호출 시 DEL 후 재발급', async () => {
    const { svc, redis } = makeService({ totpEnabled: false, totpSecretEnc: null });
    const first = await svc.setup('u1', 'a@b.com');
    expect(first.secret).toBeTruthy();
    expect(first.otpauthUri).toContain('otpauth://totp/');
    expect(first.qrDataUri).toMatch(/^data:image\/png;base64,/);
    expect(redis.store.get('totp:setup:u1')).toBe(first.secret);

    const second = await svc.setup('u1', 'a@b.com');
    // 재호출 시 키를 DEL 한 뒤 새 시크릿으로 재발급(단일키).
    expect(redis.delCalls).toContain('totp:setup:u1');
    expect(redis.store.get('totp:setup:u1')).toBe(second.secret);
  });

  it('이미 활성 상태에서 setup 은 409 TOTP_ALREADY_ENABLED', async () => {
    const { svc } = makeService({ totpEnabled: true, totpSecretEnc: 'enc' });
    await expect(svc.setup('u1', 'a@b.com')).rejects.toMatchObject({
      code: ErrorCode.TOTP_ALREADY_ENABLED,
    });
  });

  // bcrypt cost=12 × 10 codes 는 NAS(kernel 4.4) 병렬 실행 시 10s 기본 한도를 넘을 수 있어
  // per-test 타임아웃을 넉넉히 둔다(현실적 cost 유지 — cost 를 낮추지 않는다).
  it('verify 성공 시 totpEnabled=true + 백업코드 10개(bcrypt) 생성 + 평문 1회 반환', async () => {
    const user: UserRow = { totpEnabled: false, totpSecretEnc: null };
    const { svc, redis, prisma } = makeService(user);
    const setup = await svc.setup('u1', 'a@b.com');
    const code = authenticator.generate(setup.secret);

    const res = await svc.verify('u1', code);
    expect(res.totpEnabled).toBe(true);
    expect(res.backupCodes).toHaveLength(TOTP_BACKUP_CODE_COUNT);
    // 평문 백업코드는 모두 서로 다르다.
    expect(new Set(res.backupCodes).size).toBe(TOTP_BACKUP_CODE_COUNT);
    // DB 에는 bcrypt 해시 10행이 들어간다(평문 미저장).
    expect(prisma.backupCodes).toHaveLength(TOTP_BACKUP_CODE_COUNT);
    for (const row of prisma.backupCodes) {
      expect(row.codeHash).toMatch(/^\$2[aby]\$/); // bcrypt 해시 포맷.
      expect(res.backupCodes).not.toContain(row.codeHash); // 해시 ≠ 평문.
    }
    // 첫 평문 코드가 첫 해시와 매칭(bcrypt compare).
    expect(await bcryptCompare(res.backupCodes[0], prisma.backupCodes[0].codeHash)).toBe(true);
    // 사용자 상태 갱신 + Redis setup 키 정리.
    expect(user.totpEnabled).toBe(true);
    expect(user.totpSecretEnc).toBeTruthy();
    expect(redis.store.has('totp:setup:u1')).toBe(false);
  }, 30_000);

  it('verify 코드 불일치는 403 TOTP_INVALID', async () => {
    const { svc } = makeService({ totpEnabled: false, totpSecretEnc: null });
    await svc.setup('u1', 'a@b.com');
    await expect(svc.verify('u1', '000000')).rejects.toMatchObject({ code: ErrorCode.TOTP_INVALID });
  });

  it('setup 미진행(Redis 시크릿 없음) verify 는 403 TOTP_INVALID', async () => {
    const { svc } = makeService({ totpEnabled: false, totpSecretEnc: null });
    await expect(svc.verify('u1', '123456')).rejects.toMatchObject({ code: ErrorCode.TOTP_INVALID });
  });

  it('disable 은 유효한 코드로 totpSecretEnc/totpEnabled 해제 + 백업코드 삭제', async () => {
    const user: UserRow = { totpEnabled: false, totpSecretEnc: null };
    const { svc, crypto } = makeService(user);
    const setup = await svc.setup('u1', 'a@b.com');
    await svc.verify('u1', authenticator.generate(setup.secret));
    expect(user.totpEnabled).toBe(true);

    // disable 은 저장된 암호화 시크릿을 복호화해 코드를 검증한다.
    const live = authenticator.generate(crypto.decrypt(user.totpSecretEnc as string));
    await svc.disable('u1', live);
    expect(user.totpEnabled).toBe(false);
    expect(user.totpSecretEnc).toBeNull();
  }, 30_000);

  it('disable 미활성 상태는 409 TOTP_NOT_ENABLED', async () => {
    const { svc } = makeService({ totpEnabled: false, totpSecretEnc: null });
    await expect(svc.disable('u1', '123456')).rejects.toMatchObject({
      code: ErrorCode.TOTP_NOT_ENABLED,
    });
  });

  it('키 미설정이면 setup/verify/disable 모두 503 ENCRYPTION_UNAVAILABLE(graceful)', async () => {
    const { svc } = makeService({ totpEnabled: false, totpSecretEnc: null });
    delete process.env.APP_ENCRYPTION_KEY;
    await expect(svc.setup('u1', 'a@b.com')).rejects.toMatchObject({
      code: ErrorCode.ENCRYPTION_UNAVAILABLE,
    });
    await expect(svc.verify('u1', '123456')).rejects.toMatchObject({
      code: ErrorCode.ENCRYPTION_UNAVAILABLE,
    });
    await expect(svc.disable('u1', '123456')).rejects.toMatchObject({
      code: ErrorCode.ENCRYPTION_UNAVAILABLE,
    });
  });
});
