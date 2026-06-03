import { z } from 'zod';

// S51 (D10 / FR-PS-07): 개인 저장함(Saved Messages) 컨트랙트.
//
// SavedMessage 는 철저히 개인 전용이며 Slack Later 3탭(진행 중 / 보관 / 완료)에 대응한다.
// S51 은 저장/해제/목록/카운트만 구현하므로 신규 저장은 항상 IN_PROGRESS 로 생성되고,
// 탭 간 이동(PATCH 상태 변경)은 S52/FR-PS-08 carryover 다. enum 자체는 3값을 모두
// 선언해 둔다.

// 개인 저장함 최대 항목 수. POST 시 IN_PROGRESS 가 아닌 전체 카운트가 이 값 이상이면
// 422 SAVED_LIMIT_EXCEEDED 로 거부한다(soft·advisory lock 불요·±1 drift 허용).
export const SAVED_LIMIT = 500;

export const SaveStatusSchema = z.enum(['IN_PROGRESS', 'ARCHIVED', 'COMPLETED']);
export type SaveStatus = z.infer<typeof SaveStatusSchema>;

// GET /me/saved 의 단일 항목. 전체 MessageDto(reaction/attachment 배치조인)를 싣지
// 않고 read-path 단순화를 위한 요약 shape 만 노출한다 — 원본 message excerpt(~150자) +
// author + channel 컨텍스트. 원본이 soft-delete/삭제됐으면 messageDeletedAt 이 채워지고
// excerpt 는 '[삭제된 메시지]' 로 마스킹된다.
export const SavedMessageDtoSchema = z.object({
  id: z.string().uuid(),
  messageId: z.string().uuid(),
  status: SaveStatusSchema,
  savedAt: z.string().datetime(),
  // 원본 메시지 soft-delete 시각(비정규화). null = 원본 살아 있음.
  messageDeletedAt: z.string().datetime().nullable(),
  // 원본 메시지 요약(≤150자). 삭제된 원본은 '[삭제된 메시지]' placeholder.
  excerpt: z.string(),
  // 원본 작성자 id. 삭제 메시지여도 작성자 컨텍스트는 보존(타임라인 식별용).
  authorId: z.string().uuid(),
  // 원본 채널 컨텍스트. DM/그룹 DM 은 channelName 이 dedup slug 일 수 있다.
  channelId: z.string().uuid(),
  channelName: z.string(),
  // S53 (D10 / FR-PS-09/10/11): 저장 리마인더 메타. 전부 nullable(미설정/미발화/
  // 미스누즈/메모 없음). reminderAt = 예약 발화 시각, reminderFiredAt = 실제 발화
  // 시각(놓친 리마인더 판정), snoozedUntil = 스누즈 재예약 시각, note = 사용자 메모.
  reminderAt: z.string().datetime().nullable().optional(),
  reminderFiredAt: z.string().datetime().nullable().optional(),
  snoozedUntil: z.string().datetime().nullable().optional(),
  note: z.string().nullable().optional(),
});
export type SavedMessageDto = z.infer<typeof SavedMessageDtoSchema>;

// GET /me/saved 응답. 커서 기반(savedAt DESC + id tie-break). nextCursor 가 null 이면
// 마지막 페이지.
export const SavedMessageListResponseSchema = z.object({
  items: z.array(SavedMessageDtoSchema),
  nextCursor: z.string().nullable(),
});
export type SavedMessageListResponse = z.infer<typeof SavedMessageListResponseSchema>;

// GET /me/saved/count 응답. 사이드바 "저장됨" 배지(IN_PROGRESS 카운트).
export const SavedCountResponseSchema = z.object({
  count: z.number().int().nonnegative(),
});
export type SavedCountResponse = z.infer<typeof SavedCountResponseSchema>;

// POST /me/saved/:messageId · DELETE /me/saved/:messageId 응답. 토글 후 상태를 돌려준다
// (saved=true 면 저장됨, false 면 해제됨). 낙관적 UI 가 북마크 아이콘을 즉시 갱신한다.
export const SaveToggleResponseSchema = z.object({
  saved: z.boolean(),
  savedMessageId: z.string().uuid().nullable(),
  status: SaveStatusSchema.nullable(),
});
export type SaveToggleResponse = z.infer<typeof SaveToggleResponseSchema>;

