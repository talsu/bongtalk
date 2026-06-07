import { Logger, Optional } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.module';
import { OutboxService } from '../common/outbox/outbox.service';
import { ChannelAccessService } from '../channels/permission/channel-access.service';
import { MentionGateService } from '../notifications/mention-gate.service';
import { MetricsService } from '../observability/metrics/metrics.service';
import { MENTION_RECEIVED, type MentionReceivedPayload } from '../messages/events/mention-events';
import {
  MENTION_BROADCAST_QUEUE,
  MENTION_BROADCAST_CONCURRENCY,
  MENTION_BROADCAST_LIMITER,
  MENTION_BROADCAST_OPTS,
  type MentionBroadcastJobData,
} from './mention-broadcast-queue.constants';

/**
 * S88b (ADR B1·B4 / FR-MN-19 · FR-MN-03): @role 멘션 async fanout worker(BullMQ in-process).
 *
 * ★이중경로 회피(B1): 워커는 WS/badge/push/replay 를 직접 재emit 하지 않는다. 대신
 * 신규 삽입된 MentionRecord 수신자마다 mention.received outbox 를 1건 기록하고, 그 다음은
 * 기존 outbox-to-ws subscriber(onMentionEvent)가 @user 와 동일하게 WS(mention:new)·배지
 * 재집계·push enqueue·replay 를 처리한다(부수효과 단일 경로 · divergence/이중발송 0).
 *
 * 잡당 절차(B1 1~3 · S88b fix-forward F1·F2·F4·F5):
 *   (1) expand   : gatedRoleIds 를 잡 시점 MemberRole.findMany 로 userId 집합으로 확장.
 *                  self(작성자) + syncNotifiedUserIds(동기 경로가 이미 알림한 전체 수신자 ·
 *                  F2 cross-path dedup)를 제외한다.
 *   (2) 가시성   : ChannelAccessService.filterChannelVisibleUsers 로 VIEW_CHANNEL 가시
 *                  후보만 남긴다(F4 — 공개=1쿼리·비공개=2쿼리·N+1 없음·비멤버 throw 없음).
 *   (3) 게이트   : MentionGateService.filterNotifiable 로 동기 send 경로와 **동일한**
 *                  per-recipient 게이트(block/mute/DND/thread-OFF/NotifLevel-direct)를
 *                  재적용한다(F1 ★BLOCKER — 워커가 게이트를 빠뜨려 차단/뮤트/DND/OFF/
 *                  NotifLevel 사용자에게 @role 누출하던 회귀 차단 · block 누출은 보안 회귀).
 *                  @role 은 항상 'direct' 분류(개인 멘션 parity · @here/@everyone 과 구분).
 *   (4) 멱등 기록: 워커 tx 에서 MentionRecord 를 INSERT … ON CONFLICT DO NOTHING RETURNING
 *                  으로 멱등 INSERT 하고, **실제 INSERT 된 행(RETURNING)에 한해** mention
 *                  .received outbox 를 같은 tx 로 1건 기록한다(F5 — 사전조회 newIds 가 아닌
 *                  실 삽입분 기준이라, 동시 재처리가 겹쳐도 outbox 이중 발송 0 · exactly-once).
 *
 * 재시도(FR-MN-19): attempts 3 지수백오프(초기 2초). 최종 실패(attemptsMade == attempts-1)
 * 면 ERROR 로그 + 메트릭. MentionRecord 멱등이 부분 처리 후 재시도에도 정합을 보장한다.
 *
 * WorkerHost lifecycle 은 @nestjs/bullmq 가 관리한다(graceful shutdown — main.ts 의
 * app.enableShutdownHooks() 로 SIGTERM 시 worker.close drain · F3). 미발화 잡은 Redis 에
 * 영속하므로 재시작 후 복구된다(FR-MN-19 pending 자동 재처리).
 */
@Processor(MENTION_BROADCAST_QUEUE, {
  concurrency: MENTION_BROADCAST_CONCURRENCY,
  // FR-MN-19: 큐 전역 throughput 100 jobs/s. concurrency(동시 10)와 별개로, burst 가
  // NAS Redis/Postgres 를 압박하지 않게 처리율을 제한한다(BullMQ Worker 레벨 limiter).
  limiter: MENTION_BROADCAST_LIMITER,
})
export class MentionBroadcastProcessor extends WorkerHost {
  private readonly logger = new Logger(MentionBroadcastProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly channelAccess: ChannelAccessService,
    private readonly mentionGate: MentionGateService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    super();
  }

