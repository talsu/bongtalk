/**
 * Realtime integration test bootstrap — adds WS client helpers + multi-node
 * factory on top of the message-int testcontainer pattern.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { GenericContainer } from 'testcontainers';
import cookieParser from 'cookie-parser';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import request from 'supertest';
import { io as ioClient, type Socket } from 'socket.io-client';
import type Redis from 'ioredis';
import { AppModule } from '../../../src/app.module';
import { PrismaService } from '../../../src/prisma/prisma.module';
import { REDIS } from '../../../src/redis/redis.module';
import { OutboxDispatcher } from '../../../src/common/outbox/outbox.dispatcher';
import { RedisIoAdapter } from '../../../src/realtime/io-adapter';

export type RtIntEnv = {
  app: INestApplication;
  prisma: PrismaService;
  redis: Redis;
  dispatcher: OutboxDispatcher;
  baseUrl: string; // http://…
  wsUrl: string; // ws://…
  stop: () => Promise<void>;
  // Factory: add a SECOND app on the same DB/Redis so multi-node tests can
  // prove the Redis adapter actually forwards events.
  spawnSecondInstance: () => Promise<{
    app: INestApplication;
    wsUrl: string;
    stop: () => Promise<void>;
  }>;
};

export const STRONG_PW = 'Quanta-Beetle-Nebula-42!';
export const ORIGIN = 'http://localhost:45173';

export async function setupRtIntEnv(): Promise<RtIntEnv> {
  process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
  const redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
  const pg = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: 'qufox',
      POSTGRES_PASSWORD: 'qufox',
      POSTGRES_DB: 'qufox_rt_int',
    })
    .withExposedPorts(5432)
    .start();

  const databaseUrl = `postgresql://qufox:qufox@${pg.getHost()}:${pg.getMappedPort(5432)}/qufox_rt_int?schema=public`;
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
  process.env.WEB_URL = ORIGIN;
  process.env.INVITE_CODE_BYTES = '16';
  process.env.WORKSPACE_SOFT_DELETE_GRACE_DAYS = '30';
  process.env.MESSAGE_MAX_LENGTH = '4000';
  process.env.MESSAGE_RATE_USER_MAX = '10000';
  process.env.MESSAGE_RATE_CHANNEL_MAX = '10000';
  process.env.WS_REPLAY_BUFFER_SIZE = '1000';
  process.env.PRESENCE_SESSION_TTL_SEC = '120';
  process.env.PRESENCE_UPDATE_THROTTLE_MS = '200'; // speed tests up
  process.env.WS_HEARTBEAT_INTERVAL_MS = '500';

  const apiRoot = path.resolve(__dirname, '../../..');
  execSync('pnpm exec prisma migrate deploy', {
    cwd: apiRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  const app = await buildApp();
  const baseUrl = await listen(app);
  const prisma = app.get(PrismaService);
  const redisClient = app.get<Redis>(REDIS);
  const dispatcher = app.get(OutboxDispatcher);
  dispatcher.pausePolling();

  // For the secondary instance factory.
  const children: Array<{ stop: () => Promise<void> }> = [];
  async function spawnSecondInstance() {
    const app2 = await buildApp();
    const url = await listen(app2);
    const entry = {
      app: app2,
      wsUrl: url.replace('http://', 'ws://'),
      stop: async () => app2.close(),
    };
    children.push(entry);
    return entry;
  }

  return {
    app,
    prisma,
    redis: redisClient,
    dispatcher,
    baseUrl,
    wsUrl: baseUrl.replace('http://', 'ws://'),
    spawnSecondInstance,
    stop: async () => {
      for (const c of children) await c.stop().catch(() => undefined);
      await app.close();
      await redis.stop().catch(() => undefined);
      await pg.stop().catch(() => undefined);
    },
  };
}

async function buildApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  const io = new RedisIoAdapter(app);
  await io.connectToRedis();
  app.useWebSocketAdapter(io);
  await app.init();
  return app;
}

async function listen(app: INestApplication): Promise<string> {
  await app.listen(0);
  const addr = app.getHttpServer().address() as { port: number };
  return `http://127.0.0.1:${addr.port}`;
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

export async function seedRtStack(baseUrl: string): Promise<{
  workspaceId: string;
  channelId: string;
  owner: Actor;
  admin: Actor;
  member: Actor;
  nonMember: Actor;
}> {
  const owner = await signup(baseUrl, 'rto');
  const admin = await signup(baseUrl, 'rta');
  const member = await signup(baseUrl, 'rtm');
  const nonMember = await signup(baseUrl, 'rtn');

  const ws = await request(baseUrl)
    .post('/workspaces')
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ name: 'RtWs', slug: `rtws-${Date.now().toString(36)}` });
  if (ws.status !== 201) throw new Error(`ws: ${ws.status} ${ws.text}`);
  const workspaceId = ws.body.id as string;

  const inv = await request(baseUrl)
    .post(`/workspaces/${workspaceId}/invites`)
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ maxUses: 10 });
  const code = inv.body.invite.code as string;
  for (const a of [admin, member]) {
    await request(baseUrl)
      .post(`/invites/${code}/accept`)
      .set('origin', ORIGIN)
      .set('Authorization', `Bearer ${a.accessToken}`);
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
    .send({ name: `rt-${Date.now().toString(36).slice(-6)}`, type: 'TEXT' });
  if (ch.status !== 201) throw new Error(`channel: ${ch.status} ${ch.text}`);

  return { workspaceId, channelId: ch.body.id, owner, admin, member, nonMember };
}

/** Connect a WS client with JWT in the handshake. Rejects on connect_error. */
export function connectClient(
  wsUrl: string,
  accessToken: string,
  opts?: { lastEventId?: string },
): Promise<Socket> {
  const socket = ioClient(wsUrl, {
    auth: { accessToken, ...(opts?.lastEventId ? { lastEventId: opts.lastEventId } : {}) },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  return new Promise((resolve, reject) => {
    const fail = (err: unknown) => reject(err instanceof Error ? err : new Error(String(err)));
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', fail);
  });
}

/** Wait for a named event or time out. */
export function waitForEvent<T = unknown>(
  socket: Socket,
  eventName: string,
  timeoutMs = 2000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      socket.off(eventName, onEv);
      reject(new Error(`timeout waiting for ${eventName}`));
    }, timeoutMs);
    function onEv(arg: T): void {
      clearTimeout(t);
      socket.off(eventName, onEv);
      resolve(arg);
    }
    socket.on(eventName, onEv);
  });
}

/** Collect every emission of a named event for a fixed window. */
export function collectEvents<T = unknown>(
  socket: Socket,
  eventName: string,
  windowMs: number,
): Promise<T[]> {
  return new Promise((resolve) => {
    const out: T[] = [];
    const handler = (e: T): void => {
      out.push(e);
    };
    socket.on(eventName, handler);
    setTimeout(() => {
      socket.off(eventName, handler);
      resolve(out);
    }, windowMs);
  });
}

export function bearer(t: string): { Authorization: string } {
  return { Authorization: `Bearer ${t}` } as const;
}
