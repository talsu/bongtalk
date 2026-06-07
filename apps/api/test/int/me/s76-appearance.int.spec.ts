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

/**
 * S76 (D14 / FR-PS-09·10) int spec — 실 Postgres + Redis(testcontainer). 전체 AppModule
 * 을 부팅해 JwtAuthGuard + Zod 검증 + DomainExceptionFilter(HTTP 상태)를 그대로 통과시킨다.
 *
 * 커버:
 *   - GET /me/settings/appearance 기본값(DARK/COZY/15/false · 행 미생성 폴백).
 *   - PATCH partial 자동 저장 + GET 반영, 행 미생성 사용자 create-if-not-exists.
 *   - 잘못된 chatFontSize(17) → 400, strict 비-화이트리스트 키 → 400.
 *   - GET/PATCH /me/settings/notifications 의 notifDesktop/notifMobile 확장.
 */
describe('S76 appearance + notif channels (int)', () => {
  let pg: StartedTestContainer;
  let redis: StartedTestContainer;
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
    redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
    pg = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({
        POSTGRES_USER: 'qufox',
        POSTGRES_PASSWORD: 'qufox',
        POSTGRES_DB: 'qufox_s76_int',
      })
      .withExposedPorts(5432)
      .start();
    const url = `postgresql://qufox:qufox@${pg.getHost()}:${pg.getMappedPort(5432)}/qufox_s76_int?schema=public`;
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
  async function signup(prefix: string): Promise<{ token: string; userId: string }> {
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
    return { token: res.body.accessToken, userId: res.body.user.id };
  }

  // ── 외관(FR-PS-09) ─────────────────────────────────────────────────────────

  it('GET /me/settings/appearance returns defaults when no row exists', async () => {
    const { token, userId } = await signup('appdef');
    const res = await request(baseUrl)
      .get('/me/settings/appearance')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toEqual({
      theme: 'DARK',
      density: 'COZY',
      chatFontSize: 15,
      clock24h: true, // F-B2: 기본 24시간제(회귀 방지)
      linkPreviewsEnabled: true, // S84c: 기본 ON
    });
    // 읽기만으로는 행을 만들지 않는다.
    const row = await prisma.userSettings.findUnique({ where: { userId } });
    expect(row).toBeNull();
  });

  it('PATCH partial creates the row (create-if-not-exists) and GET reflects it', async () => {
    const { token, userId } = await signup('appcreate');
    await request(baseUrl)
      .patch('/me/settings/appearance')
      .set('authorization', `Bearer ${token}`)
      .send({ theme: 'LIGHT', chatFontSize: 18 })
      .expect(200);
    const res = await request(baseUrl)
      .get('/me/settings/appearance')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toEqual({
      theme: 'LIGHT',
      density: 'COZY', // 미전달 — default 보존
      chatFontSize: 18,
      clock24h: true, // F-B2: 미전달 — default(24시간제) 보존
      linkPreviewsEnabled: true, // S84c: 미전달 — default 보존
    });
    const row = await prisma.userSettings.findUnique({ where: { userId } });
    expect(row).not.toBeNull();
  });

  it('PATCH merges with an existing row — only sent fields change', async () => {
    const { token } = await signup('appmerge');
    await request(baseUrl)
      .patch('/me/settings/appearance')
      .set('authorization', `Bearer ${token}`)
      .send({ density: 'COMPACT', clock24h: true })
      .expect(200);
    const res = await request(baseUrl)
      .patch('/me/settings/appearance')
      .set('authorization', `Bearer ${token}`)
      .send({ theme: 'SYSTEM' })
      .expect(200);
    expect(res.body).toEqual({
      theme: 'SYSTEM',
      density: 'COMPACT', // 보존
      chatFontSize: 15,
      clock24h: true, // 보존
      linkPreviewsEnabled: true, // S84c: 보존
    });
  });

  it('S84c (FR-RC19): round-trips linkPreviewsEnabled (default true → false)', async () => {
    const { token } = await signup('applinkprev');
    const def = await request(baseUrl)
      .get('/me/settings/appearance')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(def.body.linkPreviewsEnabled).toBe(true);
    const patched = await request(baseUrl)
      .patch('/me/settings/appearance')
      .set('authorization', `Bearer ${token}`)
      .send({ linkPreviewsEnabled: false })
      .expect(200);
    expect(patched.body.linkPreviewsEnabled).toBe(false);
    const got = await request(baseUrl)
      .get('/me/settings/appearance')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(got.body.linkPreviewsEnabled).toBe(false);
    expect(got.body.clock24h).toBe(true); // 다른 외관 필드 보존
  });

  it('rejects an off-step chatFontSize with 400', async () => {
    const { token } = await signup('appbadfs');
    await request(baseUrl)
      .patch('/me/settings/appearance')
      .set('authorization', `Bearer ${token}`)
      .send({ chatFontSize: 17 })
      .expect(400);
  });

  it('rejects unknown keys (strict) with 400', async () => {
    const { token } = await signup('appstrict');
    await request(baseUrl)
      .patch('/me/settings/appearance')
      .set('authorization', `Bearer ${token}`)
      .send({ theme: 'DARK', bogus: 1 })
      .expect(400);
  });

  // ── 알림 채널 토글(FR-PS-10) ─────────────────────────────────────────────────

  it('GET /me/settings/notifications includes notifDesktop/notifMobile (default true)', async () => {
    const { token } = await signup('notifdef');
    const res = await request(baseUrl)
      .get('/me/settings/notifications')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.notifDesktop).toBe(true);
    expect(res.body.notifMobile).toBe(true);
  });

  it('PATCH /me/settings/notifications toggles notifDesktop/notifMobile and persists', async () => {
    const { token } = await signup('notiftoggle');
    const patched = await request(baseUrl)
      .patch('/me/settings/notifications')
      .set('authorization', `Bearer ${token}`)
      .send({ notifDesktop: false, notifMobile: false })
      .expect(200);
    expect(patched.body.notifDesktop).toBe(false);
    expect(patched.body.notifMobile).toBe(false);
    // 알림 수준은 미전달 — 기본 MENTIONS 유지(무회귀).
    expect(patched.body.notifTrigger).toBe('MENTIONS');
    const res = await request(baseUrl)
      .get('/me/settings/notifications')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.notifDesktop).toBe(false);
    expect(res.body.notifMobile).toBe(false);
  });
});
