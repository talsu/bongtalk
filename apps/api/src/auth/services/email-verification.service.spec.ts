import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMAIL_VERIFY_RESEND_COOLDOWN_SEC,
  EMAIL_VERIFY_RESEND_DAILY_MAX,
  EMAIL_VERIFY_TOKEN_TTL_SEC,
} from '@qufox/shared-types';
import { EmailVerificationService } from './email-verification.service';
import type { MailSender } from './mail.service';
import { ErrorCode } from '../../common/errors/error-code.enum';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

type TokenRow = {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
  usedAt: Date | null;
};

/**
 * 최소 in-memory Prisma 스텁(vi.fn 만 — 외부 모킹 라이브러리 금지). emailVerificationToken
 * create/findUnique/updateMany + user.update + $transaction(콜백 즉시 실행)을 흉내낸다.
 */
function makePrismaStub() {
  const tokens: TokenRow[] = [];
  const users = new Map<string, { emailVerified: boolean }>();

  const tx = {
    emailVerificationToken: {
      create: vi.fn(async ({ data }: { data: Omit<TokenRow, 'usedAt'> & { usedAt?: Date } }) => {
        const row: TokenRow = { ...data, usedAt: data.usedAt ?? null };
        tokens.push(row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { token: string } }) => {
        return tokens.find((t) => t.token === where.token) ?? null;
      }),
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
        async ({ where, data }: { where: { id: string }; data: { emailVerified: boolean } }) => {
          users.set(where.id, { emailVerified: data.emailVerified });
          return { id: where.id, ...data };
        },
      ),
    },
  };

  const prisma = {
    emailVerificationToken: tx.emailVerificationToken,
    user: {
      update: tx.user.update,
      // S66 fix-forward (review MEDIUM-1): resend() 초입에서 emailVerified 를 조회한다.
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return users.get(where.id) ?? null;
      }),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    __tokens: tokens,
    __users: users,
  };
  return prisma;
}

/** 최소 in-memory Redis 스텁(incr/expire/ttl/set with EX + NX). */
function makeRedisStub() {
  const values = new Map<string, string>();
  const ttls = new Map<string, number>();
  return {
    incr: vi.fn(async (key: string) => {
      const next = Number(values.get(key) ?? '0') + 1;
      values.set(key, String(next));
      return next;
    }),
    expire: vi.fn(async (key: string, sec: number) => {
      ttls.set(key, sec);
      return 1;
    }),
    ttl: vi.fn(async (key: string) => ttls.get(key) ?? -2),
    // S66 fix-forward (review HIGH-1): SET key val EX sec [NX]. NX 는 키가 이미 존재하면
    // 점유 실패(null), 부재면 set 후 'OK'. ttl<=0(만료/미존재)인 슬롯은 부재로 본다.
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
          const exists = values.has(key) && ttl !== -2 && (ttl > 0 || ttl === -1);
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
    sendVerificationEmail: vi.fn(async (to: string, url: string) => {
      sent.push({ to, url });
    }),
    // S68 (D13 / FR-W04 · Fork B): MailSender 인터페이스에 워크스페이스 초대 메일이
    // 추가돼 stub 도 구현을 가져야 한다(이 스펙은 인증 메일만 검증하므로 no-op).
    sendWorkspaceInviteEmail: vi.fn(async () => undefined),
    // S77b (D14 / FR-PS-15): 보안 알림 메일 인터페이스 추가(이 스펙은 미검증 — no-op).
    sendSecurityAlertEmail: vi.fn(async () => undefined),
  };
}

function makeService() {
  const prisma = makePrismaStub();
  const redis = makeRedisStub();
  const mail = makeMailStub();
  const svc = new EmailVerificationService(prisma as never, redis as never, mail);
  return { svc, prisma, redis, mail };
}

describe('S66 EmailVerificationService — token lifecycle (FR-W05b)', () => {
  it('createToken 은 발급+24h 만료 토큰을 저장한다', async () => {
    const { svc, prisma } = makeService();
    const now = new Date('2025-01-01T00:00:00Z');
    const token = await svc.createToken('u1', now);
    expect(prisma.__tokens).toHaveLength(1);
    const row = prisma.__tokens[0];
    expect(row.token).toBe(token);
    expect(row.expiresAt.getTime()).toBe(now.getTime() + EMAIL_VERIFY_TOKEN_TTL_SEC * 1000);
    expect(row.usedAt).toBeNull();
  });

  it('issueAndSend 는 토큰 생성 + verifyUrl 발송한다', async () => {
    const { svc, mail, prisma } = makeService();
    await svc.issueAndSend('u1', 'a@acme.com', new Date('2025-01-01T00:00:00Z'));
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe('a@acme.com');
    expect(mail.sent[0].url).toContain(`token=${prisma.__tokens[0].token}`);
    expect(mail.sent[0].url).toContain('/verify-email?token=');
  });

  it('verify 성공 시 usedAt 기록 + emailVerified=true', async () => {
    const { svc, prisma } = makeService();
    const token = await svc.createToken('u1', new Date('2025-01-01T00:00:00Z'));
    const res = await svc.verify(token, new Date('2025-01-01T01:00:00Z'));
    expect(res.userId).toBe('u1');
    expect(prisma.__tokens[0].usedAt).not.toBeNull();
    expect(prisma.__users.get('u1')?.emailVerified).toBe(true);
  });

  it('verify 재사용(이미 usedAt)은 TOKEN_INVALID(400) 로 거부한다', async () => {
    const { svc } = makeService();
    const token = await svc.createToken('u1', new Date('2025-01-01T00:00:00Z'));
    await svc.verify(token, new Date('2025-01-01T01:00:00Z'));
    await expect(svc.verify(token, new Date('2025-01-01T02:00:00Z'))).rejects.toMatchObject({
      code: ErrorCode.EMAIL_VERIFICATION_TOKEN_INVALID,
    });
  });

  it('verify 만료 토큰은 TOKEN_EXPIRED(410) 로 거부한다', async () => {
    const { svc } = makeService();
    const now = new Date('2025-01-01T00:00:00Z');
    const token = await svc.createToken('u1', now);
    const afterExpiry = new Date(now.getTime() + (EMAIL_VERIFY_TOKEN_TTL_SEC + 1) * 1000);
    await expect(svc.verify(token, afterExpiry)).rejects.toMatchObject({
      code: ErrorCode.EMAIL_VERIFICATION_TOKEN_EXPIRED,
    });
  });

  it('verify 미존재/형식오류 토큰은 TOKEN_INVALID(400) 로 거부한다', async () => {
    const { svc } = makeService();
    // 형식 오류(uuid 아님).
    await expect(svc.verify('not-a-uuid')).rejects.toMatchObject({
      code: ErrorCode.EMAIL_VERIFICATION_TOKEN_INVALID,
    });
    // 형식은 맞지만 미존재.
    await expect(svc.verify('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({
      code: ErrorCode.EMAIL_VERIFICATION_TOKEN_INVALID,
    });
  });
});

