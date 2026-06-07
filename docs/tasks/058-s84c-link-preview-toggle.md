# 058 · S84c — 링크 미리보기 전역 비활성화 (FR-RC19)

> D16-richcontent S84 3분할의 마지막: S84a=FR-RC11(LIVE), S84b=FR-RC12(LIVE),
> **S84c = FR-RC19(링크프리뷰 전역 비활성화)**.

## Context

PRD FR-RC19: 사용자는 프로필 설정에서 링크 미리보기를 전역으로 비활성화할 수 있어야
하며, 비활성화 시 embed 렌더를 건너뛴다(서버에서 unfurl 은 계속 수행 — 다른 사용자는
계속 카드를 본다).

기반: S76(FR-PS-09) 외관 설정(`UserSettings` theme/density/chatFontSize/clock24h +
appearance-store + AppearanceSettingsPage + useAppearanceSettings)이 확립됨. 링크
미리보기 토글은 표시(렌더) 환경설정이라 외관 설정 표면에 자연스럽게 합류한다.

## Scope

### IN

- **Prisma**: `UserSettings.linkPreviewsEnabled Boolean @default(true)` additive 컬럼 +
  reversible 마이그레이션 `20260623000000`.
- **shared-types** settings.ts: `AppearanceSettingsSchema` + `DEFAULT_APPEARANCE` 에
  `linkPreviewsEnabled` 추가(기본 true). `UpdateAppearanceSettingsSchema`(partial.strict)
  가 자동 수용.
- **API** appearance-settings.service: getAppearance select + toView + updateAppearance
  patch 에 linkPreviewsEnabled 배선(컨트롤러는 무변경 — Zod 가 새 필드 수용).
- **FE**:
  - appearance-store: `useLinkPreviewsEnabled()` 셀렉터(clock24h 선례).
  - AppearanceSettingsPage: 링크 미리보기 토글(qf-switch · clock24h 토글 미러).
  - MessageItem: `!linkPreviewsEnabled` 면 **unfurl embeds(`msg.embeds` 서버 카드 +
    URL lazy 프리뷰)만** 렌더 스킵. **rich embeds(`msg.richEmbeds` — 봇 콘텐츠)는 유지**
    (FR-RC19 는 "링크 미리보기" 한정 · Discord parity). 서버 unfurl 은 계속 수행.
- **tests**: settings Zod(새 필드) · MessageItem unfurl 스킵 + rich embed 유지 단위 ·
  AppearanceSettingsPage 토글.

### OUT (non-goals)

- 채널/메시지 단위 미리보기 토글(전역만).
- 서버 unfurl 중단(계속 수행 — 타 사용자 영향 없음).
- rich embed(봇) 숨김(링크 미리보기가 아님).

## Acceptance Criteria (기계 검증)

- `pnpm verify`(node20) GREEN.
- GET/PATCH /me/settings/appearance 가 linkPreviewsEnabled 왕복(기본 true).
- linkPreviewsEnabled=false → MessageItem 이 unfurl embeds 미렌더, rich embeds 는 렌더(단위).

## Non-goals / Risks

- 마이그레이션 reversible(additive nullable→default true · down DROP COLUMN).
- 서버 unfurl 은 무변경(렌더 게이트만 클라) — 타 사용자 회귀 없음.

## DoD

- 체크리스트 green + `pnpm verify` + reviewer(adversarial) 통과.
- fr-matrix FR-RC19 = done · 핸드오프 갱신. 수동 배포(승인 후).
