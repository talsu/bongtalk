import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WS_EVENTS } from '@qufox/shared-types';
import { PrismaService, PrismaModule } from '../../../src/prisma/prisma.module';
import { SavedService } from '../../../src/me/saved/saved.service';
import { ReminderQueueService } from '../../../src/queue/reminder-queue.service';
import { ReminderProcessor } from '../../../src/queue/reminder.processor';
import { REMINDER_QUEUE, type ReminderJobData } from '../../../src/queue/reminder-queue.constants';
import { RealtimeGateway } from '../../../src/realtime/realtime.gateway';
import { MetricsService } from '../../../src/observability/metrics/metrics.service';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';

/**
 * S53 (D10 / FR-PS-09/10/11) int spec — 실 Postgres + 실 Redis testcontainer.
 *
 * 검증(실타이머 — BullMQ 실 워커와 충돌하므로 fake timer 미사용):
 *   (1) 리마인더 설정 → BullMQ delayed job enqueue
 *   (2) 발화 → reminderFiredAt 기록 + WS emit(emitToUserRoom spy)
 *   (3) 중복 enqueue dedup(jobId=savedMessageId — 잡 1개만)
 *   (4) snooze → 취소 + 재enqueue(snoozedUntil/reminderFiredAt 재설정)
 *   (5) unsave / status→COMPLETED → 잡 cancel
 *   (6) reminderFiredAt 이 이미 있으면 발화 skip(중복 발화 방지)
 *   (7) 오프라인(소켓 없음) → emit no-op, DB reminderFiredAt 은 기록
 *
 * RealtimeGateway 는 stub(emitToUserRoom 캡처)으로 주입한다 — 소켓 서버를 띄우지
 * 않고 발화 emit 만 관찰한다. BullMQ 전용 IORedis 연결은 afterAll 에서 close 한다.
 */
