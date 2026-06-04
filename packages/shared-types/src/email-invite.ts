import { z } from 'zod';
import { WorkspaceRoleSchema, WorkspaceSchema } from './workspace';

/**
 * S68 (D13 / FR-W04·W04a·W18): 이메일 직접 초대 + 보류 초대 관리 컨트랙트.
 *
 * 보안 불변식(★핵심 AC):
 *   - rawToken 은 이메일/링크에만 실리고 DB 엔 sha256(rawToken) = tokenHash 만 저장한다.
 *   - 수락 4분기 중 미가입 분기는 rawToken 을 서버에서 단기(10분) opaque 코드로 교환하고,
 *     회원가입 URL 엔 opaque 코드만 둔다(rawToken URL/로그 평문 미노출).
 *   - 수락 시 token role ↔ DB role 대조가 불일치하면 400(EMAIL_INVITE_ROLE_MISMATCH).
 */

// FR-W04: 한 번에 최대 50개 이메일을 일괄 초대한다.
export const EMAIL_INVITE_MAX_BATCH = 50;

// FR-W04: 이메일 초대는 발급 + 30일 후 만료된다(초/일 단위는 서버가 계산).
export const EMAIL_INVITE_TTL_DAYS = 30;

// FR-W04a: 미가입 분기에서 rawToken 을 교환한 opaque 코드의 수명(10분).
export const EMAIL_INVITE_OPAQUE_TTL_SEC = 10 * 60;

// FR-W04: 직접 초대 가능한 역할 — MEMBER 또는 GUEST 만(OWNER/ADMIN/MODERATOR 직접 초대 금지).
export const EmailInviteRoleSchema = z.enum(['MEMBER', 'GUEST']);
export type EmailInviteRole = z.infer<typeof EmailInviteRoleSchema>;

// FR-W04: 일괄 이메일 초대 요청. 이메일은 소문자 정규화 전 형태를 허용하되 서버가 정규화한다.
export const InviteByEmailRequestSchema = z.object({
  emails: z.array(z.string().email().max(254)).min(1).max(EMAIL_INVITE_MAX_BATCH),
  role: EmailInviteRoleSchema.default('MEMBER'),
});
export type InviteByEmailRequest = z.infer<typeof InviteByEmailRequestSchema>;

// FR-W04: 일괄 초대 결과 1건. outcome 으로 가입자 직접 추가/보류 초대 생성/실패를 구분한다.
//   ADDED_MEMBER  — 이미 가입된 이메일 → WorkspaceMember 직접 생성됨.
//   PENDING       — 미가입 이메일 → WorkspacePendingInvite 행 + 안내 메일.
//   ALREADY_MEMBER— 이미 이 워크스페이스 멤버 → 무시.
//   ALREADY_PENDING — 이미 활성 보류 초대 존재 → 무시(중복 발송 방지).
//   FAILED        — 발송/처리 실패(error 사유 포함, 부분성공 응답).
export const EmailInviteOutcomeSchema = z.enum([
  'ADDED_MEMBER',
  'PENDING',
  'ALREADY_MEMBER',
  'ALREADY_PENDING',
  'FAILED',
]);
export type EmailInviteOutcome = z.infer<typeof EmailInviteOutcomeSchema>;

export const EmailInviteResultRowSchema = z.object({
  email: z.string(),
  outcome: EmailInviteOutcomeSchema,
  // FAILED 일 때만 채워지는 사유(부분성공 응답의 오류목록). 그 외엔 생략.
  error: z.string().optional(),
});
export type EmailInviteResultRow = z.infer<typeof EmailInviteResultRowSchema>;

// FR-W04: 부분성공 응답 — 성공/보류/실패를 한 응답으로 담는다(개별 실패가 전체를 막지 않음).
export const InviteByEmailResponseSchema = z.object({
  results: z.array(EmailInviteResultRowSchema),
  // 집계(클라가 토스트 문구를 재계산하지 않게 서버가 내려준다).
  sentCount: z.number().int().nonnegative(),
  addedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
});
export type InviteByEmailResponse = z.infer<typeof InviteByEmailResponseSchema>;

// FR-W04a: rawToken 으로 직접 수락(가입+이메일 일치 / 다른 계정 로그인 분기 ②③).
export const AcceptEmailInviteRequestSchema = z.object({
  token: z.string().min(1).max(256),
});
export type AcceptEmailInviteRequest = z.infer<typeof AcceptEmailInviteRequestSchema>;

// FR-W04a 분기 ①: 미가입 초대의 rawToken 을 단기 opaque 코드로 교환한다(회원가입 리다이렉트).
// 응답 URL/쿼리엔 opaque 코드만 노출되고 rawToken 은 서버 교환 후 폐기된다.
export const ExchangeEmailInviteRequestSchema = z.object({
  token: z.string().min(1).max(256),
});
export type ExchangeEmailInviteRequest = z.infer<typeof ExchangeEmailInviteRequestSchema>;

export const ExchangeEmailInviteResponseSchema = z.object({
  // 회원가입 페이지가 쿼리파라미터로 들고 다닐 단기 opaque 코드(rawToken 아님).
  opaqueCode: z.string(),
  // 안내 표시용 — 가입 안내 화면에서 워크스페이스 이름/이메일을 보여준다.
  email: z.string().email(),
  workspaceName: z.string(),
  expiresAt: z.string().datetime(),
});
export type ExchangeEmailInviteResponse = z.infer<typeof ExchangeEmailInviteResponseSchema>;

// FR-W04: 수락(직접/opaque 모두) 성공 응답 — 가입한 워크스페이스. 초대 링크 수락과 동일 shape.
export const AcceptEmailInviteResponseSchema = z.object({
  workspace: WorkspaceSchema,
  alreadyMember: z.boolean(),
});
export type AcceptEmailInviteResponse = z.infer<typeof AcceptEmailInviteResponseSchema>;

// FR-W18: 보류 초대 1건(관리 목록 행). tokenHash 는 절대 응답에 싣지 않는다(평문/해시 모두 비노출).
export const PendingInviteSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  email: z.string().email(),
  role: WorkspaceRoleSchema,
  expiresAt: z.string().datetime(),
  lastSentAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  // 서버가 계산해 내려주는 파생 — 만료/취소/수락 여부를 FE 가 재계산하지 않게 한다.
  expired: z.boolean(),
  invitedBy: z.object({ id: z.string().uuid(), username: z.string() }).nullable().optional(),
});
export type PendingInvite = z.infer<typeof PendingInviteSchema>;

export const ListPendingInvitesResponseSchema = z.object({
  pending: z.array(PendingInviteSchema),
});
export type ListPendingInvitesResponse = z.infer<typeof ListPendingInvitesResponseSchema>;

// FR-W18: 개별 보류 초대 액션(연장 +30일 / 재발송). 취소는 DELETE 라 바디 없음.
export const PendingInviteActionSchema = z.enum(['EXTEND', 'RESEND']);
export type PendingInviteAction = z.infer<typeof PendingInviteActionSchema>;

export const UpdatePendingInviteRequestSchema = z.object({
  action: PendingInviteActionSchema,
});
export type UpdatePendingInviteRequest = z.infer<typeof UpdatePendingInviteRequestSchema>;
