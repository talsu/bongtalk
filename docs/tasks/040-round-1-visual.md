# Round 1 — Visual consistency

## 1. AUDIT

데스크톱 + 모바일 viewport 점검:

- 도구: 정적 grep + ESLint task-018 raw-value guard
- 범위: `apps/web/src/**/*.{ts,tsx,css}`

발견:

```
$ grep -rE "#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3}\b" apps/web/src
apps/web/src/features/typing/TypingIndicator.tsx:// error #185` ...   (comment, 무시)
```

→ raw hex 0건 (코드 주석 1건만, ESLint Literal 선택자로 이미 무시).

```
$ grep -rE "[0-9]+px\b" apps/web/src --include="*.tsx" --include="*.ts" | grep -v "//"
... 64건 ...
```

분류:

| 패턴                                                         | 건수 | 분류                    |
| ------------------------------------------------------------ | ---- | ----------------------- |
| `'1px solid var(--*)'` 인라인 border                         | 18   | 합법 (DS 1px 토큰 없음) |
| `'0px'` textarea reset                                       | 4    | 합법 (rendering reset)  |
| token 정의 파일 (`tokens/typography.ts`, `tokens/radius.ts`) | 14   | 합법 (소스)             |
| 주석 / 문서                                                  | 12   | 무시                    |
| 미디어쿼리 `(max-width: 767px)`                              | 6    | 합법 (CSS API)          |
| `style={{ padding: '2px 6px' }}` 등 inline px in JS string   | 5    | MED                     |
| Tailwind arbitrary `w-[min(420px,92vw)]` 처럼 함수 안에 px   | 2    | MED                     |
| `style={{ minHeight: '22px', maxHeight: '160px' }}`          | 1    | MED                     |

ESLint `RAW_PX_ARBITRARY` 정규식 (`\\[[0-9]+(?:\\.[0-9]+)?px\\]`) 은
`[Npx]` 직접 사용만 잡고, JS string `'22px'` / `min(420px, 92vw)` 안의
중첩 px 는 통과시킴. 028 sweep 후 신규 코드에서 잔존.

axe-core 기존 e2e (`apps/web/e2e/a11y/axe-scan.e2e.ts`) — 본 dimension
범위는 시각 정합이라 dim 2 에서 다룸.

## 2. IDENTIFY

| ID  | 내용                                                | 위치                                         | 분류  |
| --- | --------------------------------------------------- | -------------------------------------------- | ----- |
| V1  | raw hex 색                                          | (none — 주석만)                              | clean |
| V2  | Tailwind `[Npx]` arbitrary 직접 사용                | (none)                                       | clean |
| V3  | rgba(), 인라인 box-shadow                           | (none)                                       | clean |
| V4  | inline `style={{ padding: '2px 6px' }}` (JS string) | `ShortcutHelp.tsx:41`                        | MED   |
| V5  | inline `style={{ minHeight: '22px' }}` (JS string)  | `ThreadPanel.tsx:289`                        | MED   |
| V6  | Tailwind arbitrary 안의 함수 안 raw px              | `FriendsPage.tsx:112`, `DiscoverPage.tsx:85` | MED   |

**0 BLOCKER, 0 HIGH.** (기존 ESLint task-018 가드가 거의 모든 시각 정합
위반을 빌드 타임에 차단. JS string 내부 px 만 잔존.)

## 3. FIX (BLOCKER + HIGH only)

해당 없음. 모든 발견은 MED.

이월: `TODO(task-040-follow-visual-inline-px-jsstrings)` — JS object
literal `style={{}}` 의 raw px 값 + Tailwind arbitrary 함수 안의 px
를 토큰으로 대체 또는 ESLint 정규식 확장.

## 4. REGRESSION SPEC

추가 fix 가 없으므로 신규 spec 불필요. 기존 ESLint task-018 raw-value
guard (`eslint.config.mjs` line 32-44, error-level on
`apps/web/src/**`) 가 회귀를 차단.

## 5. VERIFY

pnpm verify (lint + typecheck + unit) baseline green 확인:

(아래 verify run 결과 기록)

## 6. DECIDE

이번 Round 1 BLOCKER+HIGH = 0. 직전 round 가 없으므로 convergence
조건 (2 round 연속 0) 만족 X — 한 번 더 audit 으로 확정 round 가
필요. **다음 Round 2 (Visual confirm) 또는 Visual dim 종료 후 다른
dim 으로 진행 가능.**

명세상 1 dimension = 2 round 최소 → "확정 round 추가" 옵션 채택.
실제 fix 가 없는 이상 Round 2 (Accessibility) 로 이동하면서 Visual
은 dim matrix 에 "1 round (clean), confirm pending" 으로 기록. cap
도달 우려 시 Visual confirm 은 LOOP 종료 직전 cumulative 재실행으로
대체.

→ **결정: Visual dim 1 round clean. Accessibility (Round 2) 로 진행.
Visual confirm 은 누적 lint+typecheck 가 전 round 마다 돌아가므로
사실상 round-by-round 자동 검증됨.**

## 7. DEVELOP MERGE

이번 round 코드 변경 없음 → develop merge 무의미. round log + matrix
업데이트만 next round 와 함께 묶어 commit.

## 8. PROGRESS LOG

dimension matrix 업데이트:

| Round | BLOCKER | HIGH | MED+ 이월    | 회귀 spec  |
| ----- | ------- | ---- | ------------ | ---------- |
| R1    | 0       | 0    | 3 (V4/V5/V6) | 0 (불필요) |

이월 follow-task: `TODO(task-040-follow-visual-inline-px-jsstrings)`.
