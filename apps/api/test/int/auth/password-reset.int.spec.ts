/**
 * AUTH-3 (PRD D18 §5 / FR-AUTH-40~44) — 비밀번호 재설정(미인증/비로그인) 플로우.
 *
 * forgot-password 가 미존재/존재 모두 200(열거 방어)·존재+활성 시 PasswordResetToken 1행
 * 생성 → reset-password 유효 토큰 성공(비밀번호 교체 + 전 RefreshToken revoke) → 만료(시간
 * 진행)·무효/중복소모·비번 정책 미달 거부. raw 토큰은 메일/로거로만 나가므로(tokenHash 만
 * 저장) sha256 으로 역추적해 DB 에서 읽는다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { WsIntEnv, setupWsIntEnv, signupAsUser, STRONG_PW } from '../workspaces/helpers';
import { MAIL_SENDER, type MailSender } from '../../../src/auth/services/mail.service';

let env: WsIntEnv;
const ORIGIN = 'http://localhost:45173';

beforeAll(async () => {
  env = await setupWsIntEnv();
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

async function clearResetBuckets(): Promise<void> {
  if (!env?.redis) return;
  const keys = [
    ...(await env.redis.keys('rl:forgot-password:ip:*')),
    ...(await env.redis.keys('rl:reset-password:ip:*')),
    ...(await env.redis.keys('password_reset_cooldown:*')),
  ];
  if (keys.length > 0) await env.redis.del(...keys);
}

beforeEach(async () => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  await clearResetBuckets();
});

const sha256 = (raw: string): string => createHash('sha256').update(raw).digest('hex');

/** 가장 최근 발급된 재설정 토큰 행을 userId 로 읽는다(raw 토큰은 DB 에 없고 tokenHash 만). */
async function latestResetTokenRow(userId: string) {
  const row = await env.prisma.passwordResetToken.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
  if (!row) throw new Error('no password reset token for user');
  return row;
}

/**
 * forgot-password 로 토큰을 발급한 뒤, 미리 알고 있는 raw 토큰 후보들을 sha256 해 DB 의
 * tokenHash 와 대조하는 식으로는 raw 를 복원할 수 없으므로(단방향), 테스트는 service 가
 * tokenHash 를 저장한다는 사실만 검증하고, reset 경로는 직접 raw 토큰을 만들어 DB 에 시드한다.
 */
async function seedResetToken(userId: string, rawToken: string, expiresAt: Date): Promise<void> {
  await env.prisma.passwordResetToken.create({
    data: { userId, tokenHash: sha256(rawToken), expiresAt },
  });
}

