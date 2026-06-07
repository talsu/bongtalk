import { Logger, Optional } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.module';
import { OutboxService } from '../common/outbox/outbox.service';
import { ChannelAccessService } from '../channels/permission/channel-access.service';
import { Permission } from '../auth/permissions';
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
 * 잡당 절차(B1 1~3):
 *   (1) expand   : gatedRoleIds 를 잡 시점 MemberRole.findMany 로 userId 집합으로 확장.
 *   (2) 재검증   : 각 userId 에 VIEW_CHANNEL(Permission.READ) 재검증. 비가시자는 skip
 *                  (MentionRecord/outbox 미생성 — S88a 동작 일치·마스킹 불요). send 시점에
 *                  이미 적용된 self/block/mute 등은 워커가 다시 보지 않고(send 권위), 권한
 *                  후속 철회 대비 VIEW_CHANNEL 만 재검증한다.
 *   (3) 멱등 기록: 워커 자체 prisma tx 에서 MentionRecord 를 createMany(skipDuplicates)로
 *                  멱등 INSERT 하고, **신규 삽입된 수신자에 한해** mention.received outbox 를
 *                  같은 tx 로 1건 기록한다(retry/재시작 재처리 → MentionRecord 1행·outbox 0 중복).
 *
 * 재시도(FR-MN-19): attempts 3 지수백오프(초기 2초). 최종 실패(attemptsMade == attempts-1)
 * 면 ERROR 로그 + 메트릭. MentionRecord 멱등이 부분 처리 후 재시도에도 정합을 보장한다.
 *
 * WorkerHost lifecycle 은 @nestjs/bullmq 가 관리한다(graceful shutdown 자동). 미발화 잡은
 * Redis 에 영속하므로 재시작 후 복구된다(FR-MN-19 pending 자동 재처리).
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

  /** B1 1~3 단계의 본 처리. process() 가 메트릭/실패 로깅으로 감싼다. */
  private async run(data: MentionBroadcastJobData): Promise<void> {
    const { messageId, channelId, workspaceId, actorId, gatedRoleIds } = data;
    if (gatedRoleIds.length === 0) return;

    // (0) 메시지 생존 확인 + 채널 메타(VIEW_CHANNEL 재검증용 isPrivate). 삭제됐으면 전체 skip
    //     (멘션 무의미). isPrivate 은 hasPermission 시그니처가 요구한다.
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

    // (1) expand: 잡 시점 MemberRole 로 역할 멤버 userId 집합 확장. 작성자 self 제외(send 권위
    //     게이트와 일관 — self 멘션은 알림 없음).
    const memberRows = await this.prisma.memberRole.findMany({
      where: { workspaceId, roleId: { in: gatedRoleIds } },
      select: { userId: true },
    });
    const candidateIds = Array.from(new Set(memberRows.map((r) => r.userId))).filter(
      (uid) => uid !== actorId,
    );
    if (candidateIds.length === 0) return;

    // (2) 재검증: 각 후보의 VIEW_CHANNEL(READ) 권한을 잡 시점 DB 로 재조회. 비가시자는 skip
    //     (S88a 동작 일치 — 비공개 채널 비가시 역할멤버는 MentionRecord/알림 미생성). 권한 후속
    //     철회 대비 잡 시점 재검증(공개 채널이면 전원 통과 — hasPermission 이 isPrivate=false 를
    //     즉시 허용).
    const visibleIds: string[] = [];
    const channelMeta = { id: channelId, workspaceId, isPrivate: channel.isPrivate };
    for (const uid of candidateIds) {
      const ok = await this.channelAccess.hasPermission(channelMeta, uid, Permission.READ);
      if (ok) visibleIds.push(uid);
    }
    if (visibleIds.length === 0) return;

    // (3) 멱등 기록: 워커 자체 tx. MentionRecord 를 createMany(skipDuplicates)로 멱등 INSERT
    //     하고, 신규 삽입된 수신자에 한해 mention.received outbox 를 같은 tx 로 기록한다.
    //     신규 삽입분 판정: INSERT 전 이미 존재하던 (messageId, targetId) 를 빼서 산정한다
    //     (createMany 는 삽입된 row 를 돌려주지 않으므로 사전 조회로 신규분을 가른다).
    await this.prisma.$transaction(async (tx) => {
      const existingRows = await tx.mentionRecord.findMany({
        where: {
          messageId,
          targetType: 'USER',
          targetId: { in: visibleIds },
        },
        select: { targetId: true },
      });
      const existing = new Set(existingRows.map((r) => r.targetId));
      const newIds = visibleIds.filter((uid) => !existing.has(uid));
      if (newIds.length === 0) return; // 전부 기처리(재시도/재처리 멱등 경로) → no-op.

      await tx.mentionRecord.createMany({
        data: newIds.map((uid) => ({
          messageId,
          targetId: uid,
          targetType: 'USER' as const,
          channelId,
          workspaceId,
        })),
        // 멱등: 동시 처리/경합으로 사이에 끼어든 행과 충돌해도 조용히 skip(ON CONFLICT DO NOTHING).
        skipDuplicates: true,
      });

      // 신규 삽입분만 outbox 1건. 그 다음 부수효과(WS/badge/push/replay)는 기존
      // outbox-to-ws subscriber(onMentionEvent)가 @user 와 동일하게 처리한다(B1 ④).
      for (const uid of newIds) {
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
          // 직접 @user 로도 멘션됐다면 그쪽은 send 동기 경로가 이미 role=false 로 1건 emit
          // 했고, MentionRecord 는 @user 동기 경로가 만들지 않으므로 여기서 또 1건이 생길 수
          // 있다(전달 로그 멱등은 @role 워커 내부 한정 · @user 와의 cross-dedup 은 후속).
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
