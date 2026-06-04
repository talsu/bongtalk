import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { AuditService, AuditAction } from '../../common/audit/audit.service';
import { hashIp } from '../../common/ip-hash';

/**
 * S72 (D13 / FR-W22): IP soft-block.
 *
 * 가입/초대 수락 진입점에서 요청 IP 의 해시를 워크스페이스 차단 IP(BannedMember.ipHash —
 * 멤버 ban 시 그 멤버의 마지막 가입 ipHash 가 복사됨)와 대조한다. 매칭 시 처리는 가입
 * 방식에 따라 갈린다:
 *
 *   - APPLY(가입 신청) 매칭  → **403 차단**. 신청은 관리자 승인 게이트라, 차단 IP 에서
 *     온 신청을 즉시 막아도 NAT 공유 오탐의 피해가 작다(신청자가 다시 신청하면 됨).
 *   - PUBLIC/INVITE 매칭      → **허용(soft)** + AuditLog(SUSPICIOUS_JOIN) 기록. 즉시
 *     가입/초대 수락을 IP 만으로 막으면 NAT/캐리어 공유 사용자가 광범위하게 오탐 차단되므로
 *     hard-block 하지 않는다(★FR-W22 — userId ban 만 hard). 대신 의심 신호를 감사 로그로
 *     남겨 모더레이터가 사후 검토할 수 있게 한다.
 *
 * 24h threshold: SUSPICIOUS_JOIN 을 기록한 뒤 동일 ipHash 의 최근 24시간 내 SUSPICIOUS_JOIN
 * 건수가 IP_BLOCK_THRESHOLD(기본 3) 이상이면 모더레이션 알림(AuditLog SUSPICIOUS_JOIN_
 * THRESHOLD flag)을 한 번 더 남긴다 — 같은 차단 IP 풀에서 반복 가입 시도가 이뤄지고 있음을
 * 운영자에게 알린다.
 */
export type JoinMechanism = 'PUBLIC' | 'INVITE' | 'APPLY';

const DEFAULT_IP_BLOCK_THRESHOLD = 3;

@Injectable()
export class IpSoftBlockService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** IP_BLOCK_THRESHOLD env(기본 3). 1 미만/비수치는 기본값으로 폴백한다. */
  private get threshold(): number {
    const raw = Number(process.env.IP_BLOCK_THRESHOLD ?? DEFAULT_IP_BLOCK_THRESHOLD);
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_IP_BLOCK_THRESHOLD;
  }

  /**
   * 가입/초대 수락 직전 IP soft-block 게이트. 진입점이 요청 IP(req.ip 계열) 와 가입 방식을
   * 넘긴다. IP 가 미상이면(null 해시) 게이트는 무동작(통과) — 미상 IP 를 단일 해시로 묶어
   * 오탐하지 않는다.
   *
   * 반환값으로 이 진입에 기록할 ipHash 를 돌려준다(WorkspaceMember.ipHash 기록용). 차단되는
   * APPLY 경로는 throw 하므로 반환에 도달하지 않는다.
   */
  async assertNotIpBlocked(args: {
    workspaceId: string;
    userId: string;
    clientIp: string | undefined | null;
    mechanism: JoinMechanism;
    now?: Date;
  }): Promise<{ ipHash: string | null }> {
    const ipHash = hashIp(args.clientIp);
    if (ipHash === null) {
      // 미상 IP — 대조 불가, soft-block 무동작(통과). 기록할 해시도 없다.
      return { ipHash: null };
    }

    const matched = await this.prisma.bannedMember.findFirst({
      where: { workspaceId: args.workspaceId, ipHash },
      select: { userId: true },
    });
    if (!matched) {
      return { ipHash };
    }

    if (args.mechanism === 'APPLY') {
      // APPLY 매칭은 즉시 차단한다. 차단 IP 사실 누출을 피하기 위해(IP 차단 여부를 외부에
      // 드러내지 않음) 신청 부적용과 동일한 중립 코드(APPLICATION_NOT_APPLICABLE · 409)로
      // 거부한다 — 신규 ErrorCode 를 만들지 않는다(★확정 설계).
      throw new DomainError(
        ErrorCode.APPLICATION_NOT_APPLICABLE,
        'this workspace does not accept applications',
      );
    }

    // PUBLIC/INVITE 매칭 → 허용(soft) + 의심 가입 감사 기록 + 24h threshold 평가.
    await this.recordSuspiciousJoin({
      workspaceId: args.workspaceId,
      userId: args.userId,
      ipHash,
      now: args.now ?? new Date(),
    });
    return { ipHash };
  }

  /**
   * SUSPICIOUS_JOIN 감사 1행 기록 + 24h threshold 평가. best-effort 가 아니라(감사 무결성)
   * 호출자의 가입 흐름과는 분리된 별도 기록이다 — soft-allow 이므로 가입 자체는 이미 확정됐고,
   * 이 기록 실패가 가입을 되돌리지 않는다. actorId/targetId 모두 가입 당사자 userId 다(자가
   * 가입 — 별도 액터 없음). details 에 ipHash·mechanism 을 싣는다.
   */
  private async recordSuspiciousJoin(args: {
    workspaceId: string;
    userId: string;
    ipHash: string;
    now: Date;
  }): Promise<void> {
    await this.audit.record({
      workspaceId: args.workspaceId,
      actorId: args.userId,
      action: AuditAction.SUSPICIOUS_JOIN,
      targetId: args.userId,
      ipHash: args.ipHash,
      details: { ipMatch: true },
    });

    // 동일 ipHash 의 최근 24h SUSPICIOUS_JOIN 건수(방금 기록분 포함)를 센다 —
    // (workspaceId, ipHash, createdAt) 인덱스를 탄다.
    const since = new Date(args.now.getTime() - 24 * 60 * 60 * 1000);
    const count = await this.prisma.auditLog.count({
      where: {
        workspaceId: args.workspaceId,
        ipHash: args.ipHash,
        action: AuditAction.SUSPICIOUS_JOIN,
        createdAt: { gte: since },
      },
    });
    if (count >= this.threshold) {
      // 모더레이션 알림 flag. ModerationReport 는 message 바인딩이라 IP 신호에 맞지 않으므로
      // AuditLog flag(SUSPICIOUS_JOIN_THRESHOLD)로 재사용한다(★확정 설계 — AuditLog flag).
      await this.audit.record({
        workspaceId: args.workspaceId,
        actorId: args.userId,
        action: AuditAction.SUSPICIOUS_JOIN_THRESHOLD,
        targetId: args.userId,
        ipHash: args.ipHash,
        details: { count, threshold: this.threshold, windowHours: 24 },
      });
    }
  }

  /**
   * 멤버 ban 집행 시 대상 멤버의 마지막 가입 ipHash 를 BannedMember.ipHash 로 복사할 값을
   * 읽어준다(ModerationService.ban 이 같은 트랜잭션에서 호출). 멤버가 없거나 ipHash 미기록이면
   * null(IP 신호 없음 — userId ban 만으로 충분).
   */
  async memberIpHash(
    client: Prisma.TransactionClient | PrismaService,
    workspaceId: string,
    userId: string,
  ): Promise<string | null> {
    const member = await client.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { ipHash: true },
    });
    return member?.ipHash ?? null;
  }
}
