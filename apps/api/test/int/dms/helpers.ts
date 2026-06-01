/**
 * Integration test bootstrap for the Global DM surface (`/me/dms`).
 * Mirrors `apps/api/test/int/messages/helpers.ts` — testcontainer
 * postgres + redis, full AppModule — but seeds two friends instead
 * of a workspace + channel because Global DMs are workspace-free.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import type Redis from 'ioredis';
import cookieParser from 'cookie-parser';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import request from 'supertest';
import { AppModule } from '../../../src/app.module';
import { PrismaService } from '../../../src/prisma/prisma.module';
import { REDIS } from '../../../src/redis/redis.module';
import { OutboxDispatcher } from '../../../src/common/outbox/outbox.dispatcher';
import { S3Service } from '../../../src/storage/s3.service';

/**
 * S20 (FR-DM-06): in-memory S3Service stub for the DM int env. The group DM
 * icon upload path does a server-side `putObject` + `deleteObject`; without a
 * MinIO container we stub the storage SDK at the Nest DI layer (same surface
 * as the magic-bytes attachment/emoji int specs) so the upload/delete flow is
 * exercised end-to-end through HTTP while bytes land in memory. Magic-byte
 * validation runs in the service BEFORE putObject, so type/forgery rejection
 * is fully covered without real storage.
 */
export type FakeS3 = S3Service & {
  store: Map<string, { bytes: Uint8Array; contentType: string }>;
  putCalls: string[];
  deleteCalls: string[];
};

function makeFakeS3(): FakeS3 {
  const store = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const putCalls: string[] = [];
  const deleteCalls: string[] = [];
  return {
    store,
    putCalls,
    deleteCalls,
    putObject: async (key: string, bytes: Uint8Array, contentType: string) => {
      store.set(key, { bytes, contentType });
      putCalls.push(key);
    },
    deleteObject: async (key: string) => {
      store.delete(key);
      deleteCalls.push(key);
    },
    presignGet: async (key: string) => `http://stub/${key}`,
    presignPut: async () => 'http://stub',
    headObject: async () => null,
    getObjectRange: async () => null,
    presignPutTtl: 900,
    presignGetTtl: 1800,
  } as unknown as FakeS3;
}

export type DmIntEnv = {
  app: INestApplication;
  prisma: PrismaService;
  redis: Redis;
  dispatcher: OutboxDispatcher;
  s3: FakeS3;
  baseUrl: string;
  stop: () => Promise<void>;
};

export const STRONG_PW = 'Quanta-Beetle-Nebula-42!';
export const ORIGIN = 'http://localhost:45173';

export async function setupDmIntEnv(): Promise<DmIntEnv> {
  process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
  const redis: StartedTestContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .start();
  const pg: StartedTestContainer = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: 'qufox',
      POSTGRES_PASSWORD: 'qufox',
      POSTGRES_DB: 'qufox_dm_int',
    })
    .withExposedPorts(5432)
    .start();

  const databaseUrl = `postgresql://qufox:qufox@${pg.getHost()}:${pg.getMappedPort(5432)}/qufox_dm_int?schema=public`;
  process.env.DATABASE_URL = databaseUrl;
  process.env.REDIS_URL = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
  process.env.JWT_ACCESS_SECRET = 'integration-test-secret-at-least-32-characters';
  process.env.JWT_ISSUER = 'qufox';
  process.env.JWT_AUDIENCE = 'qufox-web';
  process.env.ACCESS_TOKEN_TTL = '900';
  process.env.REFRESH_TOKEN_TTL = '604800';
  process.env.CORS_ORIGINS = ORIGIN;
  process.env.NODE_ENV = 'test';
  process.env.ARGON2_MEMORY_KIB = '1024';
  process.env.ARGON2_TIME_COST = '1';
  process.env.ARGON2_PARALLELISM = '1';
  process.env.OUTBOX_DISPATCH_INTERVAL_MS = '10000';
  process.env.OUTBOX_BATCH_SIZE = '100';
  process.env.OUTBOX_MAX_ATTEMPTS = '10';
  process.env.WEB_URL = 'http://localhost:45173';
  process.env.INVITE_CODE_BYTES = '16';
  process.env.WORKSPACE_SOFT_DELETE_GRACE_DAYS = '30';
  process.env.MESSAGE_MAX_LENGTH = '4000';
  process.env.MESSAGE_RATE_USER_MAX = '10000';
  process.env.MESSAGE_RATE_CHANNEL_MAX = '10000';

  const apiRoot = path.resolve(__dirname, '../../..');
  execSync('pnpm exec prisma migrate deploy', {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  const fakeS3 = makeFakeS3();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    // S20 (FR-DM-06): override S3Service with the in-memory stub so the icon
    // upload/delete HTTP flow runs without a MinIO container.
    .overrideProvider(S3Service)
    .useValue(fakeS3)
    .compile();
  const app = moduleRef.createNestApplication();
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
  const dispatcher = app.get(OutboxDispatcher);
  dispatcher.pausePolling();

  return {
    app,
    prisma,
    redis: redisClient,
    dispatcher,
    s3: fakeS3,
    baseUrl,
    stop: async () => {
      await app.close();
      await redis.stop().catch(() => undefined);
      await pg.stop().catch(() => undefined);
    },
  };
}

export type Actor = {
  userId: string;
  email: string;
  username: string;
  accessToken: string;
};

export async function signup(baseUrl: string, prefix: string): Promise<Actor> {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 99999)}`;
  const email = `${prefix}-${stamp}@qufox.dev`;
  const username = `${prefix}${stamp}`;
  const res = await request(baseUrl)
    .post('/auth/signup')
    .set('origin', ORIGIN)
    .send({ email, username, password: STRONG_PW });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${res.text}`);
  return { userId: res.body.user.id, email, username, accessToken: res.body.accessToken };
}

/**
 * Friendship handshake — `me` requests `target` by username, `target`
 * accepts. Required because `createOrGetGlobal` rejects DMs between
 * non-friends with `FRIEND_NOT_FOUND` (per-task 033 spec).
 */
export async function makeFriends(
  baseUrl: string,
  me: Actor,
  target: Actor,
): Promise<{ friendshipId: string }> {
  const req = await request(baseUrl)
    .post('/me/friends/requests')
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${me.accessToken}`)
    .send({ username: target.username });
  if (req.status >= 400) throw new Error(`friend req: ${req.status} ${req.text}`);
  const friendshipId = (req.body.id ?? req.body.friendship?.id) as string;
  if (!friendshipId) throw new Error(`friend req missing id: ${JSON.stringify(req.body)}`);
  const acc = await request(baseUrl)
    .post(`/me/friends/${friendshipId}/accept`)
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${target.accessToken}`);
  if (acc.status >= 400) throw new Error(`friend accept: ${acc.status} ${acc.text}`);
  return { friendshipId };
}

export function bearer(token: string) {
  return { Authorization: `Bearer ${token}`, origin: ORIGIN } as const;
}
