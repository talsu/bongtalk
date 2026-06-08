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

// S66 (D13 / FR-W05a): signup 은 emailVerified=false 사용자를 만들고, 워크스페이스
// 생성 게이트가 그들을 403 EMAIL_NOT_VERIFIED 로 막는다. 기존 채널 int 스펙은 "가입한
// 사용자가 곧바로 워크스페이스 생성"을 전제하므로, signup 이 가입 직후 DB 에서
// emailVerified=true 로 마킹해 무회귀로 유지한다(S66 가 messages/channels 헬퍼 누락한 회귀 수정).
let helperPrisma: PrismaService | undefined;

// S11: monotonic per-process counter so seeded workspace slugs are unique
// even when the system clock is frozen via vi.setSystemTime.
let seedCounter = 0;

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
  // S66 (D13 / FR-W05a): signup 의 기본 emailVerified=true 마킹에 쓸 prisma 핸들 보관.
  helperPrisma = prisma;

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

export async function signup(
  baseUrl: string,
  prefix: string,
  // 기본 true — 기존 스펙 무회귀. 미인증 게이트 검증 스펙은 false 로 호출한다.
  markVerified = true,
): Promise<Actor> {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 99999)}`;
  const email = `${prefix}-${stamp}@qufox.dev`;
  const username = `${prefix}${stamp}`;
  const res = await request(baseUrl)
    .post('/auth/signup')
    .set('origin', ORIGIN)
    .send({ email, username, password: STRONG_PW });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${res.text}`);
  // S66 (D13 / FR-W05a): 가입 직후 emailVerified=true 로 마킹(기존 스펙 무회귀).
  if (markVerified && helperPrisma) {
    await helperPrisma.user.update({
      where: { id: res.body.user.id },
      data: { emailVerified: true },
    });
  }
  return { userId: res.body.user.id, email, username, accessToken: res.body.accessToken };
}

export async function seedWorkspaceWithRoles(baseUrl: string): Promise<{
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

  // S11: derive the slug from a process-unique counter + randomness rather
  // than Date.now() — `vi.setSystemTime` freezes the clock in these specs, so
  // a clock-derived slug collides (WORKSPACE_SLUG_TAKEN) when a single spec
  // file seeds more than one workspace.
  const slug = `chws-${(seedCounter++).toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  const ws = await request(baseUrl)
    .post('/workspaces')
    .set('origin', ORIGIN)
    .set('Authorization', `Bearer ${owner.accessToken}`)
    .send({ name: 'ChWs', slug });
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

  // S65 (D13 / FR-W01): 워크스페이스 생성이 #general 기본 채널을 자동 시드한다.
  // 이 채널 헬퍼를 쓰는 대다수 스펙은 "채널 0개에서 시작"을 가정하므로(정확한
  // 채널 수/등간격 position 단언), 시드 직후 자동 #general 을 soft-delete 해 종전
  // 토폴로지(빈 채널 목록)를 복원한다. FK(Workspace.defaultChannelId → Channel)는
  // ON DELETE SET NULL 이지만 soft-delete 는 행을 남기므로, 모든 채널 조회가
  // deletedAt IS NULL 로 필터하는 한 테스트에는 보이지 않는다.
  //
  // FR-CH-03 (065): #general 은 기본 채널(isDefault=true)이라 DELETE 라우트가 이제
  // DEFAULT_CHANNEL_PROTECTED(409)로 막는다 — 가드 도입 전엔 HTTP DELETE 로 지웠으나,
  // 이제 도메인 가드를 우회해 prisma 로 직접 isDefault 해제 + soft-delete + Workspace
  // .defaultChannelId 를 null 로 떨어뜨려 종전 토폴로지(빈 목록)를 그대로 복원한다.
  if (helperPrisma) {
    const general = await helperPrisma.channel.findFirst({
      where: { workspaceId, name: 'general', deletedAt: null },
      select: { id: true },
    });
    if (general) {
      await helperPrisma.workspace.update({
        where: { id: workspaceId },
        data: { defaultChannelId: null },
      });
      await helperPrisma.channel.update({
        where: { id: general.id },
        data: { deletedAt: new Date(), isDefault: false },
      });
    }
  }

  return { workspaceId, owner, admin, member, nonMember };
}

export function bearer(token: string) {
  return { Authorization: `Bearer ${token}` } as const;
}
