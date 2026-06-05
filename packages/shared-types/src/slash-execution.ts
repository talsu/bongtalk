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
export const ExecuteSlashEphemeralResponseSchema = z.object({
  responseType: z.literal('EPHEMERAL'),
  content: z.string(),
  // 실패(파싱 불가 등)면 true. 성공 확인이면 생략/false.
  error: z.boolean().optional(),
});
export type ExecuteSlashEphemeralResponse = z.infer<typeof ExecuteSlashEphemeralResponseSchema>;

export const ExecuteSlashCommandResponseSchema = z.discriminatedUnion('responseType', [
  ExecuteSlashInChannelResponseSchema,
  ExecuteSlashEphemeralResponseSchema,
]);
export type ExecuteSlashCommandResponse = z.infer<typeof ExecuteSlashCommandResponseSchema>;

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
