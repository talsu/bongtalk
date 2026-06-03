import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaService, PrismaModule } from '../../../src/prisma/prisma.module';
import { OutboxService } from '../../../src/common/outbox/outbox.service';
import { MessagesService } from '../../../src/messages/messages.service';
import { UnfurlQueueService } from '../../../src/queue/unfurl-queue.service';
import { UNFURL_QUEUE, type UnfurlJobData } from '../../../src/queue/unfurl-queue.constants';
import { MESSAGE_EMBED_UPDATED_EVENT } from '../../../src/links/message-embed.mapper';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';

/**
 * S60 (D11 / FR-RC07/08/09 · FR-AM-13/15/16) int spec — 실 Postgres + 실 Redis.
 *
 * 검증(HTTP/외부 fetch 없이 도메인 경로만 — UnfurlProcessor 의 외부 HTTP 는 unit 에서 검증):
 *   (1) scheduleUnfurl → UNFURL_QUEUE 에 delayed-less job enqueue(jobId=messageId · 멱등)
 *   (2) MessageEmbed 직접 upsert → aggregateEmbeds 가 messageId 별 DTO 로 모은다
 *   (3) suppressEmbed → suppressedAt 표식 + message.embed.updated outbox 행 발행
 *   (4) aggregateEmbeds 가 suppressedAt IS NULL 만 노출
 *   (5) suppressEmbed 권한/경로 불일치 → MESSAGE_NOT_FOUND(중립 404)
 *   (6) Message hard-delete → MessageEmbed FK CASCADE 정리
 *
 * MessagesService 는 의존성이 많아 unfurl/embeds 경로만 쓰도록 최소 의존만 주입한다
 * (OutboxService + Prisma + UnfurlQueueService). 나머지 @Optional 의존은 미주입.
 */
