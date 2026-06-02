/**
 * S34 (FR-TH-17): replyCount drift 재집계 cron 단위 테스트.
 *
 * 검증 항목:
 *   - reconcile() 이 단일 drift-only UPDATE 를 발행한다(GROUP BY 서브쿼리 +
 *     `replyCount <> sub.actual` 가드).
 *   - drift 가 있을 때 affected row 수를 그대로 반환한다.
 *   - 정합(drift 0) 일 때 affected 0 을 반환한다(no-op — UPDATE 는 매칭 0행).
 *   - runHourly() 가 예외를 삼키고 앱을 죽이지 않는다.
 *
 * 외부 모킹 라이브러리 없이 vi.fn() 으로 PrismaService.$executeRaw 를 대체한다.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThreadReplyCountReconciler } from '../../../src/messages/thread-reply-count-reconciler.service';
import type { PrismaService } from '../../../src/prisma/prisma.module';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

function makeReconciler(executeRaw: ReturnType<typeof vi.fn>): ThreadReplyCountReconciler {
  const prisma = { $executeRaw: executeRaw } as unknown as PrismaService;
  return new ThreadReplyCountReconciler(prisma);
}

describe('ThreadReplyCountReconciler (FR-TH-17)', () => {
  it('issues a single drift-only UPDATE and returns affected count', async () => {
    const executeRaw = vi.fn().mockResolvedValue(3);
    const svc = makeReconciler(executeRaw);

    const fixed = await svc.reconcile();

    expect(fixed).toBe(3);
    expect(executeRaw).toHaveBeenCalledTimes(1);
    // Prisma.sql 템플릿이 drift-only 가드를 담고 있는지 확인한다. $executeRaw
    // 는 Prisma.Sql 객체를 받으므로 그 직렬화된 SQL 텍스트를 검사한다.
    const arg = executeRaw.mock.calls[0][0] as { strings?: string[]; sql?: string };
    const sqlText = (arg.strings?.join(' ') ?? arg.sql ?? '').replace(/\s+/g, ' ');
    expect(sqlText).toMatch(/UPDATE "Message"/);
    expect(sqlText).toMatch(/"replyCount" <> sub\.actual/);
    expect(sqlText).toMatch(/COUNT\(\*\) FILTER \(WHERE "deletedAt" IS NULL\)/);
    expect(sqlText).toMatch(/GROUP BY "parentMessageId"/);
    // latestReplyAt 은 재집계 대상이 아니다(PRD).
    expect(sqlText).not.toMatch(/latestReplyAt/);
  });

  it('returns 0 when no rows drift (consistent roots → no-op)', async () => {
    const executeRaw = vi.fn().mockResolvedValue(0);
    const svc = makeReconciler(executeRaw);

    const fixed = await svc.reconcile();

    expect(fixed).toBe(0);
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  it('runHourly swallows errors and never throws', async () => {
    const executeRaw = vi.fn().mockRejectedValue(new Error('db down'));
    const svc = makeReconciler(executeRaw);

    await expect(svc.runHourly()).resolves.toBeUndefined();
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  it('runHourly delegates to reconcile on the happy path', async () => {
    const executeRaw = vi.fn().mockResolvedValue(2);
    const svc = makeReconciler(executeRaw);

    await expect(svc.runHourly()).resolves.toBeUndefined();
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  // S34 fix-forward (reviewer MINOR-1): drift 가 0이어도 cron 이 정상 동작
  // 중임을 debug 로그로 관측 가능하게 한다(무음 cron 방지).
  it('runHourly logs a debug heartbeat when no drift is found', async () => {
    const executeRaw = vi.fn().mockResolvedValue(0);
    const svc = makeReconciler(executeRaw);
    // private logger 의 debug 를 spy. NestJS Logger 인스턴스 메서드를 대체한다.
    const logger = (svc as unknown as { logger: { debug: () => void; log: () => void } }).logger;
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(logger, 'log').mockImplementation(() => undefined);

    await svc.runHourly();

    expect(debugSpy).toHaveBeenCalledTimes(1);
    // drift 0 이므로 일반 log(info) 흔적은 남기지 않는다.
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('runHourly logs at info (not debug) when drift IS fixed', async () => {
    const executeRaw = vi.fn().mockResolvedValue(4);
    const svc = makeReconciler(executeRaw);
    const logger = (svc as unknown as { logger: { debug: () => void; log: () => void } }).logger;
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(logger, 'log').mockImplementation(() => undefined);

    await svc.runHourly();

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy).not.toHaveBeenCalled();
  });
});
