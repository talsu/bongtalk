import { z } from 'zod';
import { ResponseTypeSchema } from './slash-command';

/**
 * S80 (D15 / FR-SC-04·05·06 + FR-RC18) — 슬래시 커맨드 *실행* 컨트랙트.
 *
 * S79 는 자동완성 목록(SlashCommandItem) 까지만 다뤘다. S80 은 실제 실행 엔드포인트
 * (POST /channels/:chid/slash-commands/execute) 의 요청/응답 + /remind 가 만드는
 * Reminder 모델의 read DTO 를 정의한다.
 *
 * 응답 분기(FR-SC-04·05·06):
 *   - IN_CHANNEL  — `/shrug`·`/tableflip`·`/unflip`·`/me`. 서버가 텍스트 변환 후
 *                   기존 MessagesService.send 로 채널에 게시하고, 생성된 messageId 만
 *                   동기 응답한다(실제 표시는 message:created WS 가 담당).
 *   - EPHEMERAL   — `/away`·`/active`·`/dnd`·`/status`·`/remind`. 발신자 전용 확인
 *                   메시지(content) 를 HTTP 동기 응답으로 돌려준다(채널 미게시). 실패
 *                   (예: /remind 파싱 불가)면 error 필드에 사람이 읽는 사유를 담는다.
 */

// 요청 본문. command 는 sigil 제외 커맨드명(최대 32자) + 점/숫자 여지(33). text 는
// 커맨드 인자(예: /remind 의 자연어). idempotencyKey 는 멱등 재시도용 uuid.
export const ExecuteSlashCommandRequestSchema = z.object({
  // BUILTIN_COMMANDS / 커스텀 name 은 ≤32자. 방어적으로 33 까지 허용해 경계 입력이
  // 길이 검증이 아니라 "알 수 없는 커맨드"(SLASH_COMMAND_UNKNOWN)로 떨어지게 한다.
  command: z.string().min(1).max(33),
  // 메시지 본문 상한(4000) - 가장 긴 sigil 토큰(`/tableflip ` 등) 여유분. 변환 후
  // 본문이 4000 을 넘지 않도록 보수적으로 3967 로 둔다.
  text: z.string().max(3967),
  idempotencyKey: z.string().uuid(),
});
export type ExecuteSlashCommandRequest = z.infer<typeof ExecuteSlashCommandRequestSchema>;

// IN_CHANNEL 응답 — 채널에 게시한 메시지 id.
export const ExecuteSlashInChannelResponseSchema = z.object({
  responseType: z.literal('IN_CHANNEL'),
  messageId: z.string().uuid(),
});
export type ExecuteSlashInChannelResponse = z.infer<typeof ExecuteSlashInChannelResponseSchema>;

// EPHEMERAL 응답 — 발신자 전용 확인/에러. content 는 항상 채워지고(성공·실패 공통
// 사용자 메시지), error=true 면 실패(구문 예시 등)를 의미한다.
//
// S81a (D15 / FR-SC-08): `/msg @사람` 은 DM 채널을 열고(필요시 생성) 발신자에게만 확인
// 메시지를 돌려주는 EPHEMERAL 이되, 클라이언트가 그 DM 으로 이동해야 한다. navigate 필드에
// 이동 대상(DM 채널 id)을 실어, FE 가 ephemeral 확인을 띄운 뒤 해당 DM 으로 라우팅한다.
// 비-`/msg` EPHEMERAL 응답은 navigate 를 생략한다(기존 계약 무변경).
export const ExecuteSlashNavigateSchema = z.object({
  // 이동 대상 종류. 현재는 DM 채널만(전역 DM). 향후 채널/스레드 확장 여지를 위해 enum.
  kind: z.literal('dm'),
  // 이동할 DM(DIRECT) 채널 id.
  channelId: z.string().uuid(),
  // DM 상대 userId. 웹 DM 라우트는 `/dm/:userId` 형태(userId 기반)라, FE 가 이 값으로
  // 라우팅하고 channelId 는 식별/디버깅 보조다(서버가 이미 해석한 대상).
  userId: z.string().uuid(),
});
export type ExecuteSlashNavigate = z.infer<typeof ExecuteSlashNavigateSchema>;

export const ExecuteSlashEphemeralResponseSchema = z.object({
  responseType: z.literal('EPHEMERAL'),
  content: z.string(),
  // 실패(파싱 불가 등)면 true. 성공 확인이면 생략/false.
  error: z.boolean().optional(),
  // S81a (FR-SC-08): `/msg` 가 연 DM 으로의 클라이언트 네비게이션 대상(선택). 없으면 이동 없음.
  navigate: ExecuteSlashNavigateSchema.optional(),
});
export type ExecuteSlashEphemeralResponse = z.infer<typeof ExecuteSlashEphemeralResponseSchema>;

