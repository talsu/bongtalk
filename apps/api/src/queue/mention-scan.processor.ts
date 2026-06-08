import { Logger, Optional } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { PrismaService } from '../prisma/prisma.module';
import { OutboxService } from '../common/outbox/outbox.service';
import { ChannelAccessService } from '../channels/permission/channel-access.service';
import { MentionGateService } from '../notifications/mention-gate.service';
import { MetricsService } from '../observability/metrics/metrics.service';
import { MENTION_RECEIVED, type MentionReceivedPayload } from '../messages/events/mention-events';
import { scanKeywords, type KeywordWatcher } from './keyword-matcher';
import {
  MENTION_SCAN_QUEUE,
  MENTION_SCAN_CONCURRENCY,
  MENTION_SCAN_LIMITER,
  MENTION_SCAN_OPTS,
  type MentionScanJobData,
} from './mention-scan-queue.constants';

/**
 * FR-MN-10 (Task 066 / S93): 키워드 알림 스캔 async 워커(BullMQ in-process · mention-broadcast
 * 미러). 메시지 저장 후 watcher(UserSettings.keywords 보유자)의 키워드가 본문에 어절 정확
 * 일치하면, 그 수신자에게 키워드 유래 멘션(MentionRecord targetType='KEYWORD')을 기록한다.
 *
 * ★이중경로 회피(mention-broadcast B1 동일): 워커는 WS/badge/push/replay 를 직접 재emit
 * 하지 않는다. 신규 삽입된 MentionRecord 수신자마다 mention.received outbox 1건(keyword:true)
 * 을 기록하고, 그 다음은 기존 outbox-to-ws subscriber(onMentionEvent)가 @user 와 동일하게
 * WS(mention:new)·배지 재집계·push enqueue·replay 를 처리한다(부수효과 단일 경로).
 *
 * 잡당 절차(mention-broadcast 절차 미러):
 *   (0) 생존확인 : 채널/메시지 findUnique. 메시지 없음/삭제됨/parentMessageId!==null(방어적 ·
 *                  스레드 댓글은 enqueue 측에서 이미 제외)이면 return.
 *   (1) 스캔텍스트: contentPlain 을 sentinel-bounded 정규화(어절 경계). 빈 본문이면 early-return.
 *   (2) 후보watcher: UserSettings JOIN WorkspaceMember(ws) 에서 keywords 보유 · self 제외 후보를
 *                  raw 로 조회 → syncNotifiedUserIds 로 필터. 0명이면 early-exit(키워드 없는 ws).
 *   (3) 매칭     : scanKeywords 순수 함수로 어절 정확 일치 watcher 집합 산출(whole-word · 대소문자무관).
 *   (4) 가시성   : ChannelAccessService.filterChannelVisibleUsers 로 VIEW_CHANNEL 가시 후보만(tx).
 *   (5) 게이트   : MentionGateService.filterNotifiable(block/mute/DND/NotifLevel · kindFor='direct').
 *   (6) record dedup: 이 메시지의 기존 MentionRecord.targetId(임의 type) 제외(@role 워커가 먼저
 *                  돈 경우 USER record 수신자와 이중 Inbox 방지).
 *   (7) 멱등기록 : MentionRecord(targetType='KEYWORD') INSERT … ON CONFLICT DO NOTHING RETURNING
 *                  → 실 삽입분만 mention.received outbox 1건(keyword:true) 기록.
 *
 * 재시도: attempts 3 지수백오프(초기 2초). 최종 실패면 ERROR 로그 + 메트릭. MentionRecord
 * 멱등이 부분 처리 후 재시도에도 정합을 보장한다(mention-broadcast 와 동일 정책).
 */
@Processor(MENTION_SCAN_QUEUE, {
  concurrency: MENTION_SCAN_CONCURRENCY,
  // 큐 전역 throughput 100 jobs/s(concurrency 와 별개의 Worker 레벨 limiter).
  limiter: MENTION_SCAN_LIMITER,
})
export class MentionScanProcessor extends WorkerHost {
  private readonly logger = new Logger(MentionScanProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly channelAccess: ChannelAccessService,
    private readonly mentionGate: MentionGateService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    super();
  }