  async process(job: Job<MentionBroadcastJobData>): Promise<void> {
    const startNs = process.hrtime.bigint();
    try {
      await this.run(job.data);
    } catch (err) {
      // FR-MN-19: 최종 실패(마지막 attempt)면 ERROR 로그 + 실패 메트릭. 그 외 attempt 는
      // 던져서 BullMQ 가 지수백오프로 재시도하게 한다(MentionRecord 멱등이 재처리 안전).
      this.recordFinalFailureIfExhausted(job, err);
      throw err;
    } finally {
      // prom: 처리 시간 observe(진입~종료). label 은 큐 이름(고정 카디널리티).
      const durSec = Number(process.hrtime.bigint() - startNs) / 1e9;
      this.metrics?.bullmqJobDurationSeconds.labels(MENTION_BROADCAST_QUEUE).observe(durSec);
    }
  }

  /** B1 1~4 단계의 본 처리. process() 가 메트릭/실패 로깅으로 감싼다. */
  private async run(data: MentionBroadcastJobData): Promise<void> {
    const { messageId, channelId, workspaceId, actorId, gatedRoleIds } = data;
    if (gatedRoleIds.length === 0) return;
    // S88b fix-forward (F2 / ★correctness): 동기 send 경로가 실제로 mention.received 를
    // 발송한 전체 수신자(@user 직접 멘션 ∪ @everyone/@here/@channel broad 확장)는 역할
    // expand 집합에서 제외한다. 동기로 이미 알림받은 사용자가 @role 멤버이기도 할 때
    // 2건(동기+async)이 아니라 정확히 1건만 받게 한다. 종전엔 직접 @user 만 제외해
    // broad∩@role 이중 알림이 누락됐다(d85c747) — F2 가 전체 동기 수신자 집합으로 정정.
    const syncNotified = new Set(data.syncNotifiedUserIds ?? []);

    // (0) 메시지 생존 확인 + 채널 메타(가시성 필터용 isPrivate). 삭제됐으면 전체 skip.
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: { id: true, isPrivate: true, deletedAt: true },
    });
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, deletedAt: true },
    });
    if (!channel || channel.deletedAt !== null || !message || message.deletedAt !== null) {
      this.logger.debug(`[mention-broadcast] skip (channel/message gone) msg=${messageId}`);
      return;
    }

    // (1) expand: 잡 시점 MemberRole 로 역할 멤버 userId 집합 확장. self(작성자) + 동기
    //     알림 완료 수신자(F2)는 제외(send 권위 게이트와 일관 + cross-path dedup).
    const memberRows = await this.prisma.memberRole.findMany({
      where: { workspaceId, roleId: { in: gatedRoleIds } },
      select: { userId: true },
    });
    const candidateIds = Array.from(new Set(memberRows.map((r) => r.userId))).filter(
      (uid) => uid !== actorId && !syncNotified.has(uid),
    );
    if (candidateIds.length === 0) return;

    await this.prisma.$transaction(async (tx) => {
      // (2) 가시성(F4): VIEW_CHANNEL 가시 후보만(공개=1쿼리·비공개=2쿼리·N+1 없음 ·
      //     강퇴 후 MemberRole 잔존 사용자는 비멤버로 자연 제외 · throw 없음). tx 안에서
      //     호출해 send tx 와 동일 스냅샷으로 평가한다.
      const visible = await this.channelAccess.filterChannelVisibleUsers(
        { id: channelId, isPrivate: channel.isPrivate },
        workspaceId,
        candidateIds,
        tx,
      );
      if (visible.size === 0) return;

      // (3) 게이트(F1 / ★BLOCKER): 동기 send 경로와 동일한 per-recipient 게이트(block/
      //     mute/DND/thread-OFF/NotifLevel)를 재적용한다. @role 은 'direct' 분류(개인
      //     멘션 parity). 같은 tx 로 호출해 atomic snapshot 보장.
      const notifiable = await this.mentionGate.filterNotifiable(tx, {
        channelId,
        workspaceId,
        authorId: actorId,
        parentMessageId: data.parentMessageId ?? null,
        candidateUserIds: Array.from(visible),
        kindFor: () => 'direct',
        now: new Date(),
      });
      if (notifiable.size === 0) return;

      // (4) 멱등 기록(F5 / exactly-once outbox): MentionRecord 를 INSERT … ON CONFLICT
      //     DO NOTHING RETURNING 으로 멱등 INSERT 하고, **실제 삽입된 targetId** 만 받아
      //     그 수신자에만 outbox 를 기록한다. 사전조회 newIds 가 아니라 실 삽입분 기준이라,
      //     두 패스가 겹쳐도(동시 재처리) 같은 uid 에 outbox 2건이 나가지 않는다.
      const targetIds = Array.from(notifiable);
      const insertedRows = await tx.$queryRaw<Array<{ targetId: string }>>`
        INSERT INTO "MentionRecord"
          ("id", "messageId", "targetId", "targetType", "channelId", "workspaceId", "createdAt")
        SELECT gen_random_uuid(), ${messageId}::uuid, uid::uuid, 'USER'::"MentionTargetType",
               ${channelId}::uuid, ${workspaceId}::uuid, now()
          FROM unnest(${targetIds}::uuid[]) AS uid
        ON CONFLICT ("messageId", "targetId", "targetType") DO NOTHING
        RETURNING "targetId"
      `;
      const insertedIds = insertedRows.map((r) => r.targetId);
      if (insertedIds.length === 0) return; // 전부 기처리(재시도/재처리 멱등 경로) → no-op.

      // 신규 삽입분만 outbox 1건. 그 다음 부수효과(WS/badge/push/replay)는 기존
      // outbox-to-ws subscriber(onMentionEvent)가 @user 와 동일하게 처리한다(B1 ④).
      for (const uid of insertedIds) {
        const payload: MentionReceivedPayload = {
          targetUserId: uid,
          workspaceId,
          channelId,
          messageId,
          actorId,
          snippet: data.snippet,
          createdAt: data.createdAt,
          everyone: data.everyone === true,
          here: data.here === true,
          // S88b: 이 경로는 @role 멘션 전용이므로 항상 역할 유래(role=true). 동일 수신자가
          // 직접 @user/broad 로도 동기 알림됐다면 그 수신자는 (1) expand 의 syncNotified
          // 로 이미 제외돼 여기 도달하지 않는다(F2 cross-path dedup · 1수신자 1건).
          role: true,
        };
        await this.outbox.record(tx, {
          aggregateType: 'UserMention',
          aggregateId: uid,
          eventType: MENTION_RECEIVED,
          payload,
        });
      }
    });
  }

  /**
   * FR-MN-19: 최종 실패(모든 attempt 소진) 판정 후 ERROR 로그 + 메트릭. BullMQ 는 process()
   * 가 throw 하면 attemptsMade 를 증가시키며, 마지막 attempt(attemptsMade == attempts-1)에서
   * 던지면 더 이상 재시도하지 않는다. 여기서 그 경계를 검사해 한 번만 ERROR 로 남긴다(중복
   * 로그 방지). MentionRecord 멱등이 부분 처리 후 정합을 이미 보장하므로, 실패 알림은 운영
   * 가시성(로그/메트릭) 위주의 최소 구현이다(ADR B4 deviation 문서화 — 별도 Inbox 엔티티 부재).
   */
  private recordFinalFailureIfExhausted(job: Job<MentionBroadcastJobData>, err: unknown): void {
    const maxAttempts = job.opts.attempts ?? MENTION_BROADCAST_OPTS.attempts;
    // attemptsMade 는 이번 시도 직후 BullMQ 가 증가시키지만, process() 안에서는 아직 이번
    // 시도가 카운트되기 전이라 (attemptsMade + 1 >= maxAttempts) 가 "이번이 마지막" 조건이다.
    const isFinal = job.attemptsMade + 1 >= maxAttempts;
    if (!isFinal) return;
    const reason = err instanceof Error ? err.message : String(err);
    this.logger.error(
      `[mention-broadcast] job exhausted msg=${job.data.messageId} roles=${job.data.gatedRoleIds.length} attempts=${maxAttempts}: ${reason.slice(0, 200)}`,
    );
    this.metrics?.bullmqJobsFailedTotal.labels(MENTION_BROADCAST_QUEUE).inc();
  }
}
