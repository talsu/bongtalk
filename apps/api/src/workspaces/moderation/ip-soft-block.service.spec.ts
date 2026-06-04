import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IpSoftBlockService } from './ip-soft-block.service';
import { AuditAction } from '../../common/audit/audit.service';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { hashIp } from '../../common/ip-hash';

/**
 * S72 (D13 / FR-W22): IP soft-block 도메인 단위 테스트.
 *
 * - APPLY 매칭 → 403(APPLICATION_NOT_APPLICABLE) 차단.
 * - PUBLIC/INVITE 매칭 → 허용 + SUSPICIOUS_JOIN audit 기록(hard-block 금지 단언).
 * - 미상 IP(null 해시) → 무동작 통과(대조/기록 없음).
 * - 24h threshold(기본 3) 도달 시 SUSPICIOUS_JOIN_THRESHOLD flag 추가 기록.
 *
 * 외부는 vi.fn() 으로만 모킹(Prisma/Audit 스텁). 시간/threshold 고정.
 */
beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  delete process.env.IP_BLOCK_THRESHOLD;
});

type PrismaStub = {
  bannedMember: { findFirst: ReturnType<typeof vi.fn> };
  auditLog: { count: ReturnType<typeof vi.fn> };
  workspaceMember: { findUnique: ReturnType<typeof vi.fn> };
};

function makeDeps(opts: {
  banMatch: boolean;
  // SUSPICIOUS_JOIN 24h count(threshold 평가 입력).
  count?: number;
  // 직전 24h 내 이미 존재하는 SUSPICIOUS_JOIN_THRESHOLD flag 수(de-dup 입력). 기본 0.
  priorThresholdFlags?: number;
  // audit.record 가 던지게 해 best-effort 비차단성을 검증.
  auditThrows?: boolean;
}): {
  prisma: PrismaStub;
  audit: { record: ReturnType<typeof vi.fn> };
  service: IpSoftBlockService;
} {
  const prisma: PrismaStub = {
    bannedMember: {
      findFirst: vi.fn(async () => (opts.banMatch ? { userId: 'banned-user' } : null)),
    },
    // 두 카운트 쿼리를 action 으로 구분한다: SUSPICIOUS_JOIN(threshold 평가) vs
    // SUSPICIOUS_JOIN_THRESHOLD(직전 flag de-dup 조회).
    auditLog: {
      count: vi.fn(async (q: { where?: { action?: string } }) => {
        if (q?.where?.action === AuditAction.SUSPICIOUS_JOIN_THRESHOLD) {
          return opts.priorThresholdFlags ?? 0;
        }
        return opts.count ?? 1;
      }),
    },
    workspaceMember: { findUnique: vi.fn(async () => ({ ipHash: 'stored-hash' })) },
  };
  const audit = {
    record: vi.fn(async () => {
      if (opts.auditThrows) throw new Error('audit db down');
    }),
  };
  // 서비스는 PrismaService / AuditService 타입을 받지만 런타임은 메서드 형태만 본다.
  const service = new IpSoftBlockService(
    prisma as unknown as ConstructorParameters<typeof IpSoftBlockService>[0],
    audit as unknown as ConstructorParameters<typeof IpSoftBlockService>[1],
  );
  return { prisma, audit, service };
}

const WS = '00000000-0000-0000-0000-0000000000aa';
const USER = '00000000-0000-0000-0000-0000000000bb';
const IP = '203.0.113.7';

