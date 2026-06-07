import { z } from 'zod';
import { MessageContentSchema } from './message';

/**
 * S84a (D16 / FR-RC11) — 인커밍 웹훅 / 봇 메시지 계약.
 *
 * 두 표면:
 *   1) 관리 REST(camelCase) — 워크스페이스 MANAGE_WEBHOOKS 보유자가 웹훅을 생성/목록/
 *      회전/삭제. 토큰 평문은 생성·회전 응답에서 1회만 내려간다(DB 엔 sha256 hex 만).
 *   2) 인커밍 게시 payload(snake_case · Discord 호환) — 토큰 인증으로 봇 메시지를
 *      게시하며 요청마다 username/avatar_url override 가능.
 *
 * 예약어(system/qufox/admin, 대소문자 무시)는 username/botDisplayName 으로 쓸 수 없다
 * (위반 시 422). 형식 검증(길이/URL)은 Zod 가, 예약어 거부는 서비스가 DomainError
 * (WEBHOOK_NAME_RESERVED → 422)로 처리한다 — ZodError(400)와 상태코드를 구분하기 위함.
 */

/** username/botDisplayName 로 금지되는 예약어(소문자 비교). */
export const RESERVED_BOT_NAMES: ReadonlySet<string> = new Set(['system', 'qufox', 'admin']);

/** 예약어 여부(대소문자·앞뒤공백 무시). 서비스 레이어 게이트에서 사용. */
export function isReservedBotName(name: string): boolean {
  return RESERVED_BOT_NAMES.has(name.trim().toLowerCase());
}

export const WEBHOOK_NAME_MAX = 80;
export const WEBHOOK_AVATAR_URL_MAX = 2048;

const WebhookNameSchema = z.string().trim().min(1).max(WEBHOOK_NAME_MAX);
// S84a 리뷰 fix-forward (security LOW-6 = SSRF hardening): avatar_url 은 클라이언트가
// 아바타 이미지로 렌더하므로 scheme 을 http/https 로 제한한다. z.string().url() 만으로는
// `file:`/`ftp:`/`http://169.254.169.254/...`(SSRF·내부망) 같은 scheme 도 통과하므로,
// 향후 DS Avatar 이미지 슬롯 도입 시 인증 없는 인커밍 게시자가 임의 fetch URL 을 모든
// 채널 뷰어에게 주입하는 표면을 미리 막는다. CreateWebhookRequest/인커밍 payload 공통.
const AvatarUrlSchema = z
  .string()
  .url()
  .max(WEBHOOK_AVATAR_URL_MAX)
  .refine((u) => /^https?:\/\//i.test(u), { message: 'avatar URL must be http(s)' });

// ── 1. 관리 REST ─────────────────────────────────────────────────────────────

/** POST /workspaces/:id/webhooks 요청. channelId = 게시 대상 채널. */
export const CreateWebhookRequestSchema = z.object({
  channelId: z.string().uuid(),
  name: WebhookNameSchema,
  botDisplayName: WebhookNameSchema.optional(),
  avatarUrl: AvatarUrlSchema.optional(),
});
export type CreateWebhookRequest = z.infer<typeof CreateWebhookRequestSchema>;

/** 웹훅 메타(토큰 평문/해시 절대 비노출). 목록/생성/회전 응답의 공통 본체. */
export const WebhookSummarySchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  channelId: z.string().uuid(),
  name: z.string(),
  botDisplayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  createdBy: z.string().uuid(),
  createdAt: z.string(), // ISO8601
  rotatedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
});
export type WebhookSummary = z.infer<typeof WebhookSummarySchema>;

/**
 * 생성·회전 응답: 메타 + 평문 토큰 1회 + 게시 URL.
 * token 은 이 응답에서만 노출되며 서버는 sha256(token) 만 저장한다(재조회 불가).
 */
export const WebhookCreatedResponseSchema = WebhookSummarySchema.extend({
  token: z.string(),
  /** 인커밍 게시 경로(상대). 예: /webhooks/:id?token=... 안내용. */
  postUrl: z.string(),
});
export type WebhookCreatedResponse = z.infer<typeof WebhookCreatedResponseSchema>;

/** GET /workspaces/:id/webhooks 응답. */
export const WebhookListResponseSchema = z.object({
  items: z.array(WebhookSummarySchema),
});
export type WebhookListResponse = z.infer<typeof WebhookListResponseSchema>;

// ── 2. 인커밍 게시 payload (Discord 호환 snake_case) ──────────────────────────

/**
 * POST /webhooks/:id 본문. content 는 필수(embed 배열은 S84b 에서 추가).
 * username/avatar_url 은 이 메시지 한정 표시 override(예약어 거부는 서비스 422).
 */
export const IncomingWebhookPayloadSchema = z.object({
  content: MessageContentSchema,
  username: z.string().trim().min(1).max(WEBHOOK_NAME_MAX).optional(),
  // eslint-disable-next-line @typescript-eslint/naming-convention
  avatar_url: AvatarUrlSchema.optional(),
});
export type IncomingWebhookPayload = z.infer<typeof IncomingWebhookPayloadSchema>;