describe('AUTH-3 forgot-password (FR-AUTH-40 · 열거 방어)', () => {
  it('미존재 이메일도 200 { ok: true } 을 반환한다(열거 방어)', async () => {
    const res = await request(env.baseUrl)
      .post('/auth/forgot-password')
      .set('origin', ORIGIN)
      .send({ email: `nobody-${Date.now()}@qufox.dev` });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('존재+활성 이메일은 200 + PasswordResetToken 1행을 생성한다', async () => {
    const u = await signupAsUser(env.baseUrl, 'pwfp'); // verified+active by default
    const res = await request(env.baseUrl)
      .post('/auth/forgot-password')
      .set('origin', ORIGIN)
      .send({ email: u.email });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const row = await latestResetTokenRow(u.userId);
    // raw 토큰이 아니라 sha256 hex(64자리)만 저장한다.
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.usedAt).toBeNull();
    // TTL 1h.
    expect(row.expiresAt.getTime()).toBe(
      new Date('2025-01-01T00:00:00Z').getTime() + 60 * 60 * 1000,
    );
  });

  it('IP 당 15분 5회 초과 시 429 RATE_LIMITED', async () => {
    let limited = false;
    for (let i = 0; i < 6; i++) {
      const res = await request(env.baseUrl)
        .post('/auth/forgot-password')
        .set('origin', ORIGIN)
        .send({ email: `enum-${i}@qufox.dev` });
      if (res.status === 429) {
        expect(res.body.errorCode).toBe('RATE_LIMITED');
        limited = true;
        break;
      }
      expect(res.status).toBe(200);
    }
    expect(limited).toBe(true);
  });
});

describe('AUTH-3 reset-password (FR-AUTH-41·42)', () => {
  it('유효 토큰 reset → 200, 새 비밀번호로 로그인 성공·옛 비밀번호는 실패', async () => {
    const u = await signupAsUser(env.baseUrl, 'pwrs');
    const rawToken = '11111111-1111-4111-8111-111111111111';
    await seedResetToken(u.userId, rawToken, new Date('2025-01-01T00:30:00Z'));

    const newPw = 'Reset-Brand-New-77!';
    const reset = await request(env.baseUrl)
      .post('/auth/reset-password')
      .set('origin', ORIGIN)
      .send({ token: rawToken, password: newPw });
    expect(reset.status).toBe(200);
    expect(reset.body.ok).toBe(true);

    // 새 비밀번호로 로그인 성공.
    const loginNew = await request(env.baseUrl)
      .post('/auth/login')
      .set('origin', ORIGIN)
      .send({ email: u.email, password: newPw });
    expect(loginNew.status).toBe(200);

    // 옛 비밀번호는 더는 통하지 않는다.
    const loginOld = await request(env.baseUrl)
      .post('/auth/login')
      .set('origin', ORIGIN)
      .send({ email: u.email, password: STRONG_PW });
    expect(loginOld.status).toBe(401);
  });

  it('reset 성공 시 발급 시점의 RefreshToken 이 전부 revoke 된다(FR-AUTH-42)', async () => {
    const u = await signupAsUser(env.baseUrl, 'pwrev');
    // signup 으로 생긴 refresh cookie 로 refresh 가 정상 동작함을 먼저 확인.
    const before = await request(env.baseUrl)
      .post('/auth/refresh')
      .set('origin', ORIGIN)
      .set('Cookie', u.cookie);
    expect(before.status).toBe(200);

    const rawToken = '22222222-2222-4222-8222-222222222222';
    await seedResetToken(u.userId, rawToken, new Date('2025-01-01T00:30:00Z'));
    await request(env.baseUrl)
      .post('/auth/reset-password')
      .set('origin', ORIGIN)
      .send({ token: rawToken, password: 'Reset-Brand-New-88!' })
      .expect(200);

    // reset 후에는 발급 시점의 refresh 토큰(및 그 rotation 자손)이 전부 revoke 되어 401.
    const active = await env.prisma.refreshToken.count({
      where: { userId: u.userId, revokedAt: null },
    });
    expect(active).toBe(0);
  });

  it('만료 토큰(1h 경과)은 410 PASSWORD_RESET_TOKEN_EXPIRED', async () => {
    const u = await signupAsUser(env.baseUrl, 'pwexp');
    const rawToken = '33333333-3333-4333-8333-333333333333';
    // 발급 시점을 과거로 둬 만료시킨다(now=2025-01-01T00:00 보다 이전 만료).
    await seedResetToken(u.userId, rawToken, new Date('2024-12-31T23:00:00Z'));
    const res = await request(env.baseUrl)
      .post('/auth/reset-password')
      .set('origin', ORIGIN)
      .send({ token: rawToken, password: 'Reset-Brand-New-99!' });
    expect(res.status).toBe(410);
    expect(res.body.errorCode).toBe('PASSWORD_RESET_TOKEN_EXPIRED');
  });

  it('무효(미존재) 토큰은 400 PASSWORD_RESET_TOKEN_INVALID', async () => {
    const res = await request(env.baseUrl)
      .post('/auth/reset-password')
      .set('origin', ORIGIN)
      .send({ token: '44444444-4444-4444-8444-444444444444', password: 'Reset-Brand-New-00!' });
    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('PASSWORD_RESET_TOKEN_INVALID');
  });

  it('중복 소모(이미 usedAt)는 400 PASSWORD_RESET_TOKEN_INVALID', async () => {
    const u = await signupAsUser(env.baseUrl, 'pwdup');
    const rawToken = '55555555-5555-4555-8555-555555555555';
    await seedResetToken(u.userId, rawToken, new Date('2025-01-01T00:30:00Z'));
    await request(env.baseUrl)
      .post('/auth/reset-password')
      .set('origin', ORIGIN)
      .send({ token: rawToken, password: 'Reset-Brand-New-11!' })
      .expect(200);
    const second = await request(env.baseUrl)
      .post('/auth/reset-password')
      .set('origin', ORIGIN)
      .send({ token: rawToken, password: 'Reset-Brand-New-22!' });
    expect(second.status).toBe(400);
    expect(second.body.errorCode).toBe('PASSWORD_RESET_TOKEN_INVALID');
  });

  it('비밀번호 정책 미달(8자 미만)은 400 VALIDATION_FAILED', async () => {
    const u = await signupAsUser(env.baseUrl, 'pwweak');
    const rawToken = '66666666-6666-4666-8666-666666666666';
    await seedResetToken(u.userId, rawToken, new Date('2025-01-01T00:30:00Z'));
    const res = await request(env.baseUrl)
      .post('/auth/reset-password')
      .set('origin', ORIGIN)
      .send({ token: rawToken, password: 'short' });
    expect(res.status).toBe(400);
  });

  // security MED: Zod(PasswordSchema)는 길이(min 8)만 본다 — 단일 문자 클래스 8자('aaaaaaaa')는
  // 통과하지만 강도 정책(3 class)에는 미달이다. 서비스가 해싱 전 validateStrength 로 거부해야
  // 한다(signup/changePassword 경로와 동일). 422 AUTH_WEAK_PASSWORD.
  it('단일 문자 클래스 8자 약비번은 422 AUTH_WEAK_PASSWORD 로 거부한다', async () => {
    const u = await signupAsUser(env.baseUrl, 'pwweakclass');
    const rawToken = '77777777-7777-4777-8777-777777777777';
    await seedResetToken(u.userId, rawToken, new Date('2025-01-01T00:30:00Z'));
    const res = await request(env.baseUrl)
      .post('/auth/reset-password')
      .set('origin', ORIGIN)
      .send({ token: rawToken, password: 'aaaaaaaa' });
    expect(res.status).toBe(422);
    expect(res.body.errorCode).toBe('AUTH_WEAK_PASSWORD');
    // 약비번 거부 시 비밀번호는 교체되지 않는다 — 기존 비밀번호로 여전히 로그인된다.
    const loginOld = await request(env.baseUrl)
      .post('/auth/login')
      .set('origin', ORIGIN)
      .send({ email: u.email, password: STRONG_PW });
    expect(loginOld.status).toBe(200);
  });

  // reviewer MAJOR: reset 성공 시 등록 이메일로 보안 알림(password_changed)을 best-effort
  // 발송한다(Console stub 의 sendSecurityAlertEmail 호출을 spy 로 검증).
  it('reset 성공 시 보안 알림 메일(password_changed)을 발송한다', async () => {
    const u = await signupAsUser(env.baseUrl, 'pwalert');
    const rawToken = '88888888-8888-4888-8888-888888888888';
    await seedResetToken(u.userId, rawToken, new Date('2025-01-01T00:30:00Z'));

    const mail = env.app.get<MailSender>(MAIL_SENDER);
    const alertSpy = vi.spyOn(mail, 'sendSecurityAlertEmail');
    try {
      await request(env.baseUrl)
        .post('/auth/reset-password')
        .set('origin', ORIGIN)
        .send({ token: rawToken, password: 'Reset-Brand-New-33!' })
        .expect(200);
      expect(alertSpy).toHaveBeenCalledWith(u.email, 'password_changed');
    } finally {
      alertSpy.mockRestore();
    }
  });
});
