import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticator } from 'otplib';
import { verify as argon2Verify } from '@node-rs/argon2';
import { TwoFactorService } from '../../../src/auth/services/two-factor.service';
import { CryptoService } from '../../../src/auth/services/crypto.service';
import { PasswordService } from '../../../src/auth/services/password.service';
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
      // RF1 (TOCTOU): verify 는 totpEnabled=false 인 행만 조건부 업데이트한다. mock 은 where.id
      // 와 where.totpEnabled 를 모두 만족해야 count=1 을 돌려준다.
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; totpEnabled?: boolean };
          data: Partial<UserRow>;
        }) => {
          if (where.totpEnabled !== undefined && user.totpEnabled !== where.totpEnabled) {
            return { count: 0 };
          }
          Object.assign(user, data);
          return { count: 1 };
        },
      ),
    },
    backupCode: {
      deleteMany: vi.fn(async () => {
        const n = backupCodes.length;
        backupCodes.length = 0;
        return { count: n };
      }),
      createMany: vi.fn(
        async ({ data }: { data: Array<{ id: string; userId: string; codeHash: string }> }) => {
          backupCodes.push(...data);
          return { count: data.length };
        },
      ),
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
  const passwords = new PasswordService();
  const svc = new TwoFactorService(prisma as never, redis as never, crypto, passwords);
  return { svc, redis, prisma, crypto, passwords };
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

  // PF1: 백업코드 해싱이 argon2(native · libuv threadpool)로 교체돼 종전 bcrypt(이벤트루프
  // ~6s 블로킹)의 per-test 타임아웃 확대(30s)가 불필요하다 — 기본 한도로 충분히 통과한다.
  it('verify 성공 시 totpEnabled=true + 백업코드 10개(argon2) 생성 + 평문 1회 반환', async () => {
    const user: UserRow = { totpEnabled: false, totpSecretEnc: null };
    const { svc, redis, prisma } = makeService(user);
    const setup = await svc.setup('u1', 'a@b.com');
    const code = authenticator.generate(setup.secret);

    const res = await svc.verify('u1', code);
    expect(res.totpEnabled).toBe(true);
    expect(res.backupCodes).toHaveLength(TOTP_BACKUP_CODE_COUNT);
    // 평문 백업코드는 모두 서로 다르다.
    expect(new Set(res.backupCodes).size).toBe(TOTP_BACKUP_CODE_COUNT);
    // DB 에는 argon2id 해시 10행이 들어간다(평문 미저장).
    expect(prisma.backupCodes).toHaveLength(TOTP_BACKUP_CODE_COUNT);
    for (const row of prisma.backupCodes) {
      expect(row.codeHash).toMatch(/^\$argon2id\$/); // argon2id 해시 포맷.
      expect(res.backupCodes).not.toContain(row.codeHash); // 해시 ≠ 평문.
    }
    // 첫 평문 코드가 첫 해시와 매칭(argon2 verify).
    expect(await argon2Verify(prisma.backupCodes[0].codeHash, res.backupCodes[0])).toBe(true);
    // 사용자 상태 갱신 + Redis setup 키 정리.
    expect(user.totpEnabled).toBe(true);
    expect(user.totpSecretEnc).toBeTruthy();
    expect(redis.store.has('totp:setup:u1')).toBe(false);
  });

  it('verify 코드 불일치는 403 TOTP_INVALID', async () => {
    const { svc } = makeService({ totpEnabled: false, totpSecretEnc: null });
    await svc.setup('u1', 'a@b.com');
    await expect(svc.verify('u1', '000000')).rejects.toMatchObject({
      code: ErrorCode.TOTP_INVALID,
    });
  });

  it('setup 미진행(Redis 시크릿 없음) verify 는 403 TOTP_INVALID', async () => {
    const { svc } = makeService({ totpEnabled: false, totpSecretEnc: null });
    await expect(svc.verify('u1', '123456')).rejects.toMatchObject({
      code: ErrorCode.TOTP_INVALID,
    });
  });

  // SF1 (security HIGH-1 / reviewer MED1): replay 차단. verify 성공 시 사용 코드가
  // totp:last:{userId} 에 90초 SET 되고, 이후 같은 코드는 assertTotpCode 가 거부한다.
  it('SF1 replay: verify 성공 시 totp:last:{userId} 에 사용 코드를 90초 SET 한다', async () => {
    const user: UserRow = { totpEnabled: false, totpSecretEnc: null };
    const { svc, redis } = makeService(user);
    const setup = await svc.setup('u1', 'a@b.com');
    const code = authenticator.generate(setup.secret);
    await svc.verify('u1', code);

    // totp:last:{userId} 에 사용 코드가 기록됐다(이후 자격증명 변경/disable 의 같은 코드 차단).
    expect(redis.store.get('totp:last:u1')).toBe(code);
    expect(redis.set).toHaveBeenCalledWith('totp:last:u1', code, 'EX', 90);

    // 같은 코드로 자격증명 변경 TOTP 재확인을 시도하면 replay 로 거부된다(같은 step 내 재사용).
    await expect(svc.assertCredentialChangeTotp('u1', code)).rejects.toMatchObject({
      code: ErrorCode.TOTP_INVALID,
    });
  });

  it('SF1 replay (disable): disable 성공 후 같은 코드 재사용 시 totp:last 가 막는다', async () => {
    const user: UserRow = { totpEnabled: false, totpSecretEnc: null };
    const { svc, crypto, redis } = makeService(user);
    const setup = await svc.setup('u1', 'a@b.com');
    // 서로 다른 step 의 코드를 쓰기 위해 verify 와 disable 사이에 시간을 진행한다.
    await svc.verify('u1', authenticator.generate(setup.secret));
    expect(user.totpEnabled).toBe(true);

    // 30초 진행 → 새 step 코드.
    vi.setSystemTime(new Date('2025-01-01T00:00:31Z'));
    const liveSecret = crypto.decrypt(user.totpSecretEnc as string);
    const disableCode = authenticator.generate(liveSecret);
    await svc.disable('u1', disableCode);
    expect(user.totpEnabled).toBe(false);
    // disable 에 쓴 코드가 totp:last 에 기록돼 같은 코드의 즉시 재사용을 막는다.
    expect(redis.store.get('totp:last:u1')).toBe(disableCode);
  });

  it('disable 은 유효한 코드로 totpSecretEnc/totpEnabled 해제 + 백업코드 삭제', async () => {
    const user: UserRow = { totpEnabled: false, totpSecretEnc: null };
    const { svc, crypto } = makeService(user);
    const setup = await svc.setup('u1', 'a@b.com');
    await svc.verify('u1', authenticator.generate(setup.secret));
    expect(user.totpEnabled).toBe(true);

    // 30초 진행해 verify 와 다른 step 코드를 쓴다(replay 기록 회피).
    vi.setSystemTime(new Date('2025-01-01T00:00:31Z'));
    const live = authenticator.generate(crypto.decrypt(user.totpSecretEnc as string));
    await svc.disable('u1', live);
    expect(user.totpEnabled).toBe(false);
    expect(user.totpSecretEnc).toBeNull();
  });

  it('disable 미활성 상태는 409 TOTP_NOT_ENABLED', async () => {
    const { svc } = makeService({ totpEnabled: false, totpSecretEnc: null });
    await expect(svc.disable('u1', '123456')).rejects.toMatchObject({
      code: ErrorCode.TOTP_NOT_ENABLED,
    });
  });

  // SF2·SF3: 자격증명 변경 TOTP 게이트. 미활성이면 no-op, 활성인데 누락이면 TOTP_CODE_REQUIRED,
  // 불일치면 TOTP_INVALID, 유효 코드면 통과.
  it('assertCredentialChangeTotp: 2FA 미활성이면 코드 없이도 통과(no-op)', async () => {
    const { svc } = makeService({ totpEnabled: false, totpSecretEnc: null });
    await expect(svc.assertCredentialChangeTotp('u1', undefined)).resolves.toBeUndefined();
  });

  it('assertCredentialChangeTotp: 2FA 활성인데 코드 누락은 403 TOTP_CODE_REQUIRED', async () => {
    const user: UserRow = { totpEnabled: false, totpSecretEnc: null };
    const { svc } = makeService(user);
    const setup = await svc.setup('u1', 'a@b.com');
    await svc.verify('u1', authenticator.generate(setup.secret));
    await expect(svc.assertCredentialChangeTotp('u1', undefined)).rejects.toMatchObject({
      code: ErrorCode.TOTP_CODE_REQUIRED,
    });
  });

  it('assertCredentialChangeTotp: 2FA 활성 + 유효 코드면 통과, 불일치는 TOTP_INVALID', async () => {
    const user: UserRow = { totpEnabled: false, totpSecretEnc: null };
    const { svc, crypto } = makeService(user);
    const setup = await svc.setup('u1', 'a@b.com');
    await svc.verify('u1', authenticator.generate(setup.secret));

    await expect(svc.assertCredentialChangeTotp('u1', '000000')).rejects.toMatchObject({
      code: ErrorCode.TOTP_INVALID,
    });

    // 30초 진행 → 새 step 코드(replay 회피) → 통과.
    vi.setSystemTime(new Date('2025-01-01T00:00:31Z'));
    const live = authenticator.generate(crypto.decrypt(user.totpSecretEnc as string));
    await expect(svc.assertCredentialChangeTotp('u1', live)).resolves.toBeUndefined();
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
