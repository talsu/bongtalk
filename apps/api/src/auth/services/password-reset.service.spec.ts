import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { PASSWORD_RESET_TOKEN_TTL_SEC } from '@qufox/shared-types';
import { PasswordResetService } from './password-reset.service';
import type { MailSender } from './mail.service';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { DomainError } from '../../common/errors/domain-error';

/**
 * AUTH-3 (PRD D18 §5 / FR-AUTH-40~44) — PasswordResetService 단위 테스트.
 *
 * 외부 모킹 라이브러리 금지: Prisma/Redis/Mail/Password/Token 은 모두 vi.fn 스텁이다.
 * 핵심 단언: ① forgot 은 미존재/비활성/쿨다운에서 토큰·메일 없이 조용히 반환(열거 방어),
 * 존재+활성에서만 tokenHash(sha256) 1행 + 메일. ② reset 은 raw 토큰을 sha256 으로 조회·
 * 단일 tx CAS 소모·argon2 재해싱·전 RefreshToken revoke. 만료 410 / 무효·재사용 400.
 */

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const sha256 = (raw: string): string => createHash('sha256').update(raw).digest('hex');

type TokenRow = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
};
type UserRow = {
  id: string;
  email: string;
  isDeactivated: boolean;
  passwordHash: string;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
};

function makePrismaStub() {
  const tokens: TokenRow[] = [];
  const users = new Map<string, UserRow>();

  const tx = {
    passwordResetToken: {
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; usedAt: null };
          data: { usedAt: Date };
        }) => {
          const row = tokens.find((t) => t.id === where.id && t.usedAt === null);
          if (!row) return { count: 0 };
          row.usedAt = data.usedAt;
          return { count: 1 };
        },
      ),
    },
    user: {
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { passwordHash: string; failedLoginAttempts: number; lockedUntil: Date | null };
        }) => {
          const u = users.get(where.id);
          if (u) Object.assign(u, data);
          return { id: where.id, ...data };
        },
      ),
    },
  };

  const prisma = {
    passwordResetToken: {
      create: vi.fn(async ({ data }: { data: Omit<TokenRow, 'usedAt'> & { usedAt?: Date } }) => {
        const row: TokenRow = { ...data, usedAt: data.usedAt ?? null };
        tokens.push(row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) => {
        return tokens.find((t) => t.tokenHash === where.tokenHash) ?? null;
      }),
      updateMany: tx.passwordResetToken.updateMany,
    },
    user: {
      // requestReset 는 where: { email }, reset 은 보안 알림용 이메일 조회로 where: { id }
      // 를 쓴다 — 두 형태를 모두 처리한다.
      findUnique: vi.fn(async ({ where }: { where: { email?: string; id?: string } }) => {
        for (const u of users.values()) {
          if (where.email !== undefined && u.email === where.email) return u;
          if (where.id !== undefined && u.id === where.id) return u;
        }
        return null;
      }),
      update: tx.user.update,
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    __tokens: tokens,
    __users: users,
  };
  return prisma;
}

function makeRedisStub() {
  const values = new Map<string, string>();
  const ttls = new Map<string, number>();
  return {
    set: vi.fn(
      async (
        key: string,
        val: string,
        _ex: 'EX',
        sec: number,
        mode?: 'NX',
      ): Promise<'OK' | null> => {
        if (mode === 'NX') {
          const ttl = ttls.get(key) ?? -2;
          const exists = values.has(key) && ttl !== -2;
          if (exists) return null;
        }
        values.set(key, val);
        ttls.set(key, sec);
        return 'OK';
      },
    ),
    __values: values,
    __ttls: ttls,
  };
}

function makeMailStub(): MailSender & { sent: Array<{ to: string; url: string }> } {
  const sent: Array<{ to: string; url: string }> = [];
  return {
    sent,
    sendVerificationEmail: vi.fn(async () => undefined),
    sendWorkspaceInviteEmail: vi.fn(async () => undefined),
    sendSecurityAlertEmail: vi.fn(async () => undefined),
    sendPasswordResetEmail: vi.fn(async (to: string, url: string) => {
      sent.push({ to, url });
    }),
  };
}

function makePasswordStub() {
  return {
    hash: vi.fn(async (plain: string) => `argon2$$${plain}`),
    // security MED: reset() 가 해싱 전 강도 검증을 호출한다. 기본 스텁은 통과(no-op)하고,
    // 약비번 거부 검증 테스트에서만 throw 하도록 개별 재정의한다.
    validateStrength: vi.fn(() => undefined),
  };
}

function makeTokenStub() {
  return { revokeAllExceptFamily: vi.fn(async () => 3) };
}

function makeService() {
  const prisma = makePrismaStub();
  const redis = makeRedisStub();
  const mail = makeMailStub();
  const passwords = makePasswordStub();
  const tokens = makeTokenStub();
  const svc = new PasswordResetService(
    prisma as never,
    redis as never,
    mail,
    passwords as never,
    tokens as never,
  );
  return { svc, prisma, redis, mail, passwords, tokens };
}

function seedUser(prisma: ReturnType<typeof makePrismaStub>, over: Partial<UserRow> = {}): UserRow {
  const u: UserRow = {
    id: over.id ?? 'u1',
    email: over.email ?? 'a@acme.com',
    isDeactivated: over.isDeactivated ?? false,
    passwordHash: over.passwordHash ?? 'old-hash',
    failedLoginAttempts: over.failedLoginAttempts ?? 0,
    lockedUntil: over.lockedUntil ?? null,
  };
  prisma.__users.set(u.id, u);
  return u;
}

describe('AUTH-3 PasswordResetService — requestReset (FR-AUTH-40 · 열거 방어)', () => {
  it('존재+활성 사용자는 tokenHash(sha256) 토큰 1행 + 재설정 메일을 만든다', async () => {
    const { svc, prisma, mail } = makeService();
    seedUser(prisma, { id: 'u1', email: 'a@acme.com' });
    await svc.requestReset('a@acme.com', new Date('2025-01-01T00:00:00Z'));
    expect(prisma.__tokens).toHaveLength(1);
    const row = prisma.__tokens[0];
    // raw 토큰은 저장하지 않는다 — tokenHash 는 64자리 hex(sha256).
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.expiresAt.getTime()).toBe(
      new Date('2025-01-01T00:00:00Z').getTime() + PASSWORD_RESET_TOKEN_TTL_SEC * 1000,
    );
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe('a@acme.com');
    expect(mail.sent[0].url).toContain('/reset-password?token=');
    // 메일에 실린 raw 토큰의 sha256 이 저장된 tokenHash 와 일치한다.
    const rawToken = mail.sent[0].url.split('token=')[1];
    expect(sha256(rawToken)).toBe(row.tokenHash);
  });

  it('미존재 이메일은 토큰/메일 없이 조용히 반환한다(열거 방어)', async () => {
    const { svc, prisma, mail } = makeService();
    await svc.requestReset('nobody@acme.com');
    expect(prisma.__tokens).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });

  it('비활성 계정도 토큰/메일 없이 조용히 반환한다(열거 방어)', async () => {
    const { svc, prisma, mail } = makeService();
    seedUser(prisma, { id: 'ud', email: 'd@acme.com', isDeactivated: true });
    await svc.requestReset('d@acme.com');
    expect(prisma.__tokens).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });

  it('이메일은 소문자로 정규화해 조회한다', async () => {
    const { svc, prisma, mail } = makeService();
    seedUser(prisma, { id: 'u1', email: 'a@acme.com' });
    await svc.requestReset('  A@ACME.COM  ');
    expect(mail.sent).toHaveLength(1);
  });

  it('이메일당 쿨다운(NX) 중 재요청은 토큰/메일 없이 조용히 반환한다', async () => {
    const { svc, prisma, mail } = makeService();
    seedUser(prisma, { id: 'u1', email: 'a@acme.com' });
    await svc.requestReset('a@acme.com');
    expect(mail.sent).toHaveLength(1);
    // 같은 주소 즉시 재요청 — 쿨다운 슬롯이 점유돼 있어 발송하지 않는다.
    await svc.requestReset('a@acme.com');
    expect(mail.sent).toHaveLength(1);
    expect(prisma.__tokens).toHaveLength(1);
  });
});

