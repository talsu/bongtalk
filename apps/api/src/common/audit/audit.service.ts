import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  AUDIT_LOG_PAGE_DEFAULT,
  AUDIT_LOG_PAGE_MAX,
  type AuditLogEntry,
  type ListAuditLogsResponse,
} from '@qufox/shared-types';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../errors/domain-error';
import { ErrorCode } from '../errors/error-code.enum';

/**
 * 072 백로그 S-G (FR-RM12): 감사 로그 details(Json) 에서 모더레이션 사유(reason)를
 * 전용 열로 평탄화한다. details 가 객체이고 reason 이 비어있지 않은 문자열일 때만 반환.
 */
export function extractAuditReason(details: unknown): string | null {
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    const r = (details as Record<string, unknown>).reason;
    if (typeof r === 'string' && r.trim().length > 0) return r;
  }
  return null;
}

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
      // S72 (D13 / FR-W22): SUSPICIOUS_JOIN 계열 액션의 요청 IP 해시(sha256 hex). 24h
      // threshold 카운트에 쓴다. 다른 액션은 생략(null).
      ipHash?: string | null;
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
        ipHash: entry.ipHash ?? null,
      },
    });
  }

  /**
   * S64 (FR-RM12): 감사 로그 조회(append-only read). VIEW_AUDIT_LOG 권한 게이트
   * (ADMIN+ enum 계층)는 컨트롤러가 끝낸 상태로 호출된다 — 서비스는 cursor 페이지네이션
   * + action/actor 필터만 수행한다. 정렬은 (createdAt DESC, id DESC) 최신순이며,
   * `[workspaceId, createdAt]` · `[workspaceId, action, createdAt]` 인덱스를 탄다.
   *
   * cursor 는 opaque base64url(JSON{createdAt,id}) 다음 페이지 토큰이다. limit+1 을
   * 읽어 다음 페이지 존재 여부를 판정하고, 초과분의 마지막 노출 행으로 nextCursor 를
   * 만든다(없으면 null = 마지막 페이지).
   */
  async listAuditLogs(args: {
    workspaceId: string;
    cursor?: string;
    limit?: number;
    action?: string;
    actorId?: string;
  }): Promise<ListAuditLogsResponse> {
    const take = Math.min(args.limit ?? AUDIT_LOG_PAGE_DEFAULT, AUDIT_LOG_PAGE_MAX);
    const where: Prisma.AuditLogWhereInput = { workspaceId: args.workspaceId };
    if (args.action) where.action = args.action;
    if (args.actorId) where.actorId = args.actorId;
    // cursor 키셋: (createdAt, id) < (cursorCreatedAt, cursorId) — DESC 순서.
    if (args.cursor) {
      const decoded = decodeAuditCursor(args.cursor);
      where.OR = [
        { createdAt: { lt: decoded.createdAt } },
        { createdAt: decoded.createdAt, id: { lt: decoded.id } },
      ];
    }
    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    // 072 백로그 S-G (FR-RM12): 실행자 + 대상(사용자) 표시 정보를 한 번에 batch 조회한다
    // (N+1 회피). actorId 는 항상 사용자, targetId 는 사용자일 수도/아닐 수도(메시지·역할
    // 등) 있어 User 조회에 매칭되는 것만 target 으로 해석하고 나머지는 null(FE targetId 폴백).
    const actorIds = page.map((r) => r.actorId);
    const targetIds = page.map((r) => r.targetId).filter((id): id is string => !!id);
    const userIds = Array.from(new Set([...actorIds, ...targetIds]));
    const users =
      userIds.length === 0
        ? []
        : await this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, username: true },
          });
    const userMap = new Map(users.map((u) => [u.id, u]));
    const entries: AuditLogEntry[] = page.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      actorId: r.actorId,
      action: r.action,
      targetId: r.targetId ?? null,
      channelId: r.channelId ?? null,
      details: (r.details as AuditLogEntry['details']) ?? null,
      createdAt: r.createdAt.toISOString(),
      actor: userMap.get(r.actorId) ?? null,
      // 대상이 사용자면 username 해석, 아니면 null(메시지/역할 등 — FE 가 targetId 표시).
      target: (r.targetId && userMap.get(r.targetId)) || null,
      // details.reason(모더레이션 사유)을 전용 열로 평탄화. 문자열일 때만.
      reason: extractAuditReason(r.details),
    }));
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeAuditCursor(last.createdAt, last.id) : null;
    return { entries, nextCursor };
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
    ipHash?: string | null;
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
  // S64 (D12 / FR-RM09·11·12): FR-RM12 감사 조회가 의미를 가지려면 아래 관리 액션들이
  // 실제로 기록돼야 한다. 종전 미기록 지점에 AuditService.record() 호출을 추가한다.
  /** FR-RM09: 채널 메시지 일괄 soft-delete. details.messageIds[] 배열 1행. */
  BULK_MESSAGE_DELETE: 'BULK_MESSAGE_DELETE',
  /** 개별 메시지 soft-delete(작성자 본인 외 모더레이터 삭제 포함). */
  MESSAGE_DELETE: 'MESSAGE_DELETE',
  /** 멤버 시스템 역할 enum 변경(MembersService.updateRole). */
  MEMBER_ROLE_UPDATE: 'MEMBER_ROLE_UPDATE',
  // S69 (D13 / FR-W11): 일괄 멤버 관리(kick/timeout/role) 단일 AuditLog(Fork A).
  // details 에 action·affected[]·skipped[]·duration(timeout)·role(role) 을 싣는다.
  /** FR-W11: 일괄 멤버 관리 액션(최대 100명·단일 tx). */
  MEMBER_BULK_ACTION: 'MEMBER_BULK_ACTION',
  /** FR-RM01/15: 커스텀 역할 생성. */
  ROLE_CREATE: 'ROLE_CREATE',
  /** FR-RM01: 커스텀 역할 수정. */
  ROLE_UPDATE: 'ROLE_UPDATE',
  /** FR-RM15: 커스텀 역할 삭제. */
  ROLE_DELETE: 'ROLE_DELETE',
  /** FR-RM03/14: 채널 권한 오버라이드 설정(USER/ROLE upsert). */
  CHANNEL_PERMISSION_OVERRIDE_SET: 'CHANNEL_PERMISSION_OVERRIDE_SET',
  // S64 fix-forward (reviewer M-2 = A-3): CHANNEL_PERMISSION_OVERRIDE_REMOVE 는 enum/label
  // 만 정의됐고 record 호출 경로가 없었다(관리자 override 삭제 엔드포인트 부재 —
  // leaveChannel 은 FR-CH-07 self-leave 라 의미가 다르다). dead key 를 제거한다. 향후
  // 관리자 override 해제 엔드포인트가 생기면 그 슬라이스에서 재도입한다.
  /** FR-CH-08: 채널 슬로우모드 간격 변경. */
  SLOWMODE_UPDATE: 'SLOWMODE_UPDATE',
  /** FR-RM04: 권한 상승 시도 거부(assertGrant/position 게이트 거부). */
  PRIVILEGE_ESCALATION_DENIED: 'PRIVILEGE_ESCALATION_DENIED',
  /** FR-RM11: 신고 처리(DISMISS/WARN/DELETE_MESSAGE/TIMEOUT/BAN). */
  REPORT_RESOLVE: 'REPORT_RESOLVE',
  // S67 fix-forward (security MEDIUM + reviewer #5): 초대 영구 삭제(hard delete).
  // 가역 soft revoke 와 달리 행을 제거하는 파괴적 액션이라 actor/inviteId/code 를 남겨
  // rogue admin 탐지가 가능하게 한다. details 에 code 를 싣는다.
  /** FR-W17 (Fork C-2): 초대 링크 영구 삭제. */
  INVITE_DELETED: 'INVITE_DELETED',
  // S72 (D13 / FR-W22): IP soft-block. 차단 IP(BannedMember.ipHash)에서 온 PUBLIC/INVITE
  // 가입을 허용하되(soft — NAT 오탐 방지) 감사 신호로 남긴다. ipHash 컬럼 + details.ipMatch.
  /** FR-W22: 차단 IP 에서의 의심 가입(PUBLIC/INVITE 허용 + 신호 기록). */
  SUSPICIOUS_JOIN: 'SUSPICIOUS_JOIN',
  /** FR-W22: 동일 차단 IP 의 24h SUSPICIOUS_JOIN 누적이 threshold 도달(모더레이션 알림). */
  SUSPICIOUS_JOIN_THRESHOLD: 'SUSPICIOUS_JOIN_THRESHOLD',
  // FR-RM10a (063): AutoMod 키워드 모더레이션. details 에 ruleId·keyword·action 을 싣고,
  // BLOCK/TIMEOUT 은 targetId=작성자(메시지 미저장), ALERT 은 저장된 메시지 컨텍스트를 남긴다.
  /** FR-RM10a: AutoMod 규칙 생성. */
  AUTOMOD_RULE_CREATE: 'AUTOMOD_RULE_CREATE',
  /** FR-RM10a: AutoMod 규칙 수정. */
  AUTOMOD_RULE_UPDATE: 'AUTOMOD_RULE_UPDATE',
  /** FR-RM10a: AutoMod 규칙 삭제. */
  AUTOMOD_RULE_DELETE: 'AUTOMOD_RULE_DELETE',
  /** FR-RM10a: BLOCK 액션 — 메시지를 저장하지 않고 거부(details.ruleId/keyword). */
  AUTOMOD_BLOCK: 'AUTOMOD_BLOCK',
  /** FR-RM10a: ALERT 액션 — 메시지는 저장하되 모더레이션 신호만 기록(details.ruleId/keyword). */
  AUTOMOD_ALERT: 'AUTOMOD_ALERT',
  /** FR-RM10a: TIMEOUT 액션 — 메시지 차단 + 작성자 타임아웃(details.ruleId/keyword/durationSeconds). */
  AUTOMOD_TIMEOUT: 'AUTOMOD_TIMEOUT',
} as const;

export type AuditActionKey = (typeof AuditAction)[keyof typeof AuditAction];

/**
 * S64 (FR-RM12): 감사 로그 cursor 인코드/디코드. 메시지 cursor 와 동일한 opaque
 * base64url(JSON{createdAt,id}) 포맷이되, 잘못된 토큰은 VALIDATION_FAILED(400)로
 * 거부한다(messages 의 MESSAGE_CURSOR_INVALID 와 도메인 분리).
 */
function encodeAuditCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id }), 'utf8').toString(
    'base64url',
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function decodeAuditCursor(raw: string): { createdAt: Date; id: string } {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, 'audit cursor empty or too long');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, 'audit cursor decode failed');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, 'audit cursor not an object');
  }
  const obj = parsed as Record<string, unknown>;
  const createdAt = obj.createdAt;
  const id = obj.id;
  if (
    typeof createdAt !== 'string' ||
    !ISO_DATETIME_RE.test(createdAt) ||
    !Number.isFinite(Date.parse(createdAt))
  ) {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, 'audit cursor.createdAt invalid');
  }
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new DomainError(ErrorCode.VALIDATION_FAILED, 'audit cursor.id must be a uuid');
  }
  return { createdAt: new Date(createdAt), id };
}
