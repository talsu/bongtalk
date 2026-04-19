/**
 * Shared integration test bootstrap for channels. Mirrors the workspace
 * helpers but exposes a seed that returns owner + admin + member tokens + a
 * workspace id — the common baseline for channel-centric cases.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { GenericContainer } from 'testcontainers';
import cookieParser from 'cookie-parser';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import request from 'supertest';
import { AppModule } from '../../../src/app.module';
import { PrismaService } from '../../../src/prisma/prisma.module';
import { OutboxDispatcher } from '../../../src/common/outbox/outbox.dispatcher';

export type ChIntEnv = {
  app: INestApplication;
  prisma: PrismaService;
  dispatcher: OutboxDispatcher;
  baseUrl: string;
  stop: () => Promise<void>;
};

export const STRONG_PW = 'Quanta-Beetle-Nebula-42!';
export const ORIGIN = 'http://localhost:45173';

export async function setupChIntEnv(): Promise<ChIntEnv> {
  process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
  const redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
  const pg = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_USER: 'qufox',
      POSTGRES_PASSWORD: 'qufox',
      POSTGRES_DB: 'qufox_ch_int',
    })
    .withExposedPorts(5432)
    .start();

  const databaseUrl = `postgresql://qufox:qufox@${pg.getHost()}:${pg.getMappedPort(5432)}/qufox_ch_int?schema=public`;
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
  process.env.OUTBOX_BATCH_SIZE = '50';
  process.env.OUTBOX_MAX_ATTEMPTS = '10';
  process.env.WEB_URL = 'http://localhost:45173';
  process.env.INVITE_CODE_BYTES = '16';
  process.env.WORKSPACE_SOFT_DELETE_GRACE_DAYS = '30';

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
  const dispatcher = app.get(OutboxDispatcher);
  dispatcher.pausePolling();

  return {
    app,
    prisma,
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

export async function seedWorkspaceWithRoles(
  baseUrl: string,
): Promise<{
  workspaceId: string;
  owner: Actor;
  admin: Actor;
  member: Actor;
  nonMember: Actor;
}> {
  const owner = await signup(baseUrl, 'cho');
  const admin = await signup(baseUrl, 'cha');
  const member = await signup(baseUrl, 'chm');
  const nonMember = await signup(baseUrl, 'chn');

  const ws = await request(baseUrl)
    .post('/workspaces')
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ name: 'ChWs', slug: `chws-${Date.now().toString(36)}` });
  if (ws.status !== 201) throw new Error(`ws create failed: ${ws.status} ${ws.text}`);
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

  return { workspaceId, owner, admin, member, nonMember };
}

export function bearer(token: string) {
  return { Authorization: `Bearer ${token}` } as const;
}
