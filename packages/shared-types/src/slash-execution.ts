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
// kind='dm' — `/msg` 가 연 DM(DIRECT) 채널로의 이동. 웹 DM 라우트는 `/dm/:userId` 형태라
// userId 로 라우팅하고 channelId 는 식별/디버깅 보조다(서버가 이미 해석한 대상).
export const ExecuteSlashNavigateDmSchema = z.object({
  kind: z.literal('dm'),
  channelId: z.string().uuid(),
  userId: z.string().uuid(),
});

// S81c (D15 / FR-SC-10): kind='channel' — 커스텀 REDIRECT_CHANNEL 액션이 가리키는 일반 채널로의
// 이동. 서버가 본인 접근 가능 여부를 검증한 뒤에만 이 navigate 를 싣는다(IDOR 방지). DM 과 달리
// userId 가 없으므로 discriminated union 으로 분리한다(FE 는 kind 로 라우트를 분기).
//
// S81c 리뷰 fix-forward(MAJOR-1 / a11y SC-1): 채널 canonical 웹 라우트는 `/w/:slug/:channelName`
// 이다(ChannelList/ChannelBrowser 등 전부 동일). 기존엔 channelId 만 실어 FE 가 존재하지 않는
// `/c/:channelId` 로 navigate → catch-all `*`→`/` 로 튕겨 기능이 작동하지 않았다. 서버가 이미
// 채널을 로드(loadChannelMeta)하므로, 그 워크스페이스 slug + 채널 name 을 payload 에 실어 FE 가
// 새 라우트 없이 기존 채널 경로로 바로 이동하게 한다. channelId 는 식별/디버깅 보조로 유지한다
// (dm 변형과 동일 — userId 로 라우팅, channelId 보조).
export const ExecuteSlashNavigateChannelSchema = z.object({
  kind: z.literal('channel'),
  channelId: z.string().uuid(),
  // 워크스페이스 slug — `/w/:slug/:channelName` 라우트의 첫 세그먼트.
  slug: z.string().min(1),
  // 채널 name(표시명 displayName 이 아니라 라우트 식별 name) — 두 번째 세그먼트.
  channelName: z.string().min(1),
});

// 이동 대상. 현재 DM(전역) + 일반 채널(REDIRECT_CHANNEL). 향후 스레드 등 확장 여지를 위해 union.
export const ExecuteSlashNavigateSchema = z.discriminatedUnion('kind', [
  ExecuteSlashNavigateDmSchema,
  ExecuteSlashNavigateChannelSchema,
]);
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
// security HIGH-1 (S81b 리뷰): gifUrl/gifThumbUrl 은 채널 게시(unfurl) · <img src>
// 로 직접 쓰이므로 javascript:/data: 등 비-https 스킴을 계약 수준에서 차단한다
// (defense-in-depth — 서버 프록시도 동일 검증). https 전용 GIF URL 만 허용.
const HttpsUrl = z
  .string()
  .url()
  .refine((v) => v.startsWith('https://'), 'https only');

export const ExecuteSlashGiphyPreviewResponseSchema = z.object({
  responseType: z.literal('GIPHY_PREVIEW'),
  // 채널 게시 시 사용할 원본 GIF URL(GIPHY images.original.url).
  gifUrl: HttpsUrl,
  // 프리뷰에 표시할 썸네일 URL(GIPHY images.fixed_width.url).
  gifThumbUrl: HttpsUrl,
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
  // security HIGH-1 (S81b 리뷰): https 전용(위 ExecuteSlashGiphyPreviewResponse 와 동일 규칙).
  gifUrl: HttpsUrl,
  gifThumbUrl: HttpsUrl,
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