describe('S66 EmailVerificationService — resend rate-limit (FR-W05b)', () => {
  it('첫 재발송은 통과하고 60초 쿨다운 + 남은 횟수를 돌려준다', async () => {
    const { svc, redis, mail } = makeService();
    const res = await svc.resend('u1', 'a@acme.com', new Date('2025-01-01T00:00:00Z'));
    expect(res.cooldownSec).toBe(EMAIL_VERIFY_RESEND_COOLDOWN_SEC);
    expect(res.remainingToday).toBe(EMAIL_VERIFY_RESEND_DAILY_MAX - 1);
    expect(mail.sent).toHaveLength(1);
    expect(redis.__ttls.get('email_verify_resend:u1')).toBe(EMAIL_VERIFY_RESEND_COOLDOWN_SEC);
  });

  it('쿨다운 중 재발송은 RATE_LIMITED(429) 로 거부한다', async () => {
    const { svc, redis } = makeService();
    await svc.resend('u1', 'a@acme.com', new Date('2025-01-01T00:00:00Z'));
    // 쿨다운 키 TTL 이 살아있는 상태(스텁 ttl 은 set 값을 그대로 반환).
    expect(redis.__ttls.get('email_verify_resend:u1')).toBeGreaterThan(0);
    await expect(svc.resend('u1', 'a@acme.com')).rejects.toMatchObject({
      code: ErrorCode.EMAIL_VERIFICATION_RATE_LIMITED,
    });
  });

  it('일일 한도(5회) 초과 시 RATE_LIMITED(429) 로 거부한다', async () => {
    const { svc, redis } = makeService();
    // 쿨다운을 매번 비워 일일 카운터만 누적시킨다.
    for (let i = 0; i < EMAIL_VERIFY_RESEND_DAILY_MAX; i++) {
      redis.__ttls.set('email_verify_resend:u1', -2); // 쿨다운 만료 흉내
      await svc.resend('u1', 'a@acme.com');
    }
    redis.__ttls.set('email_verify_resend:u1', -2);
    await expect(svc.resend('u1', 'a@acme.com')).rejects.toMatchObject({
      code: ErrorCode.EMAIL_VERIFICATION_RATE_LIMITED,
    });
  });

  it('이미 인증된 사용자는 토큰/메일/쿼터 없이 멱등 조기반환한다(MEDIUM-1)', async () => {
    const { svc, mail, prisma, redis } = makeService();
    prisma.__users.set('uv', { emailVerified: true });
    const res = await svc.resend('uv', 'v@acme.com', new Date('2025-01-01T00:00:00Z'));
    expect(res.cooldownSec).toBe(0);
    expect(res.remainingToday).toBe(EMAIL_VERIFY_RESEND_DAILY_MAX);
    // 토큰/메일/쿨다운 쿼터를 일절 쓰지 않는다.
    expect(prisma.__tokens).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
    expect(redis.__values.get('email_verify_resend:uv')).toBeUndefined();
    expect(redis.__values.get('email_verify_daily:uv')).toBeUndefined();
  });

  it('동시 재발송은 NX 쿨다운으로 1건만 통과·나머지는 429(HIGH-1)', async () => {
    const { svc, mail } = makeService();
    // 같은 사용자에 대해 동시 두 호출 — NX 쿨다운 슬롯은 하나만 점유 가능하다.
    const results = await Promise.allSettled([
      svc.resend('race', 'r@acme.com', new Date('2025-01-01T00:00:00Z')),
      svc.resend('race', 'r@acme.com', new Date('2025-01-01T00:00:00Z')),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // 정확히 1건만 메일을 보낸다(메일 폭탄 방지).
    expect(mail.sent).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: ErrorCode.EMAIL_VERIFICATION_RATE_LIMITED,
    });
  });

  it('일일 카운터 TTL 누락(ttl<0)이면 재설정한다(HIGH-1 방어)', async () => {
    const { svc, redis } = makeService();
    // 카운터가 살아있으나 TTL 이 -1(영구)인 상태를 만든다.
    redis.__values.set('email_verify_daily:ttldef', '2');
    redis.__ttls.set('email_verify_daily:ttldef', -1);
    await svc.resend('ttldef', 't@acme.com', new Date('2025-01-01T00:00:00Z'));
    // INCR → 3, ttl<0 감지 → 24h EXPIRE 재설정.
    expect(redis.__ttls.get('email_verify_daily:ttldef')).toBe(24 * 60 * 60);
  });
});
