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
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { AppModule } from '../../../src/app.module';
import { PrismaService } from '../../../src/prisma/prisma.module';
import { REDIS } from '../../../src/redis/redis.module';
import { OutboxDispatcher } from '../../../src/common/outbox/outbox.dispatcher';
import {
  MENTION_BROADCAST_QUEUE,
  type MentionBroadcastJobData,
} from '../../../src/queue/mention-broadcast-queue.constants';
import {
  MENTION_SCAN_QUEUE,
  type MentionScanJobData,
} from '../../../src/queue/mention-scan-queue.constants';

export type MsgIntEnv = {
  app: INestApplication;
  prisma: PrismaService;
  redis: Redis;
  dispatcher: OutboxDispatcher;
  /**
   * S88b: @role async fanout(mention-broadcast) BullMQ 큐 핸들. fanout 을 단언하는 스펙은
   * `waitForMentionBroadcastDrain` 으로 잡 처리 완료를 기다린 뒤 MentionRecord/outbox 를
   * 직접 조회한다(동기 send 와 비동기 워커가 분리됐으므로).
   */
  mentionBroadcastQueue: Queue<MentionBroadcastJobData>;
  /**
   * FR-MN-10 (066 / S93): 키워드 알림 스캔(mention-scan) BullMQ 큐 핸들. 키워드 스캔 스펙은
   * `waitForMentionScanDrain` 으로 잡 처리 완료를 기다린 뒤 MentionRecord(KEYWORD)/outbox 를
   * 직접 조회한다(mention-broadcast 와 동형).
   */
  mentionScanQueue: Queue<MentionScanJobData>;
  baseUrl: string;
  stop: () => Promise<void>;
};

/**
 * S88b: mention-broadcast 큐가 active+waiting+delayed 잡 0 이 될 때까지 폴링한다(워커 drain).
 * 동기 send 응답 후 @role fanout 이 워커에서 끝났음을 보장하려는 fanout 스펙이 호출한다.
 * 잡 카운트로 대기하므로(폴링 부수효과 무관) S88a/S88b 양 스펙이 공유한다.
 */
export async function waitForMentionBroadcastDrain(
  queue: Queue<MentionBroadcastJobData>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const counts = await queue.getJobCounts('active', 'waiting', 'delayed', 'paused');
    const pending =
      (counts.active ?? 0) + (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.paused ?? 0);
    if (pending === 0) return;
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for mention-broadcast drain (pending=${pending})`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * FR-MN-10 (066 / S93): mention-scan 큐가 active+waiting+delayed+paused 잡 0 이 될 때까지
 * 폴링한다(워커 drain · waitForMentionBroadcastDrain 미러). 동기 send 응답 후 키워드 스캔
 * 워커 처리 완료를 보장하려는 키워드 스펙이 호출한다.
 */
export async function waitForMentionScanDrain(
  queue: Queue<MentionScanJobData>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const counts = await queue.getJobCounts('active', 'waiting', 'delayed', 'paused');
    const pending =
      (counts.active ?? 0) + (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.paused ?? 0);
    if (pending === 0) return;
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for mention-scan drain (pending=${pending})`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

export const STRONG_PW = 'Quanta-Beetle-Nebula-42!';
export const ORIGIN = 'http://localhost:45173';

// S66 (D13 / FR-W05a): signup 은 emailVerified=false 사용자를 만들고, 워크스페이스
// 생성·진입·메시지 전송 게이트가 그들을 403 EMAIL_NOT_VERIFIED 로 막는다. 기존 메시지
// int 스펙은 "가입한 사용자가 곧바로 워크스페이스 생성/전송"을 전제하므로, signup 이
// 가입 직후 DB 에서 emailVerified=true 로 마킹해 기존 스펙을 무회귀로 유지한다(S66 가
// workspaces/realtime 헬퍼는 갱신했으나 messages 헬퍼를 누락한 회귀 수정).
let helperPrisma: PrismaService | undefined;

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
  const mentionBroadcastQueue = app.get<Queue<MentionBroadcastJobData>>(
    getQueueToken(MENTION_BROADCAST_QUEUE),
  );
  // FR-MN-10 (066 / S93): 키워드 스캔 큐 핸들(drain 대기 · stop 시 obliterate).
  const mentionScanQueue = app.get<Queue<MentionScanJobData>>(getQueueToken(MENTION_SCAN_QUEUE));
  dispatcher.pausePolling();
  // S66 (D13 / FR-W05a): signup 의 기본 emailVerified=true 마킹에 쓸 prisma 핸들을
  // 모듈 스코프에 보관한다(헬퍼가 호출부 시그니처를 바꾸지 않고 DB 를 만지게 함).
  helperPrisma = prisma;

  return {
    app,
    prisma,
    redis: redisClient,
    dispatcher,
    mentionBroadcastQueue,
    mentionScanQueue,
    baseUrl,
    stop: async () => {
      // S88b: testcontainer Redis 가 멈추기 전에 mention-broadcast 잡을 비우고(obliterate)
      // BullMQ Worker 를 graceful close 한다. 그러지 않으면 워커의 blocking poll 이 Redis
      // 종료 후 "Connection is closed" unhandled rejection 을 던져 전역 핸들러로 테스트가
      // 깨진다(S88a 스펙이 @role 잡을 enqueue 하지만 drain 안 하던 회귀). 순서가
      // 핵심이다: obliterate(잔여 잡 제거) → app.close()(WorkerHost onModuleDestroy →
      // worker.close 가 in-flight 완료 대기) → redis/pg container stop.
      await mentionBroadcastQueue.obliterate({ force: true }).catch(() => undefined);
      // FR-MN-10: 키워드 스캔 워커도 동일하게 잡 제거 후 graceful close(blocking poll 의
      // "Connection is closed" unhandled rejection 방지 · mention-broadcast 와 동형).
      await mentionScanQueue.obliterate({ force: true }).catch(() => undefined);
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
