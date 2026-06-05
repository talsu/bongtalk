import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { AppModule } from '../../../src/app.module';
import { PrismaService } from '../../../src/prisma/prisma.module';
import { DirectMessagesService } from '../../../src/channels/direct-messages/direct-messages.service';

/**
 * S77a (D14 / FR-PS-12·13) int spec — 실 Postgres + Redis(testcontainer). 전체 AppModule 을
 * 부팅해 JwtAuthGuard + Zod 검증 + DomainExceptionFilter(HTTP 상태) + RateLimit 을 그대로 통과.
 *
 * 커버:
 *   - GET /me/settings/accessibility 기본값(false/false · 행 미생성 폴백) + PATCH partial upsert.
 *   - GET /me/settings/privacy 기본값(true/true/EVERYONE) + PATCH partial upsert + enum 검증.
 *   - 잘못된 값 400(strict 비-화이트리스트 키 · 잘못된 enum).
 *   - 프라이버시 게이트(죽은 컨트롤 금지):
 *       allowDmFromWorkspaceMembers=false → 워크스페이스 멤버발 DM 차단(403),
 *         true → 통과(워크스페이스 공통 멤버).
 *       allowFriendRequests NOBODY → 친구요청 403, MUTUAL_WORKSPACE 공통 ws 만,
 *         EVERYONE 허용.
 */
