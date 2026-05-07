# Iteration 1 — AUDIT (Section J 검색 dim 완성)

## 처리 범위

Section J (검색 깊이 4 row) 의 J2 + J4 부분 완성.

## row 변경

| #   | Row                                         | iter 0 종료 | iter 1 종료 | 가중치 변화 |
| --- | ------------------------------------------- | ----------- | ----------- | ----------- |
| J1  | autocomplete                                | ✅ (1.0)    | ✅ (1.0)    | 0           |
| J2  | 결과 navigation (이전/다음, 키보드)         | 🟡 (0.5)    | ✅ (1.0)    | +0.5        |
| J3  | filter (channel/sender/기간/has-attachment) | ✅ (1.0)    | ✅ (1.0)    | 0           |
| J4  | 코드블록 / 멘션 highlight                   | 🟡 (0.5)    | ✅ (1.0)    | +0.5        |

Section J: 3.0 → **4.0 / 4** = **100%** (+25pp).

## 산출물

### J2 결과 navigation (✅ 진급)

- **scrollIntoView**: `SearchInput.tsx` 에 `resultRefs: Map<messageId, HTMLLIElement>` 추가 + highlight 변경 시 useEffect 가 `scrollIntoView({ block: 'nearest' })` 호출.
- 키보드 nav (ArrowDown/Up + Enter) 는 045 부터 존재 — scrollIntoView 추가로 dropdown max-height (60vh) 초과 시에도 highlighted item 항상 가시.
- 영향: ~25 라인.

### J4 코드블록 / 멘션 highlight (✅ 진급)

- **신규 함수**: `sanitize.ts` 의 `highlightSnippet(htmlSafe)` + `searchSnippetHtml(raw)`.
- mention `@username` → `<span class="qf-mention">@user</span>`
- channel `#name` → `<span class="qf-channel-ref">#name</span>`
- inline code `` `code` `` → `<code class="qf-search-code">code</code>`
- markOnlyHtml + highlightSnippet 체이닝, `<mark>` 와 추가 span 만 허용 (sanitizer 보안 유지).
- `SearchInput.tsx` 의 dangerouslySetInnerHTML 가 `searchSnippetHtml` 사용으로 교체.
- 영향: ~50 라인 (sanitize 35 + SearchInput 15).

## 회귀 spec

| 신규 / 확장             | Cases   | 상태 |
| ----------------------- | ------- | ---- |
| sanitize.spec.ts (확장) | +7 → 12 | ✅   |

## Score 재산정 (96 row baseline)

- iter 0 종료 row 합: 77.75 / 96
- Section J 변화: +1.0 (J2 +0.5 + J4 +0.5)
- iter 1 종료 row 합: **78.75 / 96**
- 단순 score: 78.75 / 96 = **82.03%** (+1.04pp)
- HIGH×2 (HIGH=0): 동일 **82.03%** (+1.04pp)

## DoD

- [x] J2 scrollIntoView + spec
- [x] J4 highlightSnippet + spec
- [x] HIGH 갭 = 0 유지 (변동 없음)
- [x] pnpm verify green (api 249 + web 125)
- [x] DS untouched
- [x] 96 row matrix 유지 (row 추가 없음)

## 측정

- 영향 라인: ~75 (sanitize.ts 35 + SearchInput 25 + spec 50)
- web 118 → **125** unit tests (+7)
- 신규 라우트 0 / 신규 컬럼 0 / 신규 migration 0