describe('IpSoftBlockService.assertNotIpBlocked', () => {
  it('passes through (no DB lookup) when client IP is unknown/null', async () => {
    const { prisma, audit, service } = makeDeps({ banMatch: false });
    const result = await service.assertNotIpBlocked({
      workspaceId: WS,
      userId: USER,
      clientIp: 'unknown',
      mechanism: 'PUBLIC',
    });
    expect(result.ipHash).toBeNull();
    expect(prisma.bannedMember.findFirst).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('returns the computed ipHash and records nothing when no banned IP matches', async () => {
    const { prisma, audit, service } = makeDeps({ banMatch: false });
    const result = await service.assertNotIpBlocked({
      workspaceId: WS,
      userId: USER,
      clientIp: IP,
      mechanism: 'PUBLIC',
    });
    expect(result.ipHash).toBe(hashIp(IP));
    expect(prisma.bannedMember.findFirst).toHaveBeenCalledOnce();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('blocks an APPLY join with 409 APPLICATION_NOT_APPLICABLE when the IP matches', async () => {
    const { audit, service } = makeDeps({ banMatch: true });
    const err = await service
      .assertNotIpBlocked({ workspaceId: WS, userId: USER, clientIp: IP, mechanism: 'APPLY' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe(ErrorCode.APPLICATION_NOT_APPLICABLE);
    // hard-block 금지 단언: APPLY 거부도 IP ban 행을 만들지 않는다(audit 만, BannedMember 무생성).
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('allows a PUBLIC join on IP match and records SUSPICIOUS_JOIN (soft, never hard-block)', async () => {
    const { audit, service } = makeDeps({ banMatch: true, count: 1 });
    const result = await service.assertNotIpBlocked({
      workspaceId: WS,
      userId: USER,
      clientIp: IP,
      mechanism: 'PUBLIC',
    });
    // soft: 예외 없이 통과하고 ipHash 를 돌려준다(가입 진행 — IP hard-block 아님).
    expect(result.ipHash).toBe(hashIp(IP));
    expect(audit.record).toHaveBeenCalledOnce();
    expect(audit.record.mock.calls[0][0]).toMatchObject({
      action: AuditAction.SUSPICIOUS_JOIN,
      workspaceId: WS,
      ipHash: hashIp(IP),
    });
  });

  it('allows an INVITE accept on IP match the same way (soft + audit)', async () => {
    const { audit, service } = makeDeps({ banMatch: true, count: 1 });
    const result = await service.assertNotIpBlocked({
      workspaceId: WS,
      userId: USER,
      clientIp: IP,
      mechanism: 'INVITE',
    });
    expect(result.ipHash).toBe(hashIp(IP));
    expect(audit.record).toHaveBeenCalledOnce();
  });

  it('emits a SUSPICIOUS_JOIN_THRESHOLD flag when the 24h count reaches the threshold', async () => {
    // count=3 ≥ 기본 threshold 3 → 두 번째 record(threshold flag) 호출.
    const { audit, service } = makeDeps({ banMatch: true, count: 3 });
    await service.assertNotIpBlocked({
      workspaceId: WS,
      userId: USER,
      clientIp: IP,
      mechanism: 'PUBLIC',
    });
    expect(audit.record).toHaveBeenCalledTimes(2);
    expect(audit.record.mock.calls[0][0].action).toBe(AuditAction.SUSPICIOUS_JOIN);
    expect(audit.record.mock.calls[1][0]).toMatchObject({
      action: AuditAction.SUSPICIOUS_JOIN_THRESHOLD,
      details: { count: 3, threshold: 3, windowHours: 24 },
    });
  });

  it('does NOT emit the threshold flag below the configured threshold', async () => {
    process.env.IP_BLOCK_THRESHOLD = '5';
    const { audit, service } = makeDeps({ banMatch: true, count: 3 });
    await service.assertNotIpBlocked({
      workspaceId: WS,
      userId: USER,
      clientIp: IP,
      mechanism: 'PUBLIC',
    });
    expect(audit.record).toHaveBeenCalledOnce();
    expect(audit.record.mock.calls[0][0].action).toBe(AuditAction.SUSPICIOUS_JOIN);
  });

  it('de-dups the threshold flag when one already exists within the prior 24h', async () => {
    // count=3 ≥ threshold 3 이지만 직전 24h 내 THRESHOLD flag 가 이미 1건 → 재기록 skip.
    const { audit, service } = makeDeps({ banMatch: true, count: 3, priorThresholdFlags: 1 });
    await service.assertNotIpBlocked({
      workspaceId: WS,
      userId: USER,
      clientIp: IP,
      mechanism: 'PUBLIC',
    });
    // SUSPICIOUS_JOIN 1건만 기록되고 THRESHOLD flag 는 추가되지 않는다(중복 큐 방지).
    expect(audit.record).toHaveBeenCalledOnce();
    expect(audit.record.mock.calls[0][0].action).toBe(AuditAction.SUSPICIOUS_JOIN);
  });

  it('does NOT throw (soft-allow) when the suspicious-join audit write fails (best-effort)', async () => {
    // security LOW #3 / perf P2: audit DB 실패가 정상 PUBLIC/INVITE 가입을 막아선 안 된다.
    const { service } = makeDeps({ banMatch: true, count: 1, auditThrows: true });
    const result = await service.assertNotIpBlocked({
      workspaceId: WS,
      userId: USER,
      clientIp: IP,
      mechanism: 'PUBLIC',
    });
    // 예외 없이 통과하고 ipHash 를 정상 반환한다(가입 흐름 비차단).
    expect(result.ipHash).toBe(hashIp(IP));
  });
});
