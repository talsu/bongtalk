# 059 · S85 — 사이드바 개인 섹션 (FR-CH-16)

## Context

PRD FR-CH-16: 사이드바 섹션(개인 정렬). 멤버가 섹션을 생성(이름·이모지·sortMode)하고
채널을 할당한다. 드래그로 재정렬. **개인 전용(타인 미노출).**

기존: ChannelList 는 카테고리(워크스페이스 스코프·ADMIN 관리·전원 노출)를 섹션처럼
dnd-kit 으로 렌더한다. FR-CH-16 은 그 위에 **per-user 개인 섹션**(나만 보는 그룹)을
얹는다. 직접 선례 = **S43 채널 즐겨찾기**(개인 상태·fractional position·calcBetween·
dnd-kit 드래그). 본 슬라이스는 favorites 를 "섹션 + 섹션 내 채널 할당"으로 일반화한다.

## 아키텍처 결정

- **모델 2개**(둘 다 per-user · additive · onDelete Cascade):
  - `UserSidebarSection`(id, userId, workspaceId, name, emoji?, sortMode, position
    Decimal(20,10), createdAt, updatedAt). `@@index([userId, workspaceId, position])`.
  - `UserSidebarChannelAssignment`(id, userId, channelId, sectionId, position Decimal,
    ...). `@@unique([userId, channelId])`(채널은 사용자당 1섹션) + `@@index([userId,
sectionId, position])`. onDelete Cascade(section/channel/user 삭제 시 정리).
  - `sortMode` enum `SidebarSectionSortMode { MANUAL, ALPHABETICAL }`(MANUAL=수동 드래그,
    ALPHABETICAL=채널명 가나다 정렬 — 표시 시 적용, 저장 position 무관).
- **fractional position**: 섹션 순서 + 섹션 내 채널 순서 둘 다 `calcBetween`(positioning/
  fractional-position.ts) 재사용. anchor 규약(beforeId/afterId)도 favorites move 동일.
- **개인 스코프**: 전부 userId 로 스코프 — 타 사용자 미노출. WorkspaceMemberGuard 로 멤버만.
- **마이그레이션** `20260624000000_s85_sidebar_sections`(reversible · NO CONCURRENTLY).

## Scope

### IN

- **Prisma**: 위 2모델 + enum + 마이그레이션. User/Channel/Workspace 역관계.
- **shared-types** `sidebar-section.ts`: 섹션 CRUD(create/update name·emoji·sortMode) +
  채널 할당(assign/unassign) + reorder(섹션 move·채널 move, beforeId/afterId anchor) Zod +
  리스트 응답 DTO. index.ts export. ErrorCode 추가(SIDEBAR_SECTION_NOT_FOUND 등).
- **API** `apps/api/src/channels/sidebar-sections/**`: service(favorites.service 패턴 —
  create/list/rename/delete/moveSection/assignChannel/unassignChannel/moveChannel,
  calcBetween, P2002 멱등, anchor 404) + controller(`@Controller('workspaces/:id/sidebar-
sections')` · WorkspaceMemberGuard · @CurrentUser 스코프 · rate-limit mutate). 모듈 와이어링
  (ChannelsModule). 채널 할당 시 그 채널이 워크스페이스 소속·VIEW 가능인지 검증.
- **web** `apps/web/src/features/channels/`: useSidebarSections(useFavorites 패턴 ·
  TanStack Query + optimistic) + SidebarSections.tsx(FavoritesSection dnd-kit 패턴 —
  섹션 헤더[이모지+이름+collapse] + 섹션 내 채널 드래그 + 섹션 자체 드래그 reorder) +
  섹션 생성/이름변경/삭제 UI(인라인 또는 메뉴) + ChannelList 통합(Favorites 아래·카테고리
  위). 할당된 채널은 카테고리 기본 위치에서 빠지고 섹션에 표시. DS 4파일 미수정(qf-_ +
  var(--s-_) 토큰 · raw hex/px 금지 · ALPHABETICAL 정렬은 클라 표시 계산).
- **tests**: shared-types Zod · API 통합(실DB — 생성/할당/재정렬/개인격리/cascade) ·
  web 단위(섹션 렌더·드래그 anchor 계산·sortMode 표시·optimistic).

### OUT (non-goals)

- 워크스페이스 공유 섹션(개인 전용만). 카테고리(관리자 섹션)는 무변경.
- 섹션별 알림/뮤트(별도). 모바일 사이드바 DnD(데스크톱 우선 · 모바일은 표시만 가능).
- RECENT_ACTIVITY sortMode(MANUAL/ALPHABETICAL 만).

## Acceptance Criteria (기계 검증)

- `pnpm verify`(node20 컨테이너) GREEN.
- 섹션 CRUD + 채널 할당/해제 + 섹션·채널 재정렬(fractional) 왕복(실DB 통합).
- 개인 격리: 사용자 A 의 섹션이 사용자 B 응답에 없음(통합).
- 삭제 cascade: 섹션 삭제 시 할당 행 정리, 채널은 기본 위치 복귀(통합).
- web: 섹션이 Favorites 아래 카테고리 위에 렌더 · 드래그 reorder · ALPHABETICAL 표시 정렬(단위).

## Non-goals / Risks

- fractional position 소진 시 CHANNEL_POSITION_INVALID 재정규화(favorites 규약 일관).
- dnd-kit 섹션×채널 2계층 드래그의 anchor 계산 정확성(드롭 경계).
- 마이그레이션 reversible(2 테이블 + enum · down DROP 역순).

## DoD

- 체크리스트 green + `pnpm verify` + reviewer(adversarial) 통과.
- fr-matrix FR-CH-16 = done · 핸드오프 갱신. 수동 배포(승인 후).
