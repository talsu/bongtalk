import { z } from 'zod';

/**
 * S64 (D12 / FR-RM12): 감사 로그 조회(audit-log) 단일 출처(shared-types).
 *
 * VIEW_AUDIT_LOG 권한은 별도 비트를 신설하지 않는다(★결정 B) — ADMIN+ enum 계층
 * 게이트(actor.isAdministrator || workspaceRole ∈ {ADMIN,OWNER})로 컨트롤러/서비스가
 * 직접 검사한다. AuditLog 스키마는 변경하지 않는다(★결정 A · details Json 유지).
 * cursor 페이지네이션 + action/actor 필터만 정의한다.
 */

/** S64 (FR-RM12): 감사 로그 한 페이지 기본/최대 항목 수. */
export const AUDIT_LOG_PAGE_DEFAULT = 50;
export const AUDIT_LOG_PAGE_MAX = 100;

/**
 * S64 (FR-RM12): 알려진 감사 action 키(FE 한국어 라벨 매핑). 백엔드 AuditAction 상수와
 * 짝을 이룬다. 미지정 키는 FE 가 raw action 문자열을 그대로 표시한다(forward-compat).
 */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  ADMINISTRATOR_CHANNEL_BYPASS: '관리자 채널 우회',
  MEMBER_KICK: '멤버 강제 퇴장',
  MEMBER_BAN: '멤버 차단',
  MEMBER_UNBAN: '차단 해제',
  MEMBER_TIMEOUT: '멤버 타임아웃',
  MEMBER_UNTIMEOUT: '타임아웃 해제',
  MEMBER_ROLE_UPDATE: '멤버 역할 변경',
  MEMBER_BULK_ACTION: '멤버 일괄 관리',
  ROLE_CREATE: '역할 생성',
  ROLE_UPDATE: '역할 수정',
  ROLE_DELETE: '역할 삭제',
  CHANNEL_PERMISSION_OVERRIDE_SET: '채널 권한 오버라이드 설정',
  MESSAGE_DELETE: '메시지 삭제',
  BULK_MESSAGE_DELETE: '메시지 일괄 삭제',
  SLOWMODE_UPDATE: '슬로우모드 변경',
  PRIVILEGE_ESCALATION_DENIED: '권한 상승 거부',
  REPORT_RESOLVE: '신고 처리',
  INVITE_DELETED: '초대 영구 삭제',
  // S72 (D13 / FR-W22): IP soft-block 감사 액션 라벨(감사 로그 UI raw enum 노출 방지).
  SUSPICIOUS_JOIN: '의심 가입',
  SUSPICIOUS_JOIN_THRESHOLD: '의심 가입 임계값 도달',
};

/** S64 (FR-RM12): 감사 로그 항목 DTO. details 는 임의 컨텍스트(Json). */
export const AuditLogEntrySchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  actorId: z.string().uuid(),
  action: z.string(),
  targetId: z.string().uuid().nullable(),
  channelId: z.string().uuid().nullable(),
  details: z.unknown().nullable(),
  createdAt: z.string().datetime(),
  /** 액터 표시 정보(사용자 삭제 시 null). */
  actor: z
    .object({
      id: z.string().uuid(),
      username: z.string(),
    })
    .nullable(),
});
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

/**
 * S64 (FR-RM12): 감사 로그 조회 쿼리. cursor 는 opaque base64url(JSON{createdAt,id})
 * 다음 페이지 토큰. action/actor 필터는 선택.
 */
export const ListAuditLogsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(AUDIT_LOG_PAGE_MAX).optional(),
  action: z.string().max(64).optional(),
  actorId: z.string().uuid().optional(),
});
export type ListAuditLogsQuery = z.infer<typeof ListAuditLogsQuerySchema>;

/** S64 (FR-RM12): 감사 로그 cursor 페이지 응답. nextCursor null = 마지막 페이지. */
export const ListAuditLogsResponseSchema = z.object({
  entries: z.array(AuditLogEntrySchema),
  nextCursor: z.string().nullable(),
});
export type ListAuditLogsResponse = z.infer<typeof ListAuditLogsResponseSchema>;
