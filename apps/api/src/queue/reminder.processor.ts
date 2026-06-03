import { Logger, Optional } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { WS_EVENTS, type ReminderFirePayload, type SavedUpdatedPayload } from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { MetricsService } from '../observability/metrics/metrics.service';
import { REMINDER_QUEUE, type ReminderJobData } from './reminder-queue.constants';

// 발화 토스트/Notification 발췌 길이 상한(SavedService.EXCERPT_LEN 과 동일 정책).
const PREVIEW_LEN = 150;
const DELETED_PLACEHOLDER = '[삭제된 메시지]';

interface FireRow {
  status: 'IN_PROGRESS' | 'ARCHIVED' | 'COMPLETED';
  reminderFiredAt: Date | null;
  savedAt: Date;
  messageId: string;
  messageDeletedAt: Date | null;
  contentPlain: string | null;
  channelId: string | null;
  channelName: string | null;
}

/**
 * S53 (D10 / FR-PS-09/10): 저장 리마인더 발화 worker(BullMQ in-process).
 *
 * WorkerHost lifecycle 은 @nestjs/bullmq 가 관리한다(graceful shutdown 자동 —
 * onModuleDestroy 에서 worker.close). 미발화 delayed job 은 Redis 에 영속하므로
 * 프로세스 재시작 후에도 복구된다(단일 노드).
 *
 * 발화 절차(중복 발화·잔존 정합 방어):
 *   (1) SavedMessage + 원본 메시지/채널을 조인 조회. 행 부재(unsave/hard-delete)면 skip.
 *   (2) reminderFiredAt 이 이미 있으면 skip(중복 발화 방지 — 재시도/재기동 멱등).
 *   (3) status=COMPLETED 면 skip(완료 항목은 알리지 않음 — Slack parity).
 *   (4) 원본이 soft-delete 됐어도 발화는 한다(놓친 컨텍스트라도 알림은 의미 있음) —
 *       단 발췌는 placeholder 로 마스킹.
 *   (5) tx: reminderFiredAt=now, snoozedUntil=null 로 갱신(원자적 발화 표식).
 *   (6) user:{userId} 룸으로 user:reminder_fire + user:saved_updated emit.
 *       ★DND 게이트 bypass — 사용자가 직접 설정한 예약이므로 항상 발화한다.
 *
 * 오프라인(소켓 없음)이어도 emit 은 no-op 이고 DB reminderFiredAt 은 기록되므로,
 * 재접속 시 overdueReminder 조회로 놓친 리마인더가 표시된다.
 */
@Processor(REMINDER_QUEUE)
export class ReminderProcessor extends WorkerHost {
  private readonly logger = new Logger(ReminderProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RealtimeGateway,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    super();
  }

  async process(job: Job<ReminderJobData>): Promise<void> {
    const { savedMessageId, userId } = job.data;
    const now = new Date();

    // (1) 저장 항목 + 원본 컨텍스트 조인. soft-deleted 채널도(c.deletedAt 무시)
    // 식별자는 남기되 발췌만 마스킹한다 — 발화 자체는 막지 않는다.
    const rows = await this.prisma.$queryRaw<FireRow[]>`
      SELECT
        sm.status            AS "status",
        sm."reminderFiredAt" AS "reminderFiredAt",
        sm."savedAt"         AS "savedAt",
        sm."messageId"       AS "messageId",
        sm."messageDeletedAt" AS "messageDeletedAt",
        m."contentPlain"     AS "contentPlain",
        m."channelId"        AS "channelId",
        COALESCE(c."displayName", c."name") AS "channelName"
      FROM "SavedMessage" sm
      LEFT JOIN "Message" m ON m.id = sm."messageId"
      LEFT JOIN "Channel" c ON c.id = m."channelId"
      WHERE sm.id = ${savedMessageId}::uuid
        AND sm."userId" = ${userId}::uuid
    `;
    const row = rows[0];
    // (1) 행 부재(unsave) 또는 원본 hard-delete(FK cascade 로 SavedMessage 도 사라짐
    // → 이 경우 row 부재) → skip.
    if (!row) {
      this.logger.debug(`[reminder] fire skip (no saved row) saved=${savedMessageId}`);
      return;
    }
    // (2) 이미 발화됨 → skip(중복 발화 방지).
    if (row.reminderFiredAt !== null) {
      this.logger.debug(`[reminder] fire skip (already fired) saved=${savedMessageId}`);
      return;
    }
    // (3) 완료 항목 → skip.
    if (row.status === 'COMPLETED') {
      this.logger.debug(`[reminder] fire skip (completed) saved=${savedMessageId}`);
      return;
    }
    // 원본 메시지가 hard-delete 되진 않았으나(SavedMessage 생존) Message 행이 없으면
    // 정합성 안전을 위해 skip(LEFT JOIN 결과 messageId 는 sm 컬럼이라 항상 있으나
    // contentPlain/channelId 는 null 일 수 있음).
    const deleted = row.messageDeletedAt !== null || row.channelId === null;

    // (5) 발화 표식을 원자적으로 기록(reminderFiredAt + snooze 해제).
    await this.prisma.savedMessage.update({
      where: { id: savedMessageId },
      data: { reminderFiredAt: now, snoozedUntil: null },
    });

    // (6) user 룸으로 emit (DND bypass). 게이트웨이 server 미준비/오프라인이면
    // emit 은 no-op 이지만 DB 기록은 위에서 이미 완료됐다.
    const firePayload: ReminderFirePayload = {
      savedMessageId,
      messageId: row.messageId,
      channelId: row.channelId ?? row.messageId,
      channelName: deleted ? '' : (row.channelName ?? ''),
      messagePreview: deleted
        ? DELETED_PLACEHOLDER
        : (row.contentPlain ?? '').slice(0, PREVIEW_LEN),
      originalSavedAt: row.savedAt.toISOString(),
    };
    const updatedPayload: SavedUpdatedPayload = {
      savedMessageId,
      status: row.status,
      reminderAt: null,
    };
    this.gateway.emitToUserRoom(userId, WS_EVENTS.REMINDER_FIRE, firePayload);
    this.gateway.emitToUserRoom(userId, WS_EVENTS.SAVED_UPDATED, updatedPayload);
    this.metrics?.wsEventsEmittedTotal
      .labels(this.metrics.bucket('wsEventType', WS_EVENTS.REMINDER_FIRE))
      .inc();

    this.logger.log(`[reminder] fired saved=${savedMessageId} user=${userId} deleted=${deleted}`);
  }
}
