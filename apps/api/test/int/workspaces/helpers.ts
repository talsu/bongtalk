/**
 * Integration test bootstrap for workspace module. One Testcontainers stack
 * (Postgres + Redis) shared across all specs in this folder via module-level
 * caching, mirroring the auth-int pattern in task-001.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { GenericContainer } from 'testcontainers';
import cookieParser from 'cookie-parser';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import type Redis from 'ioredis';
import { AppModule } from '../../../src/app.module';
import { PrismaService } from '../../../src/prisma/prisma.module';
import { REDIS } from '../../../src/redis/redis.module';

export type WsIntEnv = {
  app: INestApplication;
  prisma: PrismaService;
  redis: Redis;
  baseUrl: string;
  stop: () => Promise<void>;
};

export async function setupWsIntEnv(): Promise<WsIntEnv> {
  process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
  const redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
  const pg = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: 'qufox',
      POSTGRES_PASSWORD: 'qufox',
      POSTGRES_DB: 'qufox_ws_int',
    })
    .withExposedPorts(5432)
    .start();

  const databaseUrl = `postgresql://qufox:qufox@${pg.getHost()}:${pg.getMappedPort(5432)}/qufox_ws_int?schema=public`;
  process.env.DATABASE_URL = databaseUrl;
  process.env.REDIS_URL = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
  process.env.JWT_ACCESS_SECRET = 'integration-test-secret-at-least-32-characters';
  process.env.JWT_ISSUER = 'qufox';
  process.env.JWT_AUDIENCE = 'qufox-web';
  process.env.ACCESS_TOKEN_TTL = '900';
  process.env.REFRESH_TOKEN_TTL = '604800';
  process.env.CORS_ORIGINS = 'http://localhost:45173';
  process.env.NODE_ENV = 'test';
  // Minimum argon2 cost — keeps signup ×(several) under the 3-min budget.
  process.env.ARGON2_MEMORY_KIB = '1024';
  process.env.ARGON2_TIME_COST = '1';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.WEB_URL = 'http://localhost:45173';
  process.env.INVITE_CODE_BYTES = '16';
  process.env.WORKSPACE_SOFT_DELETE_GRACE_DAYS = '30';
  // S74 (FR-PS-04/06): presignGet/presignPost 는 순수 서명(네트워크 없음)이라 실제 MinIO
  // 없이도 동작한다. ws프로필/배너 presign + 멤버목록 아바타 URL 파생 int 검증을 위해
  // S3_ENDPOINT/credentials 를 주입한다(headObject/deleteObject 같은 네트워크 호출은 이
  // 폴더 int 가 사용하지 않는다 — 업로드 finalize 경로는 unit 이 mock S3 로 cover).
  process.env.S3_ENDPOINT = process.env.S3_ENDPOINT ?? 'http://minio.int.test:9000';
  process.env.S3_PUBLIC_ENDPOINT = process.env.S3_PUBLIC_ENDPOINT ?? 'http://minio.int.test:9000';
  process.env.S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID ?? 'inttestkey';
  process.env.S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY ?? 'inttestsecret';
  process.env.S3_BUCKET = process.env.S3_BUCKET ?? 'qufox-attachments';
  process.env.S3_REGION = process.env.S3_REGION ?? 'us-east-1';
  // S77b (D14 / FR-PS-15): TOTP 2FA 시크릿 암호화 키(AES-256-GCM · base64 32B). 테스트 전용
  // dev 키. 키 미설정 시 2FA 엔드포인트가 503 ENCRYPTION_UNAVAILABLE 로 응답하므로, 기본은
  // 설정해 두고 ENCRYPTION_UNAVAILABLE 검증 스펙만 일시적으로 키를 제거해 확인한다.
  process.env.APP_ENCRYPTION_KEY =
    process.env.APP_ENCRYPTION_KEY ??
    Buffer.from('int-test-totp-encryption-key-32!').toString('base64');

  const apiRoot = path.resolve(__dirname, '../../..');
  execSync('pnpm exec prisma migrate deploy', {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  // S72 (D13 / FR-W22): main.ts 와 동일하게 trust proxy=1 을 켜 X-Forwarded-For 의 첫 홉을
  // req.ip 로 복원한다 — IP soft-block int 테스트가 supertest 의 XFF 헤더로 클라이언트 IP 를
  // 제어해 차단 IP/비차단 IP 분기를 검증할 수 있게 한다(prod 토폴로지 = 단일 nginx 홉 = 1).
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.useWebSocketAdapter(new IoAdapter(app));
  await app.listen(0);
  const addr = app.getHttpServer().address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const prisma = app.get(PrismaService);
  const redisClient = app.get<Redis>(REDIS);
  // S66 (D13 / FR-W05a): signupAsUser 의 기본 emailVerified=true 마킹에 쓸 prisma 핸들을
  // 모듈 스코프에 보관한다(헬퍼가 18개 호출부 시그니처를 바꾸지 않고 DB 를 만지게 함).
  helperPrisma = prisma;

  return {
    app,
    prisma,
    redis: redisClient,
    baseUrl,
    stop: async () => {
      await app.close();
      await redis.stop().catch(() => undefined);
      await pg.stop().catch(() => undefined);
    },
  };
}

export const STRONG_PW = 'Quanta-Beetle-Nebula-42!';
const ORIGIN = 'http://localhost:45173';

// S66 (D13 / FR-W05a): signup 은 emailVerified=false 사용자를 만들고, 워크스페이스
// 진입(JOIN·ACCEPT)·메시지 전송 게이트가 그들을 403 EMAIL_NOT_VERIFIED 로 막는다.
// 기존 워크스페이스/메시지 int 스펙은 "가입한 사용자가 곧바로 진입/전송"을 전제하므로,
// signupAsUser 가 가입 직후 DB 에서 emailVerified=true 로 마킹해 기존 스펙을 무회귀로
// 유지한다(S62 cross-cutting DI 누락 교훈 — 게이트 추가가 의존 스펙을 깨지 않게). 미인증
// 게이트 자체를 검증하는 신규 스펙은 markVerified=false 로 호출한다.
let helperPrisma: PrismaService | undefined;

export async function signupAsUser(
  baseUrl: string,
  prefix: string,
  // 기본 true — 기존 스펙 무회귀. 미인증 게이트 검증 스펙은 false 로 호출한다.
  markVerified = true,
): Promise<{
  userId: string;
  email: string;
  username: string;
  accessToken: string;
  cookie: string;
}> {
  const request = (await import('supertest')).default;
  const stamp = `${Date.now()}${Math.floor(Math.random() * 99999)}`;
  const email = `${prefix}-${stamp}@qufox.dev`;
  const username = `${prefix}${stamp}`;
  const res = await request(baseUrl)
    .post('/auth/signup')
    .set('origin', ORIGIN)
    .send({ email, username, password: STRONG_PW })
    .expect(201);
  const setCookie = res.headers['set-cookie'];
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  const raw = list
    .map((c: string) => c.split(';')[0])
    .find((c: string) => c.startsWith('refresh_token='));
  // S66 (D13 / FR-W05a): 기본적으로 가입 직후 emailVerified=true 로 마킹(기존 스펙 무회귀).
  if (markVerified && helperPrisma) {
    await helperPrisma.user.update({
      where: { id: res.body.user.id },
      data: { emailVerified: true },
    });
  }
  return {
    userId: res.body.user.id,
    email,
    username,
    accessToken: res.body.accessToken,
    cookie: raw ?? '',
  };
}

export async function bearer(accessToken: string): Promise<{ Authorization: string }> {
  return { Authorization: `Bearer ${accessToken}` };
}
