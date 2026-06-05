import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ReminderItem } from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { ReminderQueueService } from '../queue/reminder-queue.service';
import { parseReminder, REMINDER_SYNTAX_HINT } from './reminder-parse';

/**
 * S80 (D15 / FR-SC-06) — /remind 리마인더 도메인 서비스.
 *
 * Fork1 = Option A: SavedMessage 리마인더(S53)와 독립한 신규 Reminder 모델을 다룬다.
 * create 는 (1) chrono/한국어 파싱 → (2) Reminder 행 저장 → (3) BullMQ 지연잡 등록 →
 * (4) bullJobId 영속 의 순서로 진행한다(잡 등록은 best-effort — DB scheduledAt 이 진실원,
 * 실패해도 bootstrap 복구가 재등록).
 *
 * bootstrap 복구(onModuleInit): 프로세스 재기동 시 PENDING + scheduledAt 가 아직 미래인
 * Reminder 를 전수 조회해 BullMQ 지연잡을 재등록한다(미발화 잡 유실 방지·단일 노드).
 * 이미 발화 시각이 지난 PENDING(놓친 발화)은 delay 0 으로 즉시 큐잉돼 곧바로 발화된다.
 */
@Injectable()
export class ReminderService implements OnModuleInit {
  private readonly logger = new Logger(ReminderService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    private readonly queue: ReminderQueueService,
  ) {}

  /**
   * bootstrap 복구 스캔(FR-SC-06): PENDING 인 모든 Reminder 의 지연잡을 재등록한다.
   * scheduledAt 이 과거인 항목은 delay 0 으로 즉시 발화 큐잉된다(놓친 예약 보정). 테스트
   * 환경에선 Redis/큐가 없을 수 있어 전체를 best-effort 로 감싼다(부팅 실패 방지).
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.recoverPending();
    } catch (err) {
      this.logger.warn(`[remind] bootstrap recovery skipped: ${String(err).slice(0, 160)}`);
    }
  }

  /** PENDING Reminder 전수 재등록(부팅 복구). */
  async recoverPending(now: Date = new Date()): Promise<number> {
    const pending = await this.prisma.reminder.findMany({
      where: { status: 'PENDING' },
      select: { id: true, userId: true, scheduledAt: true },
    });
    for (const r of pending) {
      const jobId = await this.queue.scheduleRemind({
        reminderId: r.id,
        userId: r.userId,
        scheduledAt: r.scheduledAt,
        now,
      });
      // 재등록한 jobId 사본을 영속(취소 키 동기 — 종전 값과 동일하지만 명시).
      await this.prisma.reminder
        .update({ where: { id: r.id }, data: { bullJobId: jobId } })
        .catch(() => undefined);
    }
    if (pending.length > 0) {
      this.logger.log(`[remind] bootstrap recovered ${pending.length} pending reminder(s)`);
    }
    return pending.length;
  }

  /**
   * /remind 자연어 파싱 → Reminder 저장 → BullMQ 지연잡 등록. 파싱 실패면
   * REMINDER_PARSE_FAILED(구문 예시 포함)를 던진다. 성공 시 ReminderItem 을 반환한다.
   */
  async createFromNaturalLanguage(args: {
    userId: string;
    channelId: string | null;
    when: string;
    message: string;
    now?: Date;
  }): Promise<ReminderItem> {
    const now = args.now ?? new Date();
    // when + message 를 합쳐 파싱한다(execute 경로는 분리 입력이 아니라 단일 인자 텍스트를
    // 넘기므로, REST 직접 호출도 when 안에 시각+본문이 함께 올 수 있게 message 를 폴백한다).
    const combined = `${args.when} ${args.message}`.trim();
    const parsed = parseReminder(combined, now);
    if (!parsed.ok) {
      throw new DomainError(
        ErrorCode.REMINDER_PARSE_FAILED,
        `시각을 이해하지 못했습니다. ${REMINDER_SYNTAX_HINT}`,
      );
    }
    return this.persist({
      userId: args.userId,
      channelId: args.channelId,
      message: parsed.message,
      scheduledAt: parsed.scheduledAt,
      now,
    });
  }

  /**
   * 이미 파싱된 (시각 + 본문)으로 Reminder 를 저장하고 잡을 등록한다. execute 경로의
   * /remind 핸들러가 raw 인자를 직접 parseReminder 한 뒤 이 메서드를 호출한다(이중 파싱 회피).
   */
  async persist(args: {
    userId: string;
    channelId: string | null;
    message: string;
    scheduledAt: Date;
    now?: Date;
  }): Promise<ReminderItem> {
    const now = args.now ?? new Date();
    const row = await this.prisma.reminder.create({
      data: {
        userId: args.userId,
        channelId: args.channelId,
        message: args.message.slice(0, 500),
        scheduledAt: args.scheduledAt,
        status: 'PENDING',
      },
      select: {
        id: true,
        channelId: true,
        message: true,
        scheduledAt: true,
        status: true,
        createdAt: true,
      },
    });
    const jobId = await this.queue.scheduleRemind({
      reminderId: row.id,
      userId: args.userId,
      scheduledAt: args.scheduledAt,
      now,
    });
    await this.prisma.reminder
      .update({ where: { id: row.id }, data: { bullJobId: jobId } })
      .catch(() => undefined);
    return this.toItem(row);
  }

  /** GET /users/me/reminders — 본인 리마인더(PENDING/SENT/CANCELLED) 목록(scheduledAt ASC). */
  async list(userId: string): Promise<ReminderItem[]> {
    const rows = await this.prisma.reminder.findMany({
      where: { userId },
      orderBy: [{ scheduledAt: 'asc' }],
      select: {
        id: true,
        channelId: true,
        message: true,
        scheduledAt: true,
        status: true,
        createdAt: true,
      },
    });
    return rows.map((r) => this.toItem(r));
  }

  /**
   * DELETE /users/me/reminders/:id — 본인 리마인더 취소. 본인 소유(id+userId)가 아니면
   * 404 REMINDER_NOT_FOUND(존재 누출 방지). BullMQ 잡도 함께 제거하고 status=CANCELLED 로
   * 전이한다(이미 SENT 면 잡은 없고 상태만 전이 — 멱등).
   */
  async cancel(userId: string, reminderId: string): Promise<void> {
    const row = await this.prisma.reminder.findFirst({
      where: { id: reminderId, userId },
      select: { id: true, bullJobId: true, status: true },
    });
    if (!row) {
      throw new DomainError(ErrorCode.REMINDER_NOT_FOUND, 'reminder not found');
    }
    if (row.bullJobId) await this.queue.cancelRemind(row.bullJobId);
    await this.prisma.reminder.updateMany({
      where: { id: reminderId, userId },
      data: { status: 'CANCELLED' },
    });
  }

  private toItem(row: {
    id: string;
    channelId: string | null;
    message: string;
    scheduledAt: Date;
    status: 'PENDING' | 'SENT' | 'CANCELLED';
    createdAt: Date;
  }): ReminderItem {
    return {
      id: row.id,
      channelId: row.channelId,
      message: row.message,
      scheduledAt: row.scheduledAt.toISOString(),
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