describe('S77a accessibility + privacy + gates (int)', () => {
  let pg: StartedTestContainer;
  let redis: StartedTestContainer;
  let app: INestApplication;
  let prisma: PrismaService;
  let dms: DirectMessagesService;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
    redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
    pg = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({
        POSTGRES_USER: 'qufox',
        POSTGRES_PASSWORD: 'qufox',
        POSTGRES_DB: 'qufox_s77a_int',
      })
      .withExposedPorts(5432)
      .start();
    const url = `postgresql://qufox:qufox@${pg.getHost()}:${pg.getMappedPort(5432)}/qufox_s77a_int?schema=public`;
    process.env.DATABASE_URL = url;
    process.env.REDIS_URL = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    process.env.JWT_ACCESS_SECRET = 'integration-test-secret-at-least-32-characters';
    process.env.JWT_ISSUER = 'qufox';
    process.env.JWT_AUDIENCE = 'qufox-web';
    process.env.ACCESS_TOKEN_TTL = '900';
    process.env.REFRESH_TOKEN_TTL = '604800';
    process.env.CORS_ORIGINS = 'http://localhost:45173';
    process.env.NODE_ENV = 'test';
    process.env.ARGON2_MEMORY_KIB = '1024';
    process.env.ARGON2_TIME_COST = '1';
    process.env.ARGON2_PARALLELISM = '1';

    const apiRoot = path.resolve(__dirname, '../../..');
    execSync('pnpm exec prisma migrate deploy', {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    app.useWebSocketAdapter(new IoAdapter(app));
    await app.listen(0);
    const addr = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
    prisma = app.get(PrismaService);
    dms = app.get(DirectMessagesService);
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await redis?.stop().catch(() => undefined);
    await pg?.stop().catch(() => undefined);
  });

  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  // S66: 가입 직후 emailVerified=true 로 마킹(기존 int 패턴 — 미적용 시 게이트 403).
  let n = 0;
  async function signup(
    prefix: string,
  ): Promise<{ token: string; userId: string; username: string }> {
    n += 1;
    const stamp = `${Date.now().toString(36)}${n}`;
    const email = `${prefix}-${stamp}@qufox.dev`;
    const username = `${prefix}${stamp}`.slice(0, 30);
    const res = await request(baseUrl)
      .post('/auth/signup')
      .set('origin', 'http://localhost:45173')
      .send({ email, username, password: 'Sup3rStr0ng!pw99' })
      .expect(201);
    await prisma.user.update({ where: { id: res.body.user.id }, data: { emailVerified: true } });
    return { token: res.body.accessToken, userId: res.body.user.id, username };
  }

  // 두 사용자를 같은 워크스페이스의 멤버로 만든다(공통 워크스페이스 게이트 검증용).
  async function makeSharedWorkspace(
    owner: { token: string },
    other: { userId: string },
  ): Promise<{ workspaceId: string }> {
    const ws = await request(baseUrl)
      .post('/workspaces')
      .set('authorization', `Bearer ${owner.token}`)
      .set('origin', 'http://localhost:45173')
      .send({ name: `WS ${n}`, slug: `ws-${Date.now().toString(36)}${n}` })
      .expect(201);
    const workspaceId = ws.body.id as string;
    await prisma.workspaceMember.create({
      data: { workspaceId, userId: other.userId, role: 'MEMBER' },
    });
    return { workspaceId };
  }

  // ── 접근성(FR-PS-12) ─────────────────────────────────────────────────────────

  it('GET /me/settings/accessibility returns defaults when no row exists', async () => {
    const { token, userId } = await signup('a11ydef');
    const res = await request(baseUrl)
      .get('/me/settings/accessibility')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toEqual({ reduceMotion: false, highContrast: false });
    const row = await prisma.userSettings.findUnique({ where: { userId } });
    expect(row).toBeNull(); // 읽기만으로는 행을 만들지 않는다.
  });

  it('PATCH accessibility partial creates the row and GET reflects it', async () => {
    const { token, userId } = await signup('a11ycreate');
    await request(baseUrl)
      .patch('/me/settings/accessibility')
      .set('authorization', `Bearer ${token}`)
      .send({ reduceMotion: true })
      .expect(200);
    const res = await request(baseUrl)
      .get('/me/settings/accessibility')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toEqual({ reduceMotion: true, highContrast: false });
    const row = await prisma.userSettings.findUnique({ where: { userId } });
    expect(row).not.toBeNull();
  });

  it('PATCH accessibility rejects unknown keys (strict) with 400', async () => {
    const { token } = await signup('a11ystrict');
    await request(baseUrl)
      .patch('/me/settings/accessibility')
      .set('authorization', `Bearer ${token}`)
      .send({ reduceMotion: true, bogus: 1 })
      .expect(400);
  });

  // ── 프라이버시(FR-PS-13) ─────────────────────────────────────────────────────

  it('GET /me/settings/privacy returns defaults when no row exists', async () => {
    const { token } = await signup('privdef');
    const res = await request(baseUrl)
      .get('/me/settings/privacy')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toEqual({
      allowDmFromWorkspaceMembers: true,
      messageRequestEnabled: true,
      allowFriendRequests: 'EVERYONE',
    });
  });

  it('PATCH privacy partial merges + persists (upsert)', async () => {
    const { token } = await signup('privmerge');
    await request(baseUrl)
      .patch('/me/settings/privacy')
      .set('authorization', `Bearer ${token}`)
      .send({ allowDmFromWorkspaceMembers: false })
      .expect(200);
    const res = await request(baseUrl)
      .patch('/me/settings/privacy')
      .set('authorization', `Bearer ${token}`)
      .send({ allowFriendRequests: 'NOBODY' })
      .expect(200);
    expect(res.body).toEqual({
      allowDmFromWorkspaceMembers: false, // 보존
      messageRequestEnabled: true, // default 보존
      allowFriendRequests: 'NOBODY',
    });
  });

  it('PATCH privacy rejects an invalid allowFriendRequests with 400', async () => {
    const { token } = await signup('privbadenum');
    await request(baseUrl)
      .patch('/me/settings/privacy')
      .set('authorization', `Bearer ${token}`)
      .send({ allowFriendRequests: 'WHATEVER' })
      .expect(400);
  });

  // ── 게이트: allowDmFromWorkspaceMembers (createOrGet.assertWorkspaceDmAllowed) ─
  //
  // 워크스페이스 스코프 DM 개시(DirectMessagesService.createOrGet)는 친구 게이트가 없는
  // 유일한 도달 가능 DM-create 경로다(전역 DM /me/dms 는 친구 게이트가 비-친구를 이미 차단).
  // 현재 HTTP 컨트롤러가 노출돼 있지 않아 게이트를 서비스 레이어에서 실 DB 로 검증한다
  // (REPORT 의 carryover — workspace DM-open HTTP 표면 노출 시 그대로 동작).

  it('allowDmFromWorkspaceMembers=true (default) → workspace member DM creation allowed', async () => {
    const owner = await signup('dmwsowner');
    const target = await signup('dmwstarget');
    const { workspaceId } = await makeSharedWorkspace(owner, target);
    // 기본 allowDmFromWorkspaceMembers=true → 신규 워크스페이스 DM 개시 허용.
    const res = await dms.createOrGet(workspaceId, owner.userId, target.userId);
    expect(res.created).toBe(true);
    expect(res.channelId).toBeTruthy();
  });

  it('allowDmFromWorkspaceMembers=false → workspace member DM creation blocked (DM_PRIVACY_RESTRICTED)', async () => {
    const owner = await signup('dmwsownerB');
    const target = await signup('dmwstargetB');
    const { workspaceId } = await makeSharedWorkspace(owner, target);
    // 대상이 워크스페이스 멤버발 DM 을 끈다 → 친구 아님 → 신규 DM 개시 차단.
    await request(baseUrl)
      .patch('/me/settings/privacy')
      .set('authorization', `Bearer ${target.token}`)
      .send({ allowDmFromWorkspaceMembers: false })
      .expect(200);
    await expect(dms.createOrGet(workspaceId, owner.userId, target.userId)).rejects.toMatchObject({
      code: 'DM_PRIVACY_RESTRICTED',
    });
  });

  it('allowDmFromWorkspaceMembers=false but ACCEPTED friends → DM creation still allowed', async () => {
    const owner = await signup('dmwsownerC');
    const target = await signup('dmwstargetC');
    const { workspaceId } = await makeSharedWorkspace(owner, target);
    await request(baseUrl)
      .patch('/me/settings/privacy')
      .set('authorization', `Bearer ${target.token}`)
      .send({ allowDmFromWorkspaceMembers: false })
      .expect(200);
    // 친구 관계 수립(차단 우선·친구 허용 정합).
    await prisma.friendship.create({
      data: { requesterId: owner.userId, addresseeId: target.userId, status: 'ACCEPTED' },
    });
    const res = await dms.createOrGet(workspaceId, owner.userId, target.userId);
    expect(res.created).toBe(true);
  });

  // ── 게이트: allowFriendRequests (requestByUsername) ──────────────────────────

  it('allowFriendRequests EVERYONE (default) → friend request allowed', async () => {
    const me = await signup('frEvMe');
    const target = await signup('frEvTgt');
    await request(baseUrl)
      .post('/me/friends/requests')
      .set('authorization', `Bearer ${me.token}`)
      .set('origin', 'http://localhost:45173')
      .send({ username: target.username })
      .expect(201);
  });

  it('allowFriendRequests NOBODY → friend request blocked (403)', async () => {
    const me = await signup('frNoMe');
    const target = await signup('frNoTgt');
    await request(baseUrl)
      .patch('/me/settings/privacy')
      .set('authorization', `Bearer ${target.token}`)
      .send({ allowFriendRequests: 'NOBODY' })
      .expect(200);
    const res = await request(baseUrl)
      .post('/me/friends/requests')
      .set('authorization', `Bearer ${me.token}`)
      .set('origin', 'http://localhost:45173')
      .send({ username: target.username });
    expect(res.status).toBe(403);
    expect(res.body.errorCode ?? res.body.code).toBe('FRIEND_REQUEST_BLOCKED');
  });

  it('allowFriendRequests MUTUAL_WORKSPACE → blocked without, allowed with a shared workspace', async () => {
    const me = await signup('frMwMe');
    const target = await signup('frMwTgt');
    await request(baseUrl)
      .patch('/me/settings/privacy')
      .set('authorization', `Bearer ${target.token}`)
      .send({ allowFriendRequests: 'MUTUAL_WORKSPACE' })
      .expect(200);
    // 공통 워크스페이스 없음 → 403.
    const blocked = await request(baseUrl)
      .post('/me/friends/requests')
      .set('authorization', `Bearer ${me.token}`)
      .set('origin', 'http://localhost:45173')
      .send({ username: target.username });
    expect(blocked.status).toBe(403);

    // 공통 워크스페이스 부여 → 허용.
    await makeSharedWorkspace(me, target);
    await request(baseUrl)
      .post('/me/friends/requests')
      .set('authorization', `Bearer ${me.token}`)
      .set('origin', 'http://localhost:45173')
      .send({ username: target.username })
      .expect(201);
  });
});