describe('AUTH-3 PasswordResetService — reset (FR-AUTH-41·42)', () => {
  async function issueToken(
    svc: PasswordResetService,
    mail: ReturnType<typeof makeMailStub>,
    now = new Date('2025-01-01T00:00:00Z'),
  ): Promise<string> {
    await svc.requestReset('a@acme.com', now);
    return mail.sent[mail.sent.length - 1].url.split('token=')[1];
  }

  it('유효 토큰 reset 은 비밀번호 교체 + usedAt + 전 RefreshToken revoke', async () => {
    const { svc, prisma, mail, passwords, tokens } = makeService();
    const u = seedUser(prisma, { id: 'u1', email: 'a@acme.com', passwordHash: 'old-hash' });
    const rawToken = await issueToken(svc, mail);

    const res = await svc.reset(rawToken, 'Brand-New-Pass-99!', new Date('2025-01-01T00:30:00Z'));
    expect(res.userId).toBe('u1');
    // argon2 재해싱으로 교체.
    expect(passwords.hash).toHaveBeenCalledWith('Brand-New-Pass-99!');
    expect(u.passwordHash).toBe('argon2$$Brand-New-Pass-99!');
    // 단일 tx CAS 소모.
    expect(prisma.__tokens[0].usedAt).not.toBeNull();
    // FR-AUTH-42: 전 기기 강제 로그아웃(exceptFamilyId=null).
    expect(tokens.revokeAllExceptFamily).toHaveBeenCalledWith('u1', null);
    // 잠금/실패 카운터 초기화.
    expect(u.failedLoginAttempts).toBe(0);
    expect(u.lockedUntil).toBeNull();
  });

  it('재사용(이미 usedAt)은 TOKEN_INVALID(400) 로 거부한다', async () => {
    const { svc, prisma, mail, tokens } = makeService();
    seedUser(prisma, { id: 'u1', email: 'a@acme.com' });
    const rawToken = await issueToken(svc, mail);
    await svc.reset(rawToken, 'Brand-New-Pass-99!', new Date('2025-01-01T00:30:00Z'));
    tokens.revokeAllExceptFamily.mockClear();
    await expect(
      svc.reset(rawToken, 'Another-Pass-22!', new Date('2025-01-01T00:40:00Z')),
    ).rejects.toMatchObject({ code: ErrorCode.PASSWORD_RESET_TOKEN_INVALID });
    // 재사용 거부 시 세션 revoke 는 호출되지 않는다.
    expect(tokens.revokeAllExceptFamily).not.toHaveBeenCalled();
  });

  it('만료 토큰(1h 경과)은 TOKEN_EXPIRED(410) 로 거부한다', async () => {
    const { svc, prisma, mail } = makeService();
    seedUser(prisma, { id: 'u1', email: 'a@acme.com' });
    const now = new Date('2025-01-01T00:00:00Z');
    const rawToken = await issueToken(svc, mail, now);
    const afterExpiry = new Date(now.getTime() + (PASSWORD_RESET_TOKEN_TTL_SEC + 1) * 1000);
    await expect(svc.reset(rawToken, 'Brand-New-Pass-99!', afterExpiry)).rejects.toMatchObject({
      code: ErrorCode.PASSWORD_RESET_TOKEN_EXPIRED,
    });
  });

  it('형식오류/미존재 토큰은 TOKEN_INVALID(400) 로 거부한다', async () => {
    const { svc } = makeService();
    await expect(svc.reset('not-a-uuid', 'Brand-New-Pass-99!')).rejects.toMatchObject({
      code: ErrorCode.PASSWORD_RESET_TOKEN_INVALID,
    });
    await expect(
      svc.reset('00000000-0000-4000-8000-000000000000', 'Brand-New-Pass-99!'),
    ).rejects.toMatchObject({ code: ErrorCode.PASSWORD_RESET_TOKEN_INVALID });
  });

  it('약비번(validateStrength throw)은 해싱·소모 없이 거부한다', async () => {
    const { svc, prisma, mail, passwords, tokens } = makeService();
    seedUser(prisma, { id: 'u1', email: 'a@acme.com' });
    const rawToken = await issueToken(svc, mail);
    // 강도 검증이 throw 하면 reset 도 그대로 전파해야 한다(해싱·CAS 소모 전 거부).
    passwords.validateStrength.mockImplementationOnce(() => {
      throw new DomainError(ErrorCode.AUTH_WEAK_PASSWORD, 'weak');
    });
    await expect(
      svc.reset(rawToken, 'aaaaaaaa', new Date('2025-01-01T00:30:00Z')),
    ).rejects.toMatchObject({ code: ErrorCode.AUTH_WEAK_PASSWORD });
    // 거부 시 비밀번호 미해싱·토큰 미소모·세션 미revoke.
    expect(passwords.hash).not.toHaveBeenCalled();
    expect(prisma.__tokens[0].usedAt).toBeNull();
    expect(tokens.revokeAllExceptFamily).not.toHaveBeenCalled();
  });

  it('reset 성공 시 등록 이메일로 보안 알림(password_changed)을 발송한다', async () => {
    const { svc, prisma, mail } = makeService();
    seedUser(prisma, { id: 'u1', email: 'a@acme.com' });
    const rawToken = await issueToken(svc, mail);
    await svc.reset(rawToken, 'Brand-New-Pass-99!', new Date('2025-01-01T00:30:00Z'));
    expect(mail.sendSecurityAlertEmail).toHaveBeenCalledWith('a@acme.com', 'password_changed');
  });

  it('보안 알림 발송 실패는 reset 결과를 깨지 않는다(best-effort)', async () => {
    const { svc, prisma, mail } = makeService();
    const u = seedUser(prisma, { id: 'u1', email: 'a@acme.com' });
    const rawToken = await issueToken(svc, mail);
    (mail.sendSecurityAlertEmail as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('smtp down'),
    );
    const res = await svc.reset(rawToken, 'Brand-New-Pass-99!', new Date('2025-01-01T00:30:00Z'));
    // 메일이 throw 해도 비밀번호 교체·토큰 소모는 완료되고 정상 반환한다.
    expect(res.userId).toBe('u1');
    expect(u.passwordHash).toBe('argon2$$Brand-New-Pass-99!');
    expect(prisma.__tokens[0].usedAt).not.toBeNull();
  });
});
