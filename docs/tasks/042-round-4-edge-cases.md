# Round 4 — Edge cases

## AUDIT

72 unit tests + 040/041 edge spec 누적 + R0 F3 (composer race fix) baseline.

| #   | 케이스                | 상태                                                                           |
| --- | --------------------- | ------------------------------------------------------------------------------ |
| 1   | 10k chars 메시지      | clean — composer maxLength=4000 + zod MESSAGE_MAX_LENGTH=4000 일치             |
| 2   | 한국어 IME 조합 send  | clean — composer/thread/edit/mobile/command-palette 모두 isComposing 가드      |
| 3   | 다중 첨부 max+1       | clean — clampAttachments + R0 F3 ref-mirror race fix                           |
| 4   | `:emoji:` 텍스트 충돌 | clean — parseContent.spec.tsx 가 unknown shortcode plain-text fallthrough 검증 |
| 5   | mention not-found     | clean — client-side pill render 만, 서버 resolve 와 분리                       |
| 6   | URL preview           | clean (의도적 미구현, BE follow-up)                                            |
| 7   | 코드 블록             | clean — fence/inline 모두 parseContent spec                                    |
| 8   | 다중 탭 (같은 채널)   | clean — Socket.IO multiplex + 서버 dedupe                                      |

## IDENTIFY

| ID    | 분류  |
| ----- | ----- |
| EC1-8 | clean |

**0 BLOCKER, 0 HIGH.**

## FIX

해당 없음.

## REGRESSION SPEC

누적 cover:

- `clampAttachments.spec.ts` (040 R4) — 7 tests
- `clampAttachments.race.spec.ts` (041 B-3) — 5 tests
- `parseContent.spec.tsx` (existing) — 10 tests

## VERIFY

green (72 unit tests).

## DECIDE

R4 = 0. R3 = 0. 2 round 연속 0 → R4 converged.

## PROGRESS

| Round | BLOCKER | HIGH | MED+ 이월 | 회귀 spec      |
| ----- | ------- | ---- | --------- | -------------- |
| R4    | 0       | 0    | 0         | 0 (누적 cover) |