// ── S81b (D15 / FR-SC-07): /giphy 실행 — 발신자 전용 GIF 프리뷰 응답 ─────────────
//
// `/giphy [키워드]` 실행 시 서버가 GIPHY Search API 를 프록시해 GIF 한 개를 골라
// 발신자에게만 ephemeral 프리뷰로 돌려준다(채널 미게시). FE 는 이 응답을 받아 썸네일 +
// "Powered By GIPHY" attribution + [Shuffle][Send][Cancel] 을 인라인으로 렌더한다.
//   - Shuffle → POST .../giphy/search { keyword, offset: 이전+1 } 로 다른 GIF 재요청.
//   - Send    → gifUrl 을 일반 메시지로 채널 게시(기존 send 경로 — S60 unfurl 이 인라인 렌더).
//   - Cancel  → 프리뷰 로컬 제거(서버 호출 없음).
// keyword/offset 을 함께 실어 FE 가 Shuffle 시 같은 키워드의 다음 offset 을 요청한다.
export const ExecuteSlashGiphyPreviewResponseSchema = z.object({
  responseType: z.literal('GIPHY_PREVIEW'),
  // 채널 게시 시 사용할 원본 GIF URL(GIPHY images.original.url).
  gifUrl: z.string().url(),
  // 프리뷰에 표시할 썸네일 URL(GIPHY images.fixed_width.url).
  gifThumbUrl: z.string().url(),
  // GIF 제목(접근성 alt / 표시 보조). GIPHY title 이 비면 빈 문자열.
  title: z.string(),
  // 검색 키워드(Shuffle 재요청에 재사용). 빈 키워드는 EPHEMERAL 안내로 분기하므로 ≥1.
  keyword: z.string().min(1).max(100),
  // 현재 결과의 offset(Shuffle 시 +1 해 다음 GIF 요청).
  offset: z.number().int().nonnegative(),
});
export type ExecuteSlashGiphyPreviewResponse = z.infer<
  typeof ExecuteSlashGiphyPreviewResponseSchema
>;

export const ExecuteSlashCommandResponseSchema = z.discriminatedUnion('responseType', [
  ExecuteSlashInChannelResponseSchema,
  ExecuteSlashEphemeralResponseSchema,
  ExecuteSlashGiphyPreviewResponseSchema,
]);
export type ExecuteSlashCommandResponse = z.infer<typeof ExecuteSlashCommandResponseSchema>;

// ── S81b (D15 / FR-SC-07): POST .../giphy/search — Shuffle 재요청 ────────────────
//
// 프리뷰의 Shuffle 버튼이 같은 키워드의 다른 GIF(offset 증가)를 받기 위해 호출한다.
// 서버는 GIPHY Search API 를 프록시(API 키는 서버 env 만 — 클라 노출 금지)하고 단일
// GIF 의 url/thumb/title 을 돌려준다. keyword 는 ≤100자, offset 은 기본 0.
export const GiphySearchRequestSchema = z.object({
  keyword: z.string().min(1).max(100),
  offset: z.number().int().nonnegative().max(4999).optional(),
});
export type GiphySearchRequest = z.infer<typeof GiphySearchRequestSchema>;

export const GiphySearchResponseSchema = z.object({
  gifUrl: z.string().url(),
  gifThumbUrl: z.string().url(),
  title: z.string(),
});
export type GiphySearchResponse = z.infer<typeof GiphySearchResponseSchema>;

// responseType 재노출 편의(execute 호출부가 slash-command.ts 를 따로 import 하지 않도록).
export { ResponseTypeSchema };

// ── /remind Reminder 모델 (FR-SC-06) ────────────────────────────────────────
/**
 * Reminder 상태 머신:
 *   PENDING   — 예약됨(BullMQ 지연잡 등록). scheduledAt 도래 시 발화.
 *   SENT      — 발화 완료(reminder:fire emit + 상태 전이). 멱등 — 재시도/재기동에도 1회.
 *   CANCELLED — 사용자가 DELETE 로 취소(BullMQ 잡도 제거).
 */
export const ReminderStatusSchema = z.enum(['PENDING', 'SENT', 'CANCELLED']);
export type ReminderStatus = z.infer<typeof ReminderStatusSchema>;

// GET /users/me/reminders 의 단일 항목.
export const ReminderItemSchema = z.object({
  id: z.string().uuid(),
  // 발화 시 내비게이션할 채널(예약 시점의 채널). 채널 soft-delete 시 SetNull → null.
  channelId: z.string().uuid().nullable(),
  // 리마인드 본문(≤500자).
  message: z.string().max(500),
  // 예약 발화 시각(UTC ISO).
  scheduledAt: z.string().datetime(),
  status: ReminderStatusSchema,
  createdAt: z.string().datetime(),
});
export type ReminderItem = z.infer<typeof ReminderItemSchema>;

export const ReminderListResponseSchema = z.object({
  items: z.array(ReminderItemSchema),
});
export type ReminderListResponse = z.infer<typeof ReminderListResponseSchema>;

// POST /users/me/reminders 요청(execute 의 /remind 가 내부적으로 같은 로직 호출).
export const CreateReminderRequestSchema = z.object({
  // 자연어 시각 표현(chrono-node 가 파싱). 예: `tomorrow 10am`, `in 30 minutes`.
  when: z.string().min(1).max(200),
  message: z.string().min(1).max(500),
  // 발화 시 내비게이션 컨텍스트. execute 경로가 현재 채널 id 를 싣는다.
  channelId: z.string().uuid().nullable().optional(),
});
export type CreateReminderRequest = z.infer<typeof CreateReminderRequestSchema>;

// ── reminder:fire WS payload ─────────────────────────────────────────────────
// S80 reviewer L1 fix: reminder:fire 발화 payload 의 정본 스키마는 events.ts 의
// ReminderNewFirePayloadSchema 다(WS_EVENT_PAYLOAD_SCHEMAS 에 등록·processor/dispatcher 가
// 실제 사용). 여기 중복 정의돼 있던 ReminderFiredPayloadSchema 는 어디서도 import 되지
// 않는 dead 코드여서 제거했다(와이어 계약 단일원: events.ts).