// S52 (D10 / FR-PS-08): PATCH /me/saved/:savedMessageId — 저장 항목의 탭(status) 이동.
// 임의 전이를 허용한다(IN_PROGRESS ↔ ARCHIVED ↔ COMPLETED). 한도(SAVED_LIMIT)는 기존
// 레코드 조작이라 재적용하지 않으며, 삭제된 원본(messageDeletedAt≠null) 항목도 전이를
// 허용한다(완료/보관 분류는 원본 생존과 무관). 응답은 갱신된 SavedMessageDto(요약 shape).
// ★경로 파라미터는 SavedMessage.id 다(DELETE 의 :messageId 와 의도된 비대칭 — 목록 항목은
// item.id 와 item.messageId 를 모두 보유한다).
export const UpdateSavedStatusBodySchema = z.object({
  status: SaveStatusSchema,
});
export type UpdateSavedStatusBody = z.infer<typeof UpdateSavedStatusBodySchema>;

// S53 (D10 / FR-PS-09/10/11): PATCH /me/saved/:savedMessageId 의 확장 body.
// S52 의 status-only 계약을 깨지 않도록(무회귀) 모든 필드를 optional 로 둔다 —
// S52 클라이언트는 `{ status }` 만 보내고, S53 클라이언트는 reminderAt/note 를
// 추가로 보낼 수 있다. 컨트롤러는 status 존재 시 탭 이동, reminderAt 존재 시
// 리마인더 설정/취소(null 이면 cancel)를 함께 처리한다.
//   - reminderAt: ISO datetime 문자열(설정) | null(취소). 미동봉 시 변경 없음.
//   - note: 사용자 메모(≤500자) | null(삭제). 미동봉 시 변경 없음.
// 적어도 한 필드는 있어야 한다(전부 미동봉이면 의미 없는 PATCH → 컨트롤러가 거부).
export const UpdateSavedMessageBodySchema = z
  .object({
    status: SaveStatusSchema.optional(),
    // S53 리뷰(security FINDING-3): reminderAt 은 미래(시계 오차 1분 유예) ~ 최대 1년
    // 이내여야 한다. 과거 시각 대량 PATCH 로 즉시-발화 job 을 Redis 큐에 쏟는 것을 차단
    // (서버 delay clamp 만으론 enqueue 폭주 가능). null 은 취소라 허용.
    reminderAt: z
      .string()
      .datetime()
      .nullable()
      .optional()
      .refine(
        (v) => {
          if (v == null) return true;
          const t = new Date(v).getTime();
          const now = Date.now();
          return t > now - 60_000 && t < now + 366 * 24 * 60 * 60_000;
        },
        { message: 'reminderAt must be a future time within ~1 year' },
      ),
    note: z.string().max(500).nullable().optional(),
  })
  .refine((b) => b.status !== undefined || b.reminderAt !== undefined || b.note !== undefined, {
    message: 'at least one of status/reminderAt/note is required',
  });
export type UpdateSavedMessageBody = z.infer<typeof UpdateSavedMessageBodySchema>;

// S53 (D10 / FR-PS-10): PATCH /me/saved/:savedMessageId/snooze — "10분 후 다시
// 알림". 현재는 단일 옵션(10분)만 지원하므로 z.literal(10) 으로 고정한다(잘못된
// 값은 400). 향후 30/60분 등 확장 시 z.union 으로 늘린다. 서버는 snoozedUntil =
// now + snoozeMinutes, reminderAt = snoozedUntil, reminderFiredAt = null 로
// 재예약한다(BullMQ reschedule).
export const SNOOZE_MINUTES = 10;
export const SnoozeReminderBodySchema = z.object({
  snoozeMinutes: z.literal(SNOOZE_MINUTES),
});
export type SnoozeReminderBody = z.infer<typeof SnoozeReminderBodySchema>;

// S52 (D10 / FR-PS-13): 메시지 툴바 북마크 채움 상태 일괄 초기화 상한. 채널 진입 시
// 렌더 중인 메시지 id 배치를 1회 조회해 북마크 채움을 seed 한다(N+1 단건 GET 금지).
export const SAVED_STATUS_BULK_LIMIT = 200;

// POST /me/saved/status-bulk 요청. 가시 메시지 id 배치(≤200). 본인 스코프로만 조회한다.
export const SavedStatusBulkRequestSchema = z.object({
  messageIds: z.array(z.string().uuid()).max(SAVED_STATUS_BULK_LIMIT),
});
export type SavedStatusBulkRequest = z.infer<typeof SavedStatusBulkRequestSchema>;

// POST /me/saved/status-bulk 응답. 호출자가 저장한(=어느 status 든 — Slack parity:
// 보관/완료 항목도 북마크 채움) messageId 집합. 요청에 없는 id 나 타인 저장은 포함되지
// 않는다(본인 스코프 + 교집합).
export const SavedStatusBulkResponseSchema = z.object({
  saved: z.array(z.string().uuid()),
});
export type SavedStatusBulkResponse = z.infer<typeof SavedStatusBulkResponseSchema>;
