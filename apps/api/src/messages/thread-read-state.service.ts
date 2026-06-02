import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

/**
 * S36 (D04·D09 / FR-RS-12 / FR-TH-04/11/12) — 스레드 단위 읽음 상태 코어.
 *
 * 채널 미읽(UnreadService)과 **독립적으로** 스레드 미읽을 추적하며, 동일한
 * (createdAt, id) 튜플 커서 공식(S11)을 공유한다. Message.id 가 랜덤 uuid
 * (비정렬)라 `id >` 단독 비교가 메시지 순서와 무관하므로, 미읽 판정은
 * (createdAt, id) 튜플로 한다(채널 미읽·메시지 커서 페이지네이션과 정합).
 *
 * ── 미읽 공식 (FR-TH-11 / FR-RS-12) ──
 *   thread-unread ⇔ COUNT(*) FROM "Message"
 *      WHERE "parentMessageId" = :rootId
 *        AND "isBroadcast" = false        -- broadcast 행은 채널 미읽에만 산입
 *                                         --   (FR-TH-14 중복집계 금지)
 *        AND "deletedAt" IS NULL          -- 삭제 답글 제외(채널 미읽과 일관)
 *        AND ("createdAt","id") > (:lastReadAt, :lastReadMessageId)
 *
 * ThreadReadState 행이 없거나 커서가 NULL 이면 LEFT JOIN 이 NULL 을 만들고
 * 튜플 비교가 "전부 미읽음" 으로 평가된다(신규 스레드 UX 일치 — 전체 답글 수).
 * 자기 답글도 미읽음으로 집계한다(채널 미읽 정책 — senderId 제외 없음 — 정합).
 *
 * ── unreadCount = 계산(옵션 B) ──
 * ThreadReadState 에는 튜플 커서만 저장하고 denormalized unreadCount 컬럼은
 * 두지 않는다. 미읽 수/여부는 조회 시 SQL COUNT 로 계산해 drift 를 원천 차단한다
 * (S11 채널-unread 철학 정합). denormalized unreadCount 컬럼 + Threads 탭
 * (FR-TH-09/10)은 S38 carryover.
 */
@Injectable()
export class ThreadReadStateService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * FR-TH-11 / FR-RS-12: 단일 스레드의 viewer 미읽 답글 수. ThreadReadState 가
   * 없으면(LEFT JOIN NULL) 비삭제·비broadcast 답글 전체 수를 반환한다. ACL 은
   * 호출측(threads.controller 의 requireRead)이 이미 통과시킨다.
   */
  async unreadCountFor(userId: string, parentMessageId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ unread_count: bigint | number }>>(Prisma.sql`
      SELECT COALESCE((
        SELECT count(*)
          FROM "Message" msg
          LEFT JOIN "ThreadReadState" rs
            ON rs."userId" = ${userId}::uuid
           AND rs."parentMessageId" = ${parentMessageId}::uuid
         WHERE msg."parentMessageId" = ${parentMessageId}::uuid
           AND msg."isBroadcast" = false
           AND msg."deletedAt" IS NULL
           AND (
             rs."lastReadMessageCreatedAt" IS NULL
             OR (msg."createdAt", msg.id) > (rs."lastReadMessageCreatedAt", rs."lastReadMessageId")
           )
      ), 0) AS unread_count
    `);
    return Number(rows[0]?.unread_count ?? 0);
  }

  // FR-TH-04 채널 목록 reply bar(qf-thread-chip) unread dot 의 배치 산정은
  // MessagesService.aggregateThreadSummaries(rootIds, viewerId) 가 같은 단일
  // 쿼리 안에서 처리한다(threadMeta 와 한 round-trip — N+1 없음). 별도 배치
  // 메서드를 두지 않는다(중복 SQL 회피).

  /**
   * FR-TH-12 / FR-RS-12: 스레드 읽음 ACK. monotonic (createdAt, id) 튜플 upsert —
   * 저장된 커서보다 strictly 큰 ack 일 때만 전진한다(퇴행 ack 는 no-op, 멀티세션
   * 동시 ACK 가 後進하지 않음). 채널 미읽 ackRead 의 guard 패턴과 동일.
   *
   *  1. lastReadMessageId 가 이 스레드(parentMessageId) 소속 답글인지 검증
   *     (아니면 404). broadcast 행은 채널 타임라인 복제본이라 스레드 커서로
   *     쓰지 않으므로 제외한다(isBroadcast=false).
   *  2. INSERT … ON CONFLICT DO UPDATE … WHERE(stored < EXCLUDED) — monotonic.
   *
   * ACL(루트 채널 READ)은 호출측 컨트롤러가 이미 통과시킨다.
   */
  async ackThread(args: {
    userId: string;
    parentMessageId: string;
    lastReadMessageId: string;
  }): Promise<void> {
    const { userId, parentMessageId, lastReadMessageId } = args;

    const reply = await this.prisma.message.findFirst({
      where: {
        id: lastReadMessageId,
        parentMessageId,
        isBroadcast: false,
        deletedAt: null,
      },
      select: { id: true, createdAt: true },
    });
    if (!reply) {
      throw new DomainError(
        ErrorCode.MESSAGE_NOT_FOUND,
        'lastReadMessageId does not belong to this thread',
      );
    }

    // monotonic upsert: UPDATE 분기의 WHERE 가 저장 튜플보다 strictly 클 때만
    // 전진한다. 퇴행/순서 어긋난 ack 는 0행 매칭 → no-op(커서 불변, 멱등).
    await this.prisma.$executeRaw`
      INSERT INTO "ThreadReadState"
        ("id", "userId", "parentMessageId",
         "lastReadMessageId", "lastReadMessageCreatedAt", "updatedAt")
      VALUES
        (${randomUUID()}::uuid, ${userId}::uuid, ${parentMessageId}::uuid,
         ${reply.id}::uuid, ${reply.createdAt}, now())
      ON CONFLICT ("userId", "parentMessageId") DO UPDATE
        SET "lastReadMessageId" = EXCLUDED."lastReadMessageId",
            "lastReadMessageCreatedAt" = EXCLUDED."lastReadMessageCreatedAt",
            "updatedAt" = now()
        WHERE "ThreadReadState"."lastReadMessageCreatedAt" IS NULL
           OR (
             "ThreadReadState"."lastReadMessageCreatedAt",
             "ThreadReadState"."lastReadMessageId"
           ) < (EXCLUDED."lastReadMessageCreatedAt", EXCLUDED."lastReadMessageId")
    `;
  }

  /**
   * FR-TH-18: ThreadReadState 의 현재 커서를 조회한다(프론트 초기 스크롤 앵커용 —
   * lastReadMessageId 다음 첫 미읽 답글 위치). 행이 없으면 null(전체 미읽 →
   * 최하단 스크롤). 스레드 패널 GET 응답에 실어 보낸다.
   */
  async cursorFor(
    userId: string,
    parentMessageId: string,
  ): Promise<{ lastReadMessageId: string | null } | null> {
    const row = await this.prisma.threadReadState.findUnique({
      where: { userId_parentMessageId: { userId, parentMessageId } },
      select: { lastReadMessageId: true },
    });
    if (!row) return null;
    return { lastReadMessageId: row.lastReadMessageId };
  }
}
