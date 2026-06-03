import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';

/**
 * S62 (D12 / FR-RM17): 모더레이션/관리 감사 로그 서비스(append-only).
 *
 * INSERT 전용 — 갱신/삭제 메서드를 제공하지 않는다(감사 무결성). S63 의 kick/ban/
 * timeout 도 이 서비스를 공유한다. `action` 은 넓은 String 키이며(AuditAction 상수
 * 참조) 후속 슬라이스가 마이그레이션 없이 새 키를 추가할 수 있다.
 *
 * 기록은 best-effort 가 아니라 호출자 책임이다 — 보안상 중요한 우회(ADMINISTRATOR
 * 채널 우회 등)는 해당 도메인 트랜잭션과 같은 tx 클라이언트로 기록해 원자성을
 * 보장할 수 있도록 `client` 인자를 받는다(미지정 시 기본 PrismaService).
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 감사 로그 1행을 INSERT 한다. actorId/action 은 필수, target/channel/details 는
   * 선택. 동일 도메인 트랜잭션 안에서 기록하려면 `client` 에 tx 를 넘긴다.
   */
  async record(
    entry: {
      workspaceId: string;
      actorId: string;
      action: string;
      targetId?: string | null;
      channelId?: string | null;
      details?: Prisma.InputJsonValue | null;
    },
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    await client.auditLog.create({
      data: {
        workspaceId: entry.workspaceId,
        actorId: entry.actorId,
        action: entry.action,
        targetId: entry.targetId ?? null,
        channelId: entry.channelId ?? null,
        details: entry.details ?? undefined,
      },
    });
  }

  /**
   * 보안 감사 기록이 도메인 액션을 절대 막지 않아야 하는 best-effort 경로용 헬퍼
   * (예: ADMINISTRATOR 채널 우회는 이미 허용된 액션이라, 감사 INSERT 실패가 송신
   * 자체를 깨면 안 된다). 실패는 warn 으로만 남긴다.
   */
  async recordBestEffort(entry: {
    workspaceId: string;
    actorId: string;
    action: string;
    targetId?: string | null;
    channelId?: string | null;
    details?: Prisma.InputJsonValue | null;
  }): Promise<void> {
    try {
      await this.record(entry);
    } catch (err) {
      this.logger.warn(
        `[audit] record failed action=${entry.action} ws=${entry.workspaceId}: ${String(err).slice(0, 160)}`,
      );
    }
  }
}

/**
 * S62 (FR-RM17): 알려진 감사 action 키. enum 대신 상수 객체로 두어(스키마 String)
 * 후속 슬라이스가 자유롭게 추가한다. S63 에서 MEMBER_KICK/BAN/TIMEOUT 등이 합류한다.
 */
export const AuditAction = {
  /** ADMINISTRATOR 비트 보유자가 채널 DENY overwrite 를 우회해 행동(send/upload/history). */
  ADMINISTRATOR_CHANNEL_BYPASS: 'ADMINISTRATOR_CHANNEL_BYPASS',
  // S63 (D12 / FR-RM05·06·07): 모더레이션 액션. targetId 는 대상 userId,
  // details 에 reason(있으면)·duration(timeout) 등 컨텍스트를 싣는다.
  /** FR-RM05: 멤버 강제 퇴장(WorkspaceMember 삭제 + WS disconnect). */
  MEMBER_KICK: 'MEMBER_KICK',
  /** FR-RM06: 멤버/비멤버 userId 영구 차단(BannedMember INSERT). */
  MEMBER_BAN: 'MEMBER_BAN',
  /** FR-RM06: 차단 해제(BannedMember DELETE). */
  MEMBER_UNBAN: 'MEMBER_UNBAN',
  /** FR-RM07: 멤버 임시 음소거(mutedUntil 설정). */
  MEMBER_TIMEOUT: 'MEMBER_TIMEOUT',
  /** FR-RM07: 음소거 수동 해제(mutedUntil null). */
  MEMBER_UNTIMEOUT: 'MEMBER_UNTIMEOUT',
} as const;

export type AuditActionKey = (typeof AuditAction)[keyof typeof AuditAction];