  async process(job: Job<MentionScanJobData>): Promise<void> {
    const startNs = process.hrtime.bigint();
    try {
      await this.run(job.data);
    } catch (err) {
      this.recordFinalFailureIfExhausted(job, err);
      throw err;
    } finally {
      const durSec = Number(process.hrtime.bigint() - startNs) / 1e9;
      this.metrics?.bullmqJobDurationSeconds.labels(MENTION_SCAN_QUEUE).observe(durSec);
    }
  }

  /** (0)~(7) 본 처리. process() 가 메트릭/실패 로깅으로 감싼다. */
  private async run(data: MentionScanJobData): Promise<void> {
    const { messageId, channelId, workspaceId, actorId } = data;
    const syncNotified = new Set(data.syncNotifiedUserIds ?? []);

    // (0) 채널/메시지 생존 확인 + 채널 메타(가시성 필터용 isPrivate). 삭제/부재 시 전체 skip.
    //     parentMessageId 는 방어적 재확인용(enqueue 측에서 루트만 enqueue 하지만, 워커도 가드).
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: { id: true, isPrivate: true, deletedAt: true },
    });
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, deletedAt: true, parentMessageId: true, contentPlain: true },
    });
    if (
      !channel ||
      channel.deletedAt !== null ||
      !message ||
      message.deletedAt !== null ||
      message.parentMessageId !== null
    ) {
      this.logger.debug(
        `[mention-scan] skip (channel/message gone or thread reply) msg=${messageId}`,
      );
      return;
    }

    // (1) 스캔 텍스트: 어절 경계 sentinel 정규화. 빈 본문이면 매칭 대상 없음 → early-return.
    const bounded = ` ${(message.contentPlain ?? '').toLowerCase().split(/\s+/).filter(Boolean).join(' ')} `;
    if (bounded.trim() === '') return;

    // (2) 후보 watcher: 이 워크스페이스 멤버 중 keywords 보유 · 작성자 제외. raw 로 1쿼리에
    //     userId+keywords 를 가져온 뒤, 동기 경로가 이미 알림한 수신자(syncNotified)를 제외한다.
    const watcherRows = await this.prisma.$queryRaw<Array<{ userId: string; keywords: string[] }>>`
      SELECT us."userId", us."keywords"
        FROM "UserSettings" us
        JOIN "WorkspaceMember" wm
          ON wm."userId" = us."userId" AND wm."workspaceId" = ${workspaceId}::uuid
       WHERE array_length(us."keywords", 1) > 0
         AND us."userId" <> ${actorId}::uuid
    `;
    const watchers: KeywordWatcher[] = watcherRows
      .filter((r) => !syncNotified.has(r.userId))
      .map((r) => ({ userId: r.userId, keywords: r.keywords }));
    if (watchers.length === 0) return;

    // (3) 매칭(JS 순수 함수): 어절 정확 일치(whole-word · 대소문자무관 · substring 아님 ·
    //     다어절 키워드 지원). scanKeywords 가 (1) 과 동일한 sentinel 정규화를 재수행한다.
    const matched = scanKeywords(message.contentPlain, watchers);
    if (matched.size === 0) return;

    await this.prisma.$transaction(async (tx) => {
      // (4) 가시성: VIEW_CHANNEL 가시 watcher 만(공개=1쿼리·비공개=2쿼리·비멤버 자연제외).
      //     tx 안에서 호출해 기록 tx 와 동일 스냅샷으로 평가한다.
      const visible = await this.channelAccess.filterChannelVisibleUsers(
        { id: channelId, isPrivate: channel.isPrivate },
        workspaceId,
        Array.from(matched),
        tx,
      );
      if (visible.size === 0) return;

      // (5) 게이트: 동기 send 경로와 동일한 per-recipient 게이트(block/mute/DND/NotifLevel).
      //     키워드 알림은 개인 직접 알림 분류 → kindFor='direct'(MENTIONS 레벨 통과 · NOTHING
      //     제외). 루트 메시지만 스캔하므로 parentMessageId=null(thread-OFF 게이트 비적용).
      const notifiable = await this.mentionGate.filterNotifiable(tx, {
        channelId,
        workspaceId,
        authorId: actorId,
        parentMessageId: null,
        candidateUserIds: Array.from(visible),
        kindFor: () => 'direct',
        now: new Date(),
      });
      if (notifiable.size === 0) return;

      // (6) 기존-record dedup: 이 메시지의 기존 MentionRecord(임의 type · @role 워커가 먼저
      //     돈 경우의 USER record 포함) 수신자는 제외해, 같은 메시지로 한 수신자가 USER+
      //     KEYWORD 2건의 Inbox 항목을 받지 않게 한다(흔한 순서 커버 · 잔여 race 는 bounded).
      const notifiableArr = Array.from(notifiable);
      const existingRows = await tx.$queryRaw<Array<{ targetId: string }>>`
        SELECT "targetId"
          FROM "MentionRecord"
         WHERE "messageId" = ${messageId}::uuid
           AND "targetId" = ANY(${notifiableArr}::uuid[])
      `;
      const alreadyRecorded = new Set(existingRows.map((r) => r.targetId));
      const targetIds = notifiableArr.filter((uid) => !alreadyRecorded.has(uid));
      if (targetIds.length === 0) return;

      // (7) 멱등 기록(exactly-once outbox): MentionRecord(targetType='KEYWORD') 를 INSERT …
      //     ON CONFLICT DO NOTHING RETURNING 으로 멱등 INSERT 하고, 실 삽입분 targetId 만
      //     받아 그 수신자에게만 outbox 를 기록한다(keyword:true). 두 패스가 겹쳐도(재처리)
      //     같은 uid 에 outbox 2건이 나가지 않는다.
      const insertedRows = await tx.$queryRaw<Array<{ targetId: string }>>`
        INSERT INTO "MentionRecord"
          ("id", "messageId", "targetId", "targetType", "channelId", "workspaceId", "createdAt")
        SELECT gen_random_uuid(), ${messageId}::uuid, uid::uuid, 'KEYWORD'::"MentionTargetType",
               ${channelId}::uuid, ${workspaceId}::uuid, now()
          FROM unnest(${targetIds}::uuid[]) AS uid
        ON CONFLICT ("messageId", "targetId", "targetType") DO NOTHING
        RETURNING "targetId"
      `;
      const insertedIds = insertedRows.map((r) => r.targetId);
      if (insertedIds.length === 0) return; // 전부 기처리(재처리 멱등 경로) → no-op.

      for (const uid of insertedIds) {
        const payload: MentionReceivedPayload = {
          targetUserId: uid,
          workspaceId,
          channelId,
          messageId,
          actorId,
          snippet: data.snippet,
          createdAt: data.createdAt,
          // 키워드 멘션은 broad(@everyone/@here) 표식이 아니다. 역할 유래도 아니다.
          everyone: false,
          here: false,
          role: false,
          // FR-MN-10: 이 수신자가 키워드 매치로 유래했음을 표식한다(Inbox 라벨 · UI 분기).
          keyword: true,
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
   * 최종 실패(모든 attempt 소진) 판정 후 ERROR 로그 + 메트릭(mention-broadcast 와 동일 구조).
   * BullMQ 는 process() 가 throw 하면 attemptsMade 를 증가시키며, 마지막 attempt 에서 던지면
   * 더 이상 재시도하지 않는다. (attemptsMade + 1 >= maxAttempts) 가 "이번이 마지막" 조건이다.
   */
  private recordFinalFailureIfExhausted(job: Job<MentionScanJobData>, err: unknown): void {
    const maxAttempts = job.opts.attempts ?? MENTION_SCAN_OPTS.attempts;
    const isFinal = job.attemptsMade + 1 >= maxAttempts;
    if (!isFinal) return;
    const reason = err instanceof Error ? err.message : String(err);
    this.logger.error(
      `[mention-scan] job exhausted msg=${job.data.messageId} attempts=${maxAttempts}: ${reason.slice(0, 200)}`,
    );
    this.metrics?.bullmqJobsFailedTotal.labels(MENTION_SCAN_QUEUE).inc();
  }
}
