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
 * S86 (D16 / FR-MN-15) int spec — 실 Postgres + Redis(testcontainer). 전체 AppModule 을
 * 부팅해 JwtAuthGuard + Zod 검증 + DomainExceptionFilter(HTTP 상태)를 그대로 통과시킨다.
 *
 * 커버:
 *   - GET /push/vapid-public-key → .env 공개키 반환(인증 사용자).
 *   - POST /me/push/subscriptions upsert(endpoint 기준) → 같은 endpoint 재등록은 1행 유지.
 *   - DELETE /me/push/subscriptions → 해제(왕복 후 0행).
 *   - 잘못된 endpoint(비-URL) → 400 PUSH_SUBSCRIPTION_INVALID.
 *   - 미인증 요청 → 401.
 *
 * 실 web-push 전송은 호출하지 않는다(REST 등록/해제/조회만 — 전송은 큐/processor 경로).
 */
describe('S86 web push (int)', () => {
  let pg: StartedTestContainer;
  let redis: StartedTestContainer;
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
    // VAPID 공개키를 설정해 GET /push/vapid-public-key 가 비어있지 않은 키를 내려주는지 검증.
    process.env.VAPID_PUBLIC_KEY = 'BIntegrationTestPublicKeyBase64Url';
    process.env.VAPID_PRIVATE_KEY = 'IntegrationTestPrivateKeyBase64Url';
    process.env.VAPID_SUBJECT = 'mailto:int@qufox.dev';
    redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
    pg = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({
        POSTGRES_USER: 'qufox',
        POSTGRES_PASSWORD: 'qufox',
        POSTGRES_DB: 'qufox_s86_int',
      })
      .withExposedPorts(5432)
      .start();
    const url = `postgresql://qufox:qufox@${pg.getHost()}:${pg.getMappedPort(5432)}/qufox_s86_int?schema=public`;
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

  const sub = (endpoint: string) => ({
    endpoint,
    keys: { p256dh: 'pKeyBase64Url', auth: 'aKeyBase64Url' },
  });

  it('GET /push/vapid-public-key returns the configured public key', async () => {
    const { token } = await signup('vapid');
    const res = await request(baseUrl)
      .get('/push/vapid-public-key')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toEqual({ publicKey: 'BIntegrationTestPublicKeyBase64Url' });
  });

  it('GET /push/vapid-public-key without auth → 401', async () => {
    await request(baseUrl).get('/push/vapid-public-key').expect(401);
  });

  it('POST /me/push/subscriptions registers a subscription (204) and upserts by endpoint', async () => {
    const { token, userId } = await signup('subscribe');
    const endpoint = `https://fcm.googleapis.com/fcm/send/${userId}`;

    await request(baseUrl)
      .post('/me/push/subscriptions')
      .set('authorization', `Bearer ${token}`)
      .send(sub(endpoint))
      .expect(204);

    let rows = await prisma.pushSubscription.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint).toBe(endpoint);

    // 같은 endpoint 재등록(키 회전) → upsert 라 여전히 1행, 키 갱신.
    await request(baseUrl)
      .post('/me/push/subscriptions')
      .set('authorization', `Bearer ${token}`)
      .send({ endpoint, keys: { p256dh: 'newP', auth: 'newA' } })
      .expect(204);
    rows = await prisma.pushSubscription.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].p256dh).toBe('newP');
  });

  it('DELETE /me/push/subscriptions unsubscribes (round-trip → 0 rows)', async () => {
    const { token, userId } = await signup('unsub');
    const endpoint = `https://fcm.googleapis.com/fcm/send/unsub-${userId}`;
    await request(baseUrl)
      .post('/me/push/subscriptions')
      .set('authorization', `Bearer ${token}`)
      .send(sub(endpoint))
      .expect(204);
    expect(await prisma.pushSubscription.count({ where: { userId } })).toBe(1);

    await request(baseUrl)
      .delete('/me/push/subscriptions')
      .set('authorization', `Bearer ${token}`)
      .send({ endpoint })
      .expect(204);
    expect(await prisma.pushSubscription.count({ where: { userId } })).toBe(0);
  });

  it('POST with a non-URL endpoint → 400 PUSH_SUBSCRIPTION_INVALID', async () => {
    const { token } = await signup('badsub');
    const res = await request(baseUrl)
      .post('/me/push/subscriptions')
      .set('authorization', `Bearer ${token}`)
      .send({ endpoint: 'not-a-url', keys: { p256dh: 'p', auth: 'a' } })
      .expect(400);
    expect(res.body.errorCode).toBe('PUSH_SUBSCRIPTION_INVALID');
  });

  it('POST with a non-push-service (SSRF) endpoint → 400 (security MAJOR fix)', async () => {
    const { token } = await signup('ssrfsub');
    for (const endpoint of [
      'https://169.254.169.254/latest/meta-data',
      'https://qufox-redis-prod:6379/',
      'http://fcm.googleapis.com/fcm/send/x',
    ]) {
      const res = await request(baseUrl)
        .post('/me/push/subscriptions')
        .set('authorization', `Bearer ${token}`)
        .send(sub(endpoint))
        .expect(400);
      expect(res.body.errorCode).toBe('PUSH_SUBSCRIPTION_INVALID');
    }
  });

  it('POST without auth → 401', async () => {
    await request(baseUrl)
      .post('/me/push/subscriptions')
      .send(sub('https://fcm.googleapis.com/fcm/send/anon'))
      .expect(401);
  });
});
