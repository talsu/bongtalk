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
