import { z } from 'zod';

/**
 * S85 (FR-CH-16): 사이드바 개인 섹션 컨트랙트.
 *
 * 멤버가 본인 사이드바에 채널 그룹(이름·이모지·정렬방식)을 만들고 채널을 할당한다.
 * 전부 개인 전용(타인 미노출)이며 섹션 간 순서·섹션 내 채널 순서는 fractional
 * position(서버 calcBetween, Decimal 직렬화 → string)으로 드래그 조정한다. 즐겨찾기
 * (S43)의 anchor(beforeId/afterId) 규약을 일반화한다.
 */

// 섹션 정렬 방식. MANUAL = 사용자가 정한 position 순서. ALPHABETICAL = 표시 시
// 채널명 가나다 정렬(클라가 렌더 시점에 적용, 저장 position 무관).
export const SidebarSectionSortModeSchema = z.enum(['MANUAL', 'ALPHABETICAL']);
export type SidebarSectionSortMode = z.infer<typeof SidebarSectionSortModeSchema>;

// 섹션 이름 1~100자, 이모지 ≤16자(유니코드 단일 이모지 + variation selector 여유분).
export const SidebarSectionNameSchema = z.string().min(1).max(100);
export const SidebarSectionEmojiSchema = z.string().max(16);

// ── 섹션 CRUD ────────────────────────────────────────────────────────────────

export const CreateSidebarSectionRequestSchema = z.object({
  name: SidebarSectionNameSchema,
  // 미지정이면 이모지 없음(null 저장).
  emoji: SidebarSectionEmojiSchema.optional(),
  // 미지정이면 MANUAL(드래그 순서).
  sortMode: SidebarSectionSortModeSchema.optional(),
});
export type CreateSidebarSectionRequest = z.infer<typeof CreateSidebarSectionRequestSchema>;

// 부분 갱신: name/sortMode 는 값으로 변경, emoji 는 null 로 제거 · 문자열로 갱신 ·
// undefined 면 변경 없음. 셋 다 미지정이면 no-op(서비스가 현재 행을 반환).
export const UpdateSidebarSectionRequestSchema = z.object({
  name: SidebarSectionNameSchema.optional(),
  emoji: SidebarSectionEmojiSchema.nullable().optional(),
  sortMode: SidebarSectionSortModeSchema.optional(),
});
export type UpdateSidebarSectionRequest = z.infer<typeof UpdateSidebarSectionRequestSchema>;

// ── 채널 할당/해제 ───────────────────────────────────────────────────────────

export const AssignSidebarChannelRequestSchema = z.object({
  channelId: z.string().uuid(),
});
export type AssignSidebarChannelRequest = z.infer<typeof AssignSidebarChannelRequestSchema>;

// ── 재정렬(fractional anchor) ────────────────────────────────────────────────

// 섹션 move — 즐겨찾기 move 와 동일한 anchor 규약. beforeId/afterId 는 상호 배타이며
// 둘 다 없으면 말단으로 간주한다(서버 calcBetween 재사용). anchor 는 같은 사용자의
// 다른 섹션 id 다.
export const MoveSidebarSectionRequestSchema = z
  .object({
    beforeId: z.string().uuid().optional(),
    afterId: z.string().uuid().optional(),
  })
  .refine((x) => !(x.beforeId && x.afterId), {
    message: 'beforeId and afterId are mutually exclusive',
  });
export type MoveSidebarSectionRequest = z.infer<typeof MoveSidebarSectionRequestSchema>;

// 채널 move — 섹션 간 이동 + 섹션 내 순서를 한 번에. sectionId 가 주어지면 그 섹션으로
// 옮기고(미지정이면 현재 섹션 유지), beforeId/afterId 는 같은 목표 섹션 안의 다른 채널
// id 다(상호 배타·둘 다 없으면 목표 섹션 말단).
export const MoveSidebarChannelRequestSchema = z
  .object({
    sectionId: z.string().uuid().optional(),
    beforeId: z.string().uuid().optional(),
    afterId: z.string().uuid().optional(),
  })
  .refine((x) => !(x.beforeId && x.afterId), {
    message: 'beforeId and afterId are mutually exclusive',
  });
export type MoveSidebarChannelRequest = z.infer<typeof MoveSidebarChannelRequestSchema>;

// ── 응답 DTO ─────────────────────────────────────────────────────────────────

// 단일 섹션 + 그 섹션에 속한 채널 id 들(position 오름차순). position 은 와이어상 문자열
// (Decimal 직렬화). channelIds 는 섹션 내 채널 순서(MANUAL position asc — ALPHABETICAL
// 정렬은 클라가 채널명으로 표시 시점에 적용).
export const SidebarSectionSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: SidebarSectionNameSchema,
  emoji: z.string().nullable(),
  sortMode: SidebarSectionSortModeSchema,
  position: z.string(),
  channelIds: z.array(z.string().uuid()),
  createdAt: z.string().datetime(),
});
export type SidebarSection = z.infer<typeof SidebarSectionSchema>;

// GET 응답 — 섹션 배열(position 오름차순).
export const SidebarSectionsResponseSchema = z.object({
  sections: z.array(SidebarSectionSchema),
});
export type SidebarSectionsResponse = z.infer<typeof SidebarSectionsResponseSchema>;
