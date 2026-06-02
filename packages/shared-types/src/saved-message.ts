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
