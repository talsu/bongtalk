/**
 * Integration test bootstrap for messages. Reuses the channel fixture pattern
 * (Postgres + Redis testcontainer, owner/admin/member seeded) and extends it
 * with a TEXT channel and a dense message seeder.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { GenericContainer } from 'testcontainers';
import type Redis from 'ioredis';
import cookieParser from 'cookie-parser';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import request from 'supertest';
import { AppModule } from '../../../src/app.module';
import { PrismaService } from '../../../src/prisma/prisma.module';
import { REDIS } from '../../../src/redis/redis.module';
import { OutboxDispatcher } from '../../../src/common/outbox/outbox.dispatcher';

export type MsgIntEnv = {
  app: INestApplication;
  prisma: PrismaService;
  redis: Redis;
  dispatcher: OutboxDispatcher;
  baseUrl: string;
  stop: () => Promise<void>;
};

export const STRONG_PW = 'Quanta-Beetle-Nebula-42!';
export const ORIGIN = 'http://localhost:45173';

export async function setupMsgIntEnv(): Promise<MsgIntEnv> {
  process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
  const redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
  const pg = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: 'qufox',
      POSTGRES_PASSWORD: 'qufox',
      POSTGRES_DB: 'qufox_msg_int',
    })
    .withExposedPorts(5432)
    .start();

  const databaseUrl = `postgresql://qufox:qufox@${pg.getHost()}:${pg.getMappedPort(5432)}/qufox_msg_int?schema=public`;
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
  process.env.OUTBOX_BATCH_SIZE = '200';
  process.env.OUTBOX_MAX_ATTEMPTS = '10';
  process.env.WEB_URL = 'http://localhost:45173';
  process.env.INVITE_CODE_BYTES = '16';
  process.env.WORKSPACE_SOFT_DELETE_GRACE_DAYS = '30';
  process.env.MESSAGE_MAX_LENGTH = '4000';
  // Rate limits intentionally large so tests can burst-send; dedicated
  // rate-limit spec overrides via env mutations before hitting the endpoint.
  process.env.MESSAGE_RATE_USER_MAX = '10000';
  process.env.MESSAGE_RATE_CHANNEL_MAX = '10000';

  const apiRoot = path.resolve(__dirname, '../../..');
  execSync('pnpm exec prisma migrate deploy', {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
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

export type SeededStack = {
  workspaceId: string;
  channelId: string;
  owner: Actor;
  admin: Actor;
  member: Actor;
  nonMember: Actor;
};

export async function seedMessageStack(baseUrl: string): Promise<SeededStack> {
  const owner = await signup(baseUrl, 'mso');
  const admin = await signup(baseUrl, 'msa');
  const member = await signup(baseUrl, 'msm');
  const nonMember = await signup(baseUrl, 'msn');

  const ws = await request(baseUrl)
    .post('/workspaces')
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ name: 'MsgWs', slug: `msgws-${Date.now().toString(36)}` });
  if (ws.status !== 201) throw new Error(`ws create: ${ws.status} ${ws.text}`);
  const workspaceId = ws.body.id as string;

  const inv = await request(baseUrl)
    .post(`/workspaces/${workspaceId}/invites`)
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ maxUses: 10 });
  const code = inv.body.invite.code as string;

  for (const actor of [admin, member]) {
    await request(baseUrl)
      .post(`/invites/${code}/accept`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${actor.accessToken}`);
  }
  await request(baseUrl)
    .patch(`/workspaces/${workspaceId}/members/${admin.userId}/role`)
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ role: 'ADMIN' });

  const ch = await request(baseUrl)
    .post(`/workspaces/${workspaceId}/channels`)
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ name: `msg-ch-${Date.now().toString(36).slice(-6)}`, type: 'TEXT' });
  if (ch.status !== 201) throw new Error(`channel create: ${ch.status} ${ch.text}`);
  const channelId = ch.body.id as string;

  return { workspaceId, channelId, owner, admin, member, nonMember };
}

export function bearer(token: string) {
  return { Authorization: `Bearer ${token}` } as const;
}

/**
 * Insert N messages directly into the DB for pagination stress testing.
 * `clockSkew=true` forces 3-wide ties on createdAt so cursor tie-breaking
 * by id is actually exercised.
 */
export async function seedRawMessages(
  prisma: PrismaService,
  args: { channelId: string; authorId: string; count: number; clockSkew?: boolean },
): Promise<{ ids: string[] }> {
  // Anchor the base to the newest existing message in this channel + 1s so
  // multiple consecutive calls produce strictly newer rows than the previous
  // batch — essential for the "concurrent insert at head" pagination case.
  const latest = await prisma.message.findFirst({
    where: { channelId: args.channelId },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  const anchor = latest
    ? latest.createdAt.getTime() + 1000
    : new Date('2025-01-01T00:00:00.000Z').getTime();
  const rows: Array<{
    id: string;
    channelId: string;
    authorId: string;
    content: string;
    contentPlain: string;
    createdAt: Date;
  }> = [];
  const ids: string[] = [];
  for (let i = 0; i < args.count; i++) {
    // clockSkew: every third message shares the timestamp with its neighbours,
    // producing (createdAt, id) ties that the raw-SQL row comparison must
    // disambiguate via id DESC.
    const bucket = args.clockSkew ? Math.floor(i / 3) : i;
    const id = crypto.randomUUID();
    ids.push(id);
    rows.push({
      id,
      channelId: args.channelId,
      authorId: args.authorId,
      content: `seed #${i.toString().padStart(4, '0')}`,
      contentPlain: `seed #${i.toString().padStart(4, '0')}`,
      createdAt: new Date(anchor + bucket * 1000),
    });
  }
  await prisma.message.createMany({ data: rows });
  return { ids };
}