describe('Link unfurl (int)', () => {
  let pg: StartedTestContainer;
  let redis: StartedTestContainer;
  let prisma: PrismaService;
  let messages: MessagesService;
  let queue: Queue<UnfurlJobData>;
  let bullConn: IORedis;
  let moduleClose: () => Promise<void>;

  const userId = randomUUID();
  const workspaceId = randomUUID();
  const channelId = randomUUID();
  let messageId: string;

  beforeAll(async () => {
    process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
    pg = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({
        POSTGRES_USER: 'qufox',
        POSTGRES_PASSWORD: 'qufox',
        POSTGRES_DB: 'qufox_link_unfurl',
      })
      .withExposedPorts(5432)
      .start();
    redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();

    const dbUrl = `postgresql://qufox:qufox@${pg.getHost()}:${pg.getMappedPort(5432)}/qufox_link_unfurl?schema=public`;
    const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    process.env.DATABASE_URL = dbUrl;
    process.env.REDIS_URL = redisUrl;
    const apiRoot = path.resolve(__dirname, '../../..');
    execSync('pnpm exec prisma migrate deploy', {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: 'pipe',
    });

    bullConn = new IORedis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });

    const mod = await Test.createTestingModule({
      imports: [
        PrismaModule,
        BullModule.forRoot({ connection: bullConn }),
        BullModule.registerQueue({ name: UNFURL_QUEUE }),
      ],
      providers: [OutboxService, UnfurlQueueService, MessagesService],
    }).compile();
    await mod.init();
    prisma = mod.get(PrismaService);
    messages = mod.get(MessagesService);
    queue = mod.get<Queue<UnfurlJobData>>(getQueueToken(UNFURL_QUEUE));
    moduleClose = async () => {
      await mod.close();
    };

    await prisma.user.create({
      data: {
        id: userId,
        email: `u-${userId}@t.test`,
        username: `u${userId.slice(0, 8)}`,
        passwordHash: 'x',
      },
    });
    await prisma.workspace.create({
      data: { id: workspaceId, name: 'WS', slug: `ws-${workspaceId.slice(0, 8)}`, ownerId: userId },
    });
    await prisma.channel.create({
      data: { id: channelId, workspaceId, name: 'general', type: 'TEXT', position: 0 },
    });
    const msg = await prisma.message.create({
      data: {
        channelId,
        authorId: userId,
        content: 'see https://example.com for details',
        contentPlain: 'see https://example.com for details',
      },
      select: { id: true },
    });
    messageId = msg.id;
  }, 180_000);

  afterAll(async () => {
    await queue?.close().catch(() => undefined);
    await moduleClose?.().catch(() => undefined);
    await bullConn?.quit().catch(() => undefined);
    await pg?.stop().catch(() => undefined);
    await redis?.stop().catch(() => undefined);
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await prisma.messageEmbed.deleteMany({ where: { messageId } });
    await prisma.outboxEvent.deleteMany({});
  });

  async function seedEmbed(over: Record<string, unknown> = {}): Promise<string> {
    const row = await prisma.messageEmbed.create({
      data: {
        messageId,
        url: 'https://example.com',
        normalizedUrl: 'https://example.com',
        cacheKey: `key-${randomUUID().replace(/-/g, '')}`.slice(0, 64),
        title: 'Example',
        description: 'Desc',
        siteName: 'Example',
        statusCode: 200,
        fetchedAt: new Date(),
        ...over,
      },
      select: { id: true },
    });
    return row.id;
  }

  it('(1) scheduleUnfurl enqueues an unfurl job (jobId=messageId)', async () => {
    messages.scheduleUnfurl({
      messageId,
      channelId,
      workspaceId,
      content: 'check https://example.com please',
    });
    // fire-and-forget — 잡 등재까지 약간 대기.
    await new Promise((r) => setTimeout(r, 200));
    const job = await queue.getJob(messageId);
    expect(job).toBeTruthy();
    expect(job?.data.urls).toEqual(['https://example.com']);
    expect(job?.data.channelId).toBe(channelId);
  });

  it('(1b) scheduleUnfurl with no URLs is a no-op (no job)', async () => {
    messages.scheduleUnfurl({ messageId, channelId, workspaceId, content: 'no links here' });
    await new Promise((r) => setTimeout(r, 200));
    const job = await queue.getJob(messageId);
    // BullMQ getJob 은 미존재 시 undefined 를 돌려준다(no job 등재됨).
    expect(job).toBeFalsy();
  });

  it('(2)(4) aggregateEmbeds returns non-suppressed DTOs with imageProxyUrl mapping', async () => {
    const withImage = await seedEmbed({ imageKey: 'link-embeds/x.png' });
    await seedEmbed({ imageKey: null });
    const suppressed = await seedEmbed({ suppressedAt: new Date(), suppressedBy: userId });
    const map = await messages.aggregateEmbeds([messageId]);
    const dtos = map.get(messageId) ?? [];
    // suppressed 는 제외 — 2개만.
    expect(dtos.length).toBe(2);
    expect(dtos.find((d) => d.id === suppressed)).toBeUndefined();
    const imgDto = dtos.find((d) => d.id === withImage);
    expect(imgDto?.imageProxyUrl).toBe(`/links/embed-image/${withImage}`);
    const noImg = dtos.find((d) => d.id !== withImage);
    expect(noImg?.imageProxyUrl).toBeNull();
  });

  it('(3)(4) suppressEmbed sets suppressedAt, emits outbox, and drops the card from aggregate', async () => {
    const target = await seedEmbed();
    const other = await seedEmbed();
    const result = await messages.suppressEmbed({
      channelId,
      msgId: messageId,
      embedId: target,
      actorId: userId,
    });
    // 남은 embed 는 other 1개.
    expect(result.embeds.length).toBe(1);
    expect(result.embeds[0].id).toBe(other);
    // DB suppressedAt 기록.
    const row = await prisma.messageEmbed.findUnique({ where: { id: target } });
    expect(row?.suppressedAt).not.toBeNull();
    expect(row?.suppressedBy).toBe(userId);
    // outbox 행 발행(message.embed.updated).
    const ev = await prisma.outboxEvent.findFirst({
      where: { eventType: MESSAGE_EMBED_UPDATED_EVENT },
    });
    expect(ev).toBeTruthy();
    // aggregate 에서도 제외.
    const map = await messages.aggregateEmbeds([messageId]);
    expect((map.get(messageId) ?? []).find((d) => d.id === target)).toBeUndefined();
  });

  it('(5) suppressEmbed on a path/channel mismatch → MESSAGE_NOT_FOUND (neutral 404)', async () => {
    const target = await seedEmbed();
    await expect(
      messages.suppressEmbed({
        channelId: randomUUID(),
        msgId: messageId,
        embedId: target,
        actorId: userId,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.MESSAGE_NOT_FOUND });
  });

  it('(6) hard-deleting the message cascades MessageEmbed rows (FK CASCADE)', async () => {
    // 격리: 임시 메시지 + embed 를 만들고 hard-delete 후 cascade 확인.
    const tmp = await prisma.message.create({
      data: {
        channelId,
        authorId: userId,
        content: 'tmp https://a.com',
        contentPlain: 'tmp https://a.com',
      },
      select: { id: true },
    });
    await prisma.messageEmbed.create({
      data: {
        messageId: tmp.id,
        url: 'https://a.com',
        normalizedUrl: 'https://a.com',
        cacheKey: 'k'.repeat(40),
        statusCode: 200,
        fetchedAt: new Date(),
      },
    });
    await prisma.message.delete({ where: { id: tmp.id } });
    const left = await prisma.messageEmbed.count({ where: { messageId: tmp.id } });
    expect(left).toBe(0);
  });
});
