# Round 7 — DMs

## AUDIT

누적 baseline: 040 R7 + 041 A-3 (presence dot) + 042 R0 F2 (presence memo + dedup).

| 영역                    | 상태                                                            |
| ----------------------- | --------------------------------------------------------------- |
| workspaceless flow      | clean — 039 hot-fix 회수 + 040 R7 누적                          |
| presence dot            | clean — 041 A-3 + R0 F2 메모이제이션                            |
| DM list 정렬 + 미읽음   | clean — dm-list-sort-stability + dm-unread-badge polish         |
| history pagination      | clean — useMessageHistory wsId=null gate                        |
| participant metadata    | clean — 039 dm-participant-name int spec                        |
| realtime parity         | clean — dm-realtime-parity polish                               |
| ConnectionBanner        | clean — 041 A-1 normal-flow, 042 R0 F6 multi-shell single-mount |
| edit/delete (DM 메시지) | clean — 041 A-2 + R0 F4 unmount-safe + R0 F5 success-toast      |

## IDENTIFY

| ID    | 분류  |
| ----- | ----- |
| DM1-8 | clean |

**0 BLOCKER, 0 HIGH.**

## FIX

해당 없음.

## REGRESSION SPEC

누적 cover (e2e 6 + polish 4 + mobile 3 + R0 F2 useDmPresence + R0 F6 banner-multi-shell).

## VERIFY

green.

## DECIDE

R7 = 0. R6 = 0. 2 round 연속 0 → R7 converged.

## PROGRESS

| Round | BLOCKER | HIGH | MED+ 이월 | 회귀 spec      |
| ----- | ------- | ---- | --------- | -------------- |
| R7    | 0       | 0    | 0         | 0 (누적 cover) |
