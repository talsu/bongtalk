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
import { S3Service } from '../../../src/storage/s3.service';

/**
 * S73 (D14 / FR-PS-01·02·03) int spec — 실 Postgres + Redis(testcontainer) + S3Service
 * 스텁(MinIO 불필요 — 스토리지 SDK 는 S3Service 뒤로 격리). 전체 AppModule 을 부팅해
 * JwtAuthGuard + Zod 검증 + DomainExceptionFilter(HTTP 상태/details) 를 그대로 통과시킨다.
 *
 * 커버:
 *   - PATCH /me/profile 필드 갱신(displayName/bio/...) + GET 반영.
 *   - handle 변경 쿨다운 400 HANDLE_COOLDOWN_ACTIVE + details.nextAllowedAt.
 *   - handle 중복 409 HANDLE_TAKEN.
 *   - 아바타 presign → finalize → avatarUrl, DELETE 리셋.
 */
describe('S73 profile (int)', () => {
  let pg: StartedTestContainer;
  let redis: StartedTestContainer;
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;

  const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // 스텁 상태(케이스별 교체).
  const s3State = {
    headSize: 1024,
    headType: 'image/png' as string | undefined,
    bytes: PNG_MAGIC as Uint8Array | null,
    deleted: [] as string[],
  };
  const s3Stub = {
    presignPutTtl: 900,
    presignGetTtl: 1800,
    presignPut: async () => 'http://minio.local/put',
    // security HIGH#2: 아바타 presign 은 presignPost(content-length-range + eq Content-Type)로
    // 전환됐다. MinIO 미부팅 스텁이라 url/fields 만 모사한다(실 정책 강제는 MinIO e2e 범위).
    presignPost: async (key: string, contentType: string) => ({
      url: 'http://minio.local/post',
      fields: { key, 'Content-Type': contentType, policy: 'stub', 'x-amz-signature': 'stub' },
    }),
    presignGet: async (key: string) => `http://minio.local/get/${key}`,
    headObject: async () =>
      s3State.headSize < 0
        ? null
        : { contentLength: s3State.headSize, contentType: s3State.headType },
    getObjectRange: async () => s3State.bytes,
    deleteObject: async (key: string) => {
      s3State.deleted.push(key);
    },
  };

  beforeAll(async () => {
    process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
    redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
    pg = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({
        POSTGRES_USER: 'qufox',
        POSTGRES_PASSWORD: 'qufox',
        POSTGRES_DB: 'qufox_s73_int',
      })
      .withExposedPorts(5432)
      .start();
    const url = `postgresql://qufox:qufox@${pg.getHost()}:${pg.getMappedPort(5432)}/qufox_s73_int?schema=public`;
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

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(S3Service)
      .useValue(s3Stub)
      .compile();
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
    s3State.headSize = 1024;
    s3State.headType = 'image/png';
    s3State.bytes = PNG_MAGIC;
    s3State.deleted = [];
  });

  // S66: 가입 직후 emailVerified=true 로 마킹(기존 int 패턴). 반환: { token, userId }.
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

  it('GET /me/profile returns the view with handle ?? username fallback', async () => {
    const { token, userId } = await signup('view');
    // backfill 은 username 을 handle 로 복사하므로(형식 OK일 때) handle 이 채워진다.
    const res = await request(baseUrl)
      .get('/me/profile')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.id).toBe(userId);
    expect(typeof res.body.handle).toBe('string');
    expect(res.body.avatarUrl).toBeNull();
  });

  it('PATCH /me/profile updates fields and GET reflects them', async () => {
    const { token } = await signup('patch');
    await request(baseUrl)
      .patch('/me/profile')
      .set('authorization', `Bearer ${token}`)
      .send({ displayName: 'Alice', bio: '  hello  ', pronouns: 'they/them' })
      .expect(200);
    const res = await request(baseUrl)
      .get('/me/profile')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.displayName).toBe('Alice');
    expect(res.body.bio).toBe('hello'); // trimmed
    expect(res.body.pronouns).toBe('they/them');
  });

  it('rejects a bio over 190 chars with 400', async () => {
    const { token } = await signup('biolong');
    await request(baseUrl)
      .patch('/me/profile')
      .set('authorization', `Bearer ${token}`)
      .send({ bio: 'x'.repeat(191) })
      .expect(400);
  });

  it('lets a user with a ≥191-char bio save other fields without re-sending bio (no regression)', async () => {
    const { token, userId } = await signup('biokeep');
    // 기존 데이터: 300자 bio(앱 190 한도 초과 — 백필/이전 버전 잔재). DB 는 TEXT 라 저장됨.
    await prisma.user.update({ where: { id: userId }, data: { bio: 'x'.repeat(300) } });
    // bio 를 보내지 않고 displayName 만 저장 → 400 이 아니어야 한다(미변경 필드 스킵).
    await request(baseUrl)
      .patch('/me/profile')
      .set('authorization', `Bearer ${token}`)
      .send({ displayName: 'Keeps Bio' })
      .expect(200);
    const res = await request(baseUrl)
      .get('/me/profile')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.displayName).toBe('Keeps Bio');
    expect(res.body.bio).toBe('x'.repeat(300)); // 미변경 — 보존.
  });

  it('rejects a non-IANA timezone with 400', async () => {
    const { token } = await signup('tzbad');
    await request(baseUrl)
      .patch('/me/profile')
      .set('authorization', `Bearer ${token}`)
      .send({ timezone: 'not a zone' })
      .expect(400);
  });

  it('blocks a handle change within the 30-day cooldown (400 + nextAllowedAt)', async () => {
    const { token, userId } = await signup('cool');
    // 첫 변경 — 쿨다운 기록.
    await request(baseUrl)
      .patch('/me/profile')
      .set('authorization', `Bearer ${token}`)
      .send({ handle: `cool${userId.slice(0, 6)}a` })
      .expect(200);
    // 즉시 재변경 — 쿨다운 400.
    const res = await request(baseUrl)
      .patch('/me/profile')
      .set('authorization', `Bearer ${token}`)
      .send({ handle: `cool${userId.slice(0, 6)}b` })
      .expect(400);
    expect(res.body.errorCode).toBe('HANDLE_COOLDOWN_ACTIVE');
    expect(typeof res.body.details?.nextAllowedAt).toBe('string');
  });

  it('rejects a handle already taken by another user with 409', async () => {
    const a = await signup('taka');
    const b = await signup('takb');
    const target = `shared${Date.now().toString(36)}`.slice(0, 30);
    await request(baseUrl)
      .patch('/me/profile')
      .set('authorization', `Bearer ${a.token}`)
      .send({ handle: target })
      .expect(200);
    const res = await request(baseUrl)
      .patch('/me/profile')
      .set('authorization', `Bearer ${b.token}`)
      .send({ handle: target })
      .expect(409);
    expect(res.body.errorCode).toBe('HANDLE_TAKEN');
  });

  it('avatar presign → finalize → avatarUrl, then DELETE resets', async () => {
    const { token } = await signup('av');
    const presign = await request(baseUrl)
      .post('/me/avatar/presign')
      .set('authorization', `Bearer ${token}`)
      .send({ contentType: 'image/png', sizeBytes: 1024 })
      .expect(201);
    expect(presign.body.key).toMatch(/^avatars\//);
    // security HIGH#2: presigned POST(url + fields) — MinIO 가 업로드 시점에 정책 강제.
    expect(presign.body.url).toBe('http://minio.local/post');
    expect(presign.body.fields['Content-Type']).toBe('image/png');

    const fin = await request(baseUrl)
      .put('/me/avatar')
      .set('authorization', `Bearer ${token}`)
      .send({ key: presign.body.key })
      .expect(200);
    expect(fin.body.avatarUrl).toContain(presign.body.key);

    const after = await request(baseUrl)
      .get('/me/profile')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(after.body.avatarUrl).toContain(presign.body.key);

    await request(baseUrl).delete('/me/avatar').set('authorization', `Bearer ${token}`).expect(204);
    expect(s3State.deleted).toContain(presign.body.key);

    const reset = await request(baseUrl)
      .get('/me/profile')
      .set('authorization', `Bearer ${token}`)
      .expect(200);
    expect(reset.body.avatarUrl).toBeNull();
  });

  it('rejects an avatar presign with a disallowed mime (415)', async () => {
    const { token } = await signup('avbad');
    const res = await request(baseUrl)
      .post('/me/avatar/presign')
      .set('authorization', `Bearer ${token}`)
      .send({ contentType: 'image/gif', sizeBytes: 1024 })
      .expect(400); // Zod enum rejects gif before service → VALIDATION_FAILED(400)
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
  });

  it('rejects an avatar finalize with a foreign key prefix (403)', async () => {
    const { token } = await signup('avforeign');
    const res = await request(baseUrl)
      .put('/me/avatar')
      .set('authorization', `Bearer ${token}`)
      .send({ key: 'avatars/00000000-0000-0000-0000-000000000000/evil.png' })
      .expect(403);
    expect(res.body.errorCode).toBe('FORBIDDEN');
  });

  it('rejects a finalize key with a path traversal segment (400 — Zod regex) (HIGH#1)', async () => {
    const { token } = await signup('avtrav');
    const res = await request(baseUrl)
      .put('/me/avatar')
      .set('authorization', `Bearer ${token}`)
      .send({ key: 'avatars/u1/../u2/evil.png' })
      .expect(400);
    expect(res.body.errorCode).toBe('VALIDATION_FAILED');
  });

  it('rejects a finalize on magic-byte mismatch (422) + deletes the object', async () => {
    const { token } = await signup('avmagic');
    const presign = await request(baseUrl)
      .post('/me/avatar/presign')
      .set('authorization', `Bearer ${token}`)
      .send({ contentType: 'image/png', sizeBytes: 1024 })
      .expect(201);
    s3State.bytes = new Uint8Array([0x00, 0x01, 0x02, 0x03]); // not PNG
    const res = await request(baseUrl)
      .put('/me/avatar')
      .set('authorization', `Bearer ${token}`)
      .send({ key: presign.body.key })
      .expect(422);
    expect(res.body.errorCode).toBe('INVALID_MAGIC_BYTES');
    expect(s3State.deleted).toContain(presign.body.key);
  });
});
