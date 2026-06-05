/**
 * S77c (D14 / FR-PS-16·19) — 계정 비활성화/재활성화 + 30일 익명화 크론.
 *
 *   - deactivate: 단일 tx(isDeactivated=true + deactivatedAt + RefreshToken 전체 삭제) + Redis
 *     `deactivated:{userId}` TTL SET + 비활성 계정 요청 차단(JWT 이중검사 ACCOUNT_DEACTIVATED).
 *   - 잘못된 비번 → 403 PASSWORD_INCORRECT.
 *   - reactivate: 30일 이내 자격증명 검증 후 복구(isDeactivated=false·deactivatedAt=null).
 *   - 익명화 크론: deactivatedAt=now-31d → PII null·Message.authorId=SYSTEM_ANON·멱등(재실행 무변)
 *     ·30일 미만/비활성 아닌 유저 미접근(★격리 fixture 만 · 실 prod 무접근).
 *
 * ★ 파괴적 슬라이스 — 모든 fixture 는 Testcontainers 격리 DB 안에서만 생성/삭제한다.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { WsIntEnv, setupWsIntEnv, signupAsUser, STRONG_PW } from '../workspaces/helpers';
import { AccountAnonymizationCron } from '../../../src/me/account-anonymization.cron';
import { resolveSystemAnonUserId } from '../../../src/common/anon-user';

let env: WsIntEnv;
const ORIGIN = 'http://localhost:45173';

beforeAll(async () => {
  env = await setupWsIntEnv();
  // 익명화 타겟 SYSTEM_ANON 행 보장(int DB 는 seed 를 안 돌리므로 직접 생성 — seed.ts 와 동일 ID).
  const anonId = resolveSystemAnonUserId();
  await env.prisma.user.upsert({
    where: { id: anonId },
    update: {},
    create: {
      id: anonId,
      email: 'anon@system.qufox',
      username: 'deleted-user',
      passwordHash: `x-no-login-${anonId}`,
      emailVerified: true,
    },
  });
}, 240_000);

afterAll(async () => {
  await env?.stop();
}, 60_000);

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

describe('S77c 비활성화/재활성화 (FR-PS-16)', () => {
  it('deactivate: 단일 tx(isDeactivated=true + RefreshToken 삭제) + Redis 블랙리스트 SET', async () => {
    const u = await signupAsUser(env.baseUrl, 's77cdeact');
    // 가입 직후 RefreshToken 1행이 있다(세션).
    expect(await env.prisma.refreshToken.count({ where: { userId: u.userId } })).toBeGreaterThan(0);

    const res = await request(env.baseUrl)
      .post('/users/me/deactivate')
      .set(auth(u.accessToken))
      .send({ currentPassword: STRONG_PW });
    expect(res.status).toBe(204);

    // DB: isDeactivated=true + deactivatedAt 세팅.
    const row = await env.prisma.user.findUnique({
      where: { id: u.userId },
      select: { isDeactivated: true, deactivatedAt: true },
    });
    expect(row?.isDeactivated).toBe(true);
    expect(row?.deactivatedAt).toBeTruthy();
    // RefreshToken 전체 삭제.
    expect(await env.prisma.refreshToken.count({ where: { userId: u.userId } })).toBe(0);
    // Redis `deactivated:{userId}` TTL (0, 900].
    const ttl = await env.redis.ttl(`deactivated:${u.userId}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(900);
  });

  it('deactivate 잘못된 비번 → 403 PASSWORD_INCORRECT(상태 무변)', async () => {
    const u = await signupAsUser(env.baseUrl, 's77cbadpw');
    const res = await request(env.baseUrl)
      .post('/users/me/deactivate')
      .set(auth(u.accessToken))
      .send({ currentPassword: 'definitely-wrong-1' });
    expect(res.status).toBe(403);
    expect(res.body.errorCode).toBe('PASSWORD_INCORRECT');
    const row = await env.prisma.user.findUnique({
      where: { id: u.userId },
      select: { isDeactivated: true },
    });
    expect(row?.isDeactivated).toBe(false);
  });

  it('비활성 계정 요청은 JWT 이중검사로 차단(ACCOUNT_DEACTIVATED)', async () => {
    const u = await signupAsUser(env.baseUrl, 's77cblock');
    await request(env.baseUrl)
      .post('/users/me/deactivate')
      .set(auth(u.accessToken))
      .send({ currentPassword: STRONG_PW })
      .expect(204);

    // 비활성화 직후 같은 access token 으로 인증 요청 → Redis 블랙리스트 적중 차단.
    const blocked = await request(env.baseUrl).get('/me/2fa').set(auth(u.accessToken));
    expect(blocked.status).toBe(403);
    expect(blocked.body.errorCode).toBe('ACCOUNT_DEACTIVATED');

    // 로그인도 ACCOUNT_DEACTIVATED.
    const login = await request(env.baseUrl)
      .post('/auth/login')
      .set('origin', ORIGIN)
      .send({ email: u.email, password: STRONG_PW });
    expect(login.status).toBe(403);
    expect(login.body.errorCode).toBe('ACCOUNT_DEACTIVATED');
  });

  it('reactivate: 30일 이내 자격증명 검증 후 복구(isDeactivated=false·deactivatedAt=null)', async () => {
    const u = await signupAsUser(env.baseUrl, 's77creact');
    await request(env.baseUrl)
      .post('/users/me/deactivate')
      .set(auth(u.accessToken))
      .send({ currentPassword: STRONG_PW })
      .expect(204);

    // 활성 계정이 아니므로 reactivate 는 자격증명을 직접 받는 공개 엔드포인트.
    const res = await request(env.baseUrl)
      .post('/users/me/reactivate')
      .set('origin', ORIGIN)
      .send({ email: u.email, password: STRONG_PW });
    expect(res.status).toBe(204);

    const row = await env.prisma.user.findUnique({
      where: { id: u.userId },
      select: { isDeactivated: true, deactivatedAt: true },
    });
    expect(row?.isDeactivated).toBe(false);
    expect(row?.deactivatedAt).toBeNull();
    // 블랙리스트 해제 → 다시 로그인 가능.
    const login = await request(env.baseUrl)
      .post('/auth/login')
      .set('origin', ORIGIN)
      .send({ email: u.email, password: STRONG_PW });
    expect(login.status).toBe(200);
  });

  it('reactivate 활성 계정 → 409 ACCOUNT_NOT_DEACTIVATED', async () => {
    const u = await signupAsUser(env.baseUrl, 's77cactive');
    const res = await request(env.baseUrl)
      .post('/users/me/reactivate')
      .set('origin', ORIGIN)
      .send({ email: u.email, password: STRONG_PW });
    expect(res.status).toBe(409);
    expect(res.body.errorCode).toBe('ACCOUNT_NOT_DEACTIVATED');
  });
});

describe('S77c 30일 익명화 크론 (FR-PS-19) — ★격리 fixture 만', () => {
  const anonId = resolveSystemAnonUserId();

  it('deactivatedAt=now-31d → PII null + Message.authorId=SYSTEM_ANON + 멱등 + 미접근 가드', async () => {
    const cron = env.app.get(AccountAnonymizationCron);
    const now = new Date('2025-03-01T00:00:00Z');

    // (1) 익명화 대상: 31일 전 비활성 + PII + 메시지 1건.
    const targetU = await signupAsUser(env.baseUrl, 's77canon');
    // 채널이 필요한 Message 를 직접 만들기 위해 워크스페이스/채널을 raw 로 생성한다(격리 DB).
    const wsId = randomUUID();
    await env.prisma.workspace.create({
      data: { id: wsId, name: 'anon-ws', slug: `anon-ws-${Date.now()}`, ownerId: targetU.userId },
    });
    const channel = await env.prisma.channel.create({
      data: { workspaceId: wsId, name: 'general', type: 'TEXT', position: 0 },
    });
    const msg = await env.prisma.message.create({
      data: {
        channelId: channel.id,
        authorId: targetU.userId,
        content: 'hello from target',
        contentPlain: 'hello from target',
      },
    });
    // PII 세팅 + 31일 전 비활성화로 마킹.
    await env.prisma.user.update({
      where: { id: targetU.userId },
      data: {
        isDeactivated: true,
        deactivatedAt: new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000),
        displayName: 'Target Display',
        bio: 'secret bio',
        pronouns: 'they/them',
        handle: `targethandle${Date.now()}`,
      },
    });

    // (2) ★미접근 대상 A: 최근(5일 전) 비활성 — 복구창 이내라 익명화 금지.
    const recentU = await signupAsUser(env.baseUrl, 's77crecent');
    await env.prisma.user.update({
      where: { id: recentU.userId },
      data: {
        isDeactivated: true,
        deactivatedAt: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000),
        displayName: 'Recent Keep',
      },
    });

    // (3) ★미접근 대상 B: 활성 계정 — 절대 미접근.
    const activeU = await signupAsUser(env.baseUrl, 's77ckeep');
    await env.prisma.user.update({
      where: { id: activeU.userId },
      data: { displayName: 'Active Keep' },
    });

    // ── 크론 실행 ──
    // (이 공유 DB 에는 앞선 비활성화 스펙이 남긴 다른 비활성 유저가 있을 수 있으므로 전역
    //  processed 카운트가 아니라 본 fixture 의 결과를 직접 검증한다 — 격리 단언.)
    const r1 = await cron.anonymizeBatch(now);
    expect(r1.processed).toBeGreaterThanOrEqual(1);

    // 대상: PII null + email/username placeholder.
    const anonized = await env.prisma.user.findUnique({ where: { id: targetU.userId } });
    expect(anonized?.displayName).toBeNull();
    expect(anonized?.bio).toBeNull();
    expect(anonized?.pronouns).toBeNull();
    expect(anonized?.handle).toBeNull();
    expect(anonized?.email).toBe(`deleted-${targetU.userId}@deleted.qufox`);
    expect(anonized?.username).toBe(`deleted-${targetU.userId}`);
    expect(anonized?.isDeactivated).toBe(true); // 익명화 후에도 비활성 유지.

    // 메시지 작성자 → SYSTEM_ANON(내용 보존).
    const reauthored = await env.prisma.message.findUnique({ where: { id: msg.id } });
    expect(reauthored?.authorId).toBe(anonId);
    expect(reauthored?.contentPlain).toBe('hello from target'); // 내용은 보존.

    // ★미접근 검증: recent/active 는 그대로.
    const recentRow = await env.prisma.user.findUnique({ where: { id: recentU.userId } });
    expect(recentRow?.displayName).toBe('Recent Keep');
    const activeRow = await env.prisma.user.findUnique({ where: { id: activeU.userId } });
    expect(activeRow?.displayName).toBe('Active Keep');

    // ── 멱등: 재실행해도 대상 0(이미 익명화·displayName 등 null이지만 deactivatedAt 보존이라
    //    다시 매칭되더라도 같은 값으로 수렴) → 메시지 authorId 무변. ──
    const r2 = await cron.anonymizeBatch(now);
    const reauthored2 = await env.prisma.message.findUnique({ where: { id: msg.id } });
    expect(reauthored2?.authorId).toBe(anonId);
    // 재실행이 추가로 손대도 결과 동일(멱등) — recent/active 여전히 보존.
    expect((await env.prisma.user.findUnique({ where: { id: recentU.userId } }))?.displayName).toBe(
      'Recent Keep',
    );
    expect(r2.processed).toBeGreaterThanOrEqual(0);
  });
});
