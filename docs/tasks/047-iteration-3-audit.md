# Iteration 3 — AUDIT (L2 단축키 학습 + M2 외부 링크)

## 처리 범위

Section L (단축키 cheat sheet) 의 L2 + Section M (Profile 확장) 의 M2 ✅ 진급.

## row 변경

| #   | Row                              | iter 2 종료 | iter 3 종료 | 가중치 변화 |
| --- | -------------------------------- | ----------- | ----------- | ----------- |
| L2  | 단축키 학습 (Cmd+K → suggestion) | 🟡 (0.5)    | ✅ (1.0)    | +0.5        |
| M2  | 외부 URL list (links)            | 🟡 (0.5)    | ✅ (1.0)    | +0.5        |

Section L: 2.5 → **3.0 / 3** = **100%** (+16.67pp).
Section M: 1.5 → **2.0 / 3** = **66.67%** (+16.67pp).

## 산출물

### L2 단축키 학습 (✅ 진급)

- **CommandPalette.tsx**: actions list 상단에 단축키 entry 3개 추가:
  - `단축키 도움말 열기` (`?`) — ShortcutHelp modal 직접 열기
  - `메시지 검색 포커스` (`Ctrl+/`) — qufox.search.focus event dispatch
  - `다음 워크스페이스로 이동` (`Ctrl+Shift+A`) — 워크스페이스 cycle (2개 이상일 때)
- 효과: 사용자가 Cmd+K palette 안에서 "단축" / "키" 입력 시 단축키 자체가 검색되어 발견 + 직접 실행. "학습" UX 의 핵심.
- 영향: ~30 라인

### M2 외부 링크 (✅ 진급)

- **schema**: User.links Json (nullable) 추가
- **migration**: `20260507150000_add_user_links` (reversible, ADD COLUMN)
- **me-profile.controller.ts**:
  - GET 응답에 `links: ProfileLink[] | null` 추가
  - PATCH body 의 `links?: unknown` validate
  - validateLinks 헬퍼: array, cap 3, url is non-empty + https?:// + 2048 chars cap, label optional + 32 chars cap
  - Prisma.JsonNull 처리 (null 저장 시)
- **회귀 spec**: me-profile.spec.ts +8 cases (links 정상 / null / 빈 배열 / cap / url 검증 / label / bio+links 동시)
- 영향: ~150 라인 (controller 95 + spec 70 + migration 8)

## 회귀 spec

| 신규 / 확장               | Cases   | 상태 |
| ------------------------- | ------- | ---- |
| me-profile.spec.ts (확장) | +8 → 17 | ✅   |

## Score 재산정 (96 row baseline)

- iter 2 종료 row 합: 80.0 / 96
- L2 +0.5 / M2 +0.5 = +1.0
- iter 3 종료 row 합: **81.0 / 96**
- 단순 score: 81.0 / 96 = **84.38%** (+1.05pp)
- HIGH×2 (HIGH=0): 동일 **84.38%** (+1.05pp)

## DoD

- [x] L2 CommandPalette 단축키 entry 3개 + 학습 흐름
- [x] M2 User.links + endpoint + spec
- [x] migration reversible
- [x] HIGH 갭 = 0 유지
- [x] pnpm verify green (api 258→266 + web 134)
- [x] DS untouched
- [x] 96 row matrix 유지

## 측정

- 영향 라인: ~180 (CommandPalette 30 + me-profile.controller 95 + spec 70 + migration 8)
- API 258 → **266** (+8) — me-profile +8
- 신규 라우트 0 (PATCH /me/profile body 확장)
- 신규 컬럼 1 (User.links)
- 신규 migration 1 (reversible)