describe('Saved reminders (int)', () => {
  let pg: StartedTestContainer;
  let redis: StartedTestContainer;
  let prisma: PrismaService;
  let saved: SavedService;
  let queueSvc: ReminderQueueService;
  let queue: Queue<ReminderJobData>;
  let bullConn: IORedis;
  // emitToUserRoom 캡처: { userId, event, payload }.
  let emitted: Array<{ userId: string; event: string; payload: unknown }>;
  let moduleClose: () => Promise<void>;

  // 시드 식별자.
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const workspaceId = randomUUID();
  const channelId = randomUUID();
  let messageId: string;

  beforeAll(async () => {
    process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
    pg = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({
        POSTGRES_USER: 'qufox',
        POSTGRES_PASSWORD: 'qufox',
        POSTGRES_DB: 'qufox_saved_reminder',
      })
      .withExposedPorts(5432)
      .start();
    redis = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();

    const dbUrl = `postgresql://qufox:qufox@${pg.getHost()}:${pg.getMappedPort(5432)}/qufox_saved_reminder?schema=public`;
    const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;
    process.env.DATABASE_URL = dbUrl;
    process.env.REDIS_URL = redisUrl;
    const apiRoot = path.resolve(__dirname, '../../..');
    execSync('pnpm exec prisma migrate deploy', {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: 'pipe',
    });

    emitted = [];
    const gatewayStub = {
      emitToUserRoom: (uid: string, event: string, payload: unknown) => {
        emitted.push({ userId: uid, event, payload });
      },
    };

    // BullMQ 전용 IORedis 연결(maxRetriesPerRequest:null — blocking 명령 호환).
    bullConn = new IORedis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });

    const mod = await Test.createTestingModule({
      imports: [
        PrismaModule,
        BullModule.forRoot({ connection: bullConn }),
        BullModule.registerQueue({ name: REMINDER_QUEUE }),
      ],
      providers: [
        SavedService,
        ReminderQueueService,
        ReminderProcessor,
        { provide: RealtimeGateway, useValue: gatewayStub },
        { provide: MetricsService, useValue: undefined },
      ],
    }).compile();
    await mod.init();
    prisma = mod.get(PrismaService);
    saved = mod.get(SavedService);
    queueSvc = mod.get(ReminderQueueService);
    queue = mod.get<Queue<ReminderJobData>>(getQueueToken(REMINDER_QUEUE));
    moduleClose = async () => {
      await mod.close();
    };

    // 시드: user(s) + workspace + channel + message + savedMessage.
    await prisma.user.create({
      data: {
        id: userId,
        email: `u-${userId}@t.test`,
        username: `u${userId.slice(0, 8)}`,
        passwordHash: 'x',
      },
    });
    await prisma.user.create({
      data: {
        id: otherUserId,
        email: `u-${otherUserId}@t.test`,
        username: `u${otherUserId.slice(0, 8)}`,
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
        content: '리마인더 대상 메시지',
        contentPlain: '리마인더 대상 메시지',
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

  // 각 테스트는 자체 savedMessage 행 + 큐 비움으로 격리한다.
  beforeEach(async () => {
    emitted.length = 0;
    await queue.drain(true).catch(() => undefined);
    await queue.obliterate({ force: true }).catch(() => undefined);
    await prisma.savedMessage.deleteMany({ where: { messageId } });
  });

  async function seedSaved(overrides: Record<string, unknown> = {}): Promise<string> {
    const row = await prisma.savedMessage.create({
      data: { userId, messageId, ...overrides },
      select: { id: true },
    });
    return row.id;
  }

  async function waitFor(pred: () => Promise<boolean> | boolean, timeoutMs = 8000): Promise<void> {
    const start = Date.now();
    for (;;) {
      if (await pred()) return;
      if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it('(1) 리마인더 설정 시 delayed job 이 enqueue 된다 (jobId=savedMessageId)', async () => {
    const savedId = await seedSaved();
    const reminderAt = new Date(Date.now() + 60_000);
    await queueSvc.schedule({ savedMessageId: savedId, userId, reminderAt });
    const job = await queue.getJob(savedId);
    expect(job).toBeDefined();
    expect(job?.id).toBe(savedId);
    expect(job?.data.savedMessageId).toBe(savedId);
    // delayed 상태(아직 발화 안 됨).
    const delayed = await queue.getDelayedCount();
    expect(delayed).toBeGreaterThanOrEqual(1);
  });

  it('(2) 발화 시 reminderFiredAt 기록 + user:reminder_fire / user:saved_updated emit', async () => {
    const savedId = await seedSaved();
    // 극소 delay(즉시 발화).
    await queueSvc.schedule({
      savedMessageId: savedId,
      userId,
      reminderAt: new Date(Date.now() + 10),
    });
    await waitFor(async () => {
      const row = await prisma.savedMessage.findUnique({
        where: { id: savedId },
        select: { reminderFiredAt: true },
      });
      return row?.reminderFiredAt != null;
    });
    const row = await prisma.savedMessage.findUnique({
      where: { id: savedId },
      select: { reminderFiredAt: true, snoozedUntil: true },
    });
    expect(row?.reminderFiredAt).not.toBeNull();
    expect(row?.snoozedUntil).toBeNull();
    // WS emit: 두 이벤트 모두 user 룸으로.
    const fire = emitted.find((e) => e.event === WS_EVENTS.REMINDER_FIRE);
    const upd = emitted.find((e) => e.event === WS_EVENTS.SAVED_UPDATED);
    expect(fire?.userId).toBe(userId);
    expect(upd?.userId).toBe(userId);
    expect((fire?.payload as { savedMessageId: string }).savedMessageId).toBe(savedId);
    expect((fire?.payload as { messagePreview: string }).messagePreview).toContain('리마인더 대상');
  });

  it('(3) 같은 항목에 두 번 설정해도 잡은 1개만 (jobId dedup)', async () => {
    const savedId = await seedSaved();
    await queueSvc.schedule({
      savedMessageId: savedId,
      userId,
      reminderAt: new Date(Date.now() + 60_000),
    });
    await queueSvc.schedule({
      savedMessageId: savedId,
      userId,
      reminderAt: new Date(Date.now() + 90_000),
    });
    const counts = await queue.getJobCounts('delayed', 'waiting', 'active');
    const total = (counts.delayed ?? 0) + (counts.waiting ?? 0) + (counts.active ?? 0);
    expect(total).toBe(1);
    const job = await queue.getJob(savedId);
    expect(job).toBeDefined();
  });

  it('(4) snooze → 취소 후 재enqueue (snoozedUntil/reminderFiredAt 재설정)', async () => {
    // 이미 발화된 상태에서 스누즈한다고 가정(reminderFiredAt 채워둠).
    const past = new Date(Date.now() - 1000);
    const savedId = await seedSaved({ reminderAt: past, reminderFiredAt: past });
    const dto = await saved.snooze(userId, savedId, 10);
    expect(dto.snoozedUntil).not.toBeNull();
    expect(dto.reminderAt).not.toBeNull();
    // reminderFiredAt 은 재예약으로 클리어된다.
    const row = await prisma.savedMessage.findUnique({
      where: { id: savedId },
      select: { reminderFiredAt: true, snoozedUntil: true, reminderAt: true },
    });
    expect(row?.reminderFiredAt).toBeNull();
    expect(row?.snoozedUntil).not.toBeNull();
    // 잡이 재등록됐다.
    const job = await queue.getJob(savedId);
    expect(job).toBeDefined();
  });

  it('(5a) unsave → 예약 잡이 취소된다', async () => {
    const savedId = await seedSaved({ reminderAt: new Date(Date.now() + 60_000) });
    await queueSvc.schedule({
      savedMessageId: savedId,
      userId,
      reminderAt: new Date(Date.now() + 60_000),
    });
    expect(await queue.getJob(savedId)).toBeDefined();
    await saved.unsave(userId, messageId);
    expect(await queue.getJob(savedId)).toBeUndefined();
  });

  it('(5b) status→COMPLETED → 예약 잡이 취소되고 reminderAt 클리어', async () => {
    const savedId = await seedSaved({ reminderAt: new Date(Date.now() + 60_000) });
    await queueSvc.schedule({
      savedMessageId: savedId,
      userId,
      reminderAt: new Date(Date.now() + 60_000),
    });
    expect(await queue.getJob(savedId)).toBeDefined();
    const dto = await saved.update(userId, savedId, { status: 'COMPLETED' });
    expect(dto.status).toBe('COMPLETED');
    expect(dto.reminderAt).toBeNull();
    expect(await queue.getJob(savedId)).toBeUndefined();
  });

  it('(6) reminderFiredAt 이 이미 있으면 발화 skip (중복 발화 방지)', async () => {
    const already = new Date(Date.now() - 1000);
    const savedId = await seedSaved({ reminderAt: already, reminderFiredAt: already });
    // 잡을 즉시 발화 큐잉(이미 발화된 행).
    await queueSvc.schedule({
      savedMessageId: savedId,
      userId,
      reminderAt: new Date(Date.now() + 10),
    });
    // 잡이 처리(완료)될 때까지 대기.
    await waitFor(async () => {
      const job = await queue.getJob(savedId);
      return !job || (await job.isCompleted());
    });
    // emit 이 일어나지 않았다(skip).
    expect(emitted.find((e) => e.event === WS_EVENTS.REMINDER_FIRE)).toBeUndefined();
    // reminderFiredAt 은 기존 값 그대로(now 로 덮어쓰지 않음).
    const row = await prisma.savedMessage.findUnique({
      where: { id: savedId },
      select: { reminderFiredAt: true },
    });
    expect(row?.reminderFiredAt?.getTime()).toBe(already.getTime());
  });

  it('(7) 오프라인(소켓 없음)이어도 발화 시 DB reminderFiredAt 은 기록된다', async () => {
    // gatewayStub.emitToUserRoom 은 항상 캡처만 하므로 "소켓 없음" 은 emit no-op 과
    // 동치다. DB 기록이 emit 성공 여부와 무관함을 확인한다.
    const savedId = await seedSaved();
    await queueSvc.schedule({
      savedMessageId: savedId,
      userId,
      reminderAt: new Date(Date.now() + 10),
    });
    await waitFor(async () => {
      const row = await prisma.savedMessage.findUnique({
        where: { id: savedId },
        select: { reminderFiredAt: true },
      });
      return row?.reminderFiredAt != null;
    });
    const row = await prisma.savedMessage.findUnique({
      where: { id: savedId },
      select: { reminderFiredAt: true },
    });
    expect(row?.reminderFiredAt).not.toBeNull();
  });

  it('(8) 본인 항목이 아니면 update/snooze 가 404 SAVED_NOT_FOUND', async () => {
    const savedId = await seedSaved();
    await expect(
      saved.update(otherUserId, savedId, { reminderAt: new Date(Date.now() + 1000) }),
    ).rejects.toMatchObject({ code: ErrorCode.SAVED_NOT_FOUND });
    await expect(saved.snooze(otherUserId, savedId, 10)).rejects.toMatchObject({
      code: ErrorCode.SAVED_NOT_FOUND,
    });
  });
});
