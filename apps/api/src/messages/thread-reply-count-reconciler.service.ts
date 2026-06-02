import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';

/**
 * S34 (FR-TH-17): replyCount drift 재집계 job.
 *
 * `Message.replyCount` 는 send/soft-delete 의 단일 $transaction 이 원자적으로
 * 유지하는 비정규화 카운터다(GROUP BY 집계를 피해 reply bar 를 1쿼리로 그리기
 * 위함 — FR-TH-16). 그러나 직접 DB 수정·과거 마이그레이션·예기치 못한 장애
 * 등으로 카운터가 실제 비삭제 답글 수와 어긋날(drift) 수 있다. PRD FR-TH-17 은
 * "1시간 주기 재집계 job 이 `UPDATE WHERE replyCount <> actual_count` 조건으로
 * drift 만 수정한다"고 명시한다.
 *
 * 설계(결정 옵션 A):
 *   - NestJS `@Cron(EVERY_HOUR)` 으로 1시간마다 1회 실행한다(별도 워커·외부
 *     스케줄러 없이 앱 프로세스 내 in-process cron — NAS 단일 배포에 부합).
 *   - drift-only: `replyCount <> actual` 인 루트만 UPDATE 한다. 정합 루트는
 *     건드리지 않아(매칭 0행) 핫-로우 갱신·불필요한 WAL 을 피한다.
 *   - `latestReplyAt` 은 재집계 대상이 아니다(PRD). 마지막 답글이 삭제돼도
 *     "마지막 활동 시각" 표시는 보수적으로 유지한다.
 *
 * 멀티-노드(수평 확장) 시 여러 인스턴스가 동시에 같은 UPDATE 를 돌릴 수 있으나,
 * drift-only UPDATE 는 멱등(같은 결과로 수렴)이라 정합성에 해가 없다 — 분산 락은
 * 후속 과제로 둔다(현재 단일 노드 배포).
 */
@Injectable()
export class ThreadReplyCountReconciler {
  private readonly logger = new Logger(ThreadReplyCountReconciler.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * drift 가 있는 루트의 `replyCount` 를 실제 비삭제 답글 수로 정정하고,
   * 수정된 행 수를 반환한다. `@Cron` 핸들러와 단위 테스트가 공유한다.
   *
   * SQL: 답글 보유 루트별 실제 비삭제 답글 수(actual)를 서브쿼리로 집계한 뒤,
   * `replyCount <> actual` 인 루트만 UPDATE 한다. `COUNT(*) FILTER (WHERE
   * "deletedAt" IS NULL)` 로 삭제 답글을 제외하며, 인덱스
   * `(parentMessageId, createdAt)` 가 GROUP BY 를 인덱스 스캔으로 처리한다.
   *
   * 주의: 서브쿼리는 답글이 1건 이상 존재하는(parentMessageId IS NOT NULL)
   * 루트만 대상으로 한다. 답글이 *전혀* 없는데 replyCount > 0 인 루트(모든 답글
   * hard-delete 등 극히 드문 경우)는 이 서브쿼리에 나타나지 않아 정정되지
   * 않는다 — 실사용에서 답글은 soft-delete 만 하므로(행이 남음) 이 경계는
   * 발생하지 않는다.
   */
  async reconcile(): Promise<number> {
    const affected = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "Message"
         SET "replyCount" = sub.actual
        FROM (
          SELECT "parentMessageId" AS id,
                 COUNT(*) FILTER (WHERE "deletedAt" IS NULL)::int AS actual
            FROM "Message"
           WHERE "parentMessageId" IS NOT NULL
           GROUP BY "parentMessageId"
        ) sub
       WHERE "Message".id = sub.id
         AND "Message"."replyCount" <> sub.actual
    `);
    return affected;
  }

  /**
   * 1시간 주기 재집계. 실패해도 다음 주기에 다시 시도하면 되므로 예외를
   * 삼키고 로그만 남긴다(앱 프로세스를 죽이지 않는다).
   */
  @Cron(CronExpression.EVERY_HOUR)
  async runHourly(): Promise<void> {
    try {
      const fixed = await this.reconcile();
      if (fixed > 0) {
        this.logger.log(`thread replyCount drift reconciled: ${fixed} root(s) updated`);
      } else {
        // S34 fix-forward (reviewer MINOR-1): drift 가 없어도 실행 흔적을
        // debug 로 남겨 cron 이 정상 동작 중임을 관측 가능하게 한다(무음 cron
        // 은 "안 돌았는지/drift 가 없는지" 구분 불가). error 로깅은 유지.
        this.logger.debug('thread replyCount reconcile ran: no drift detected');
      }
    } catch (err) {
      this.logger.error('thread replyCount reconcile failed', err as Error);
    }
  }
}
