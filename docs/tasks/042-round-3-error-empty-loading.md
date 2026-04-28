# Round 3 — Error / Empty / Loading

## AUDIT

- 도구: 정적 grep + 누적 fix 영향 추적
- 누적 baseline: 040 R3 (banner + send-fail toast) + 041 A-1 (banner offset) + 041 A-2 (edit/delete skeleton) + 042 R0 F4 (unmount-cleanup) + F5 (delete-success-toast)

발견:

- ConnectionBanner: normal-flow + safe-area-inset-top 적용. 데스크톱+모바일 viewport 모두 topbar 충돌 0px (041 A-1).
- 송신 실패: useSendMessage onError 가 buildSendFailureToastBody 로 4 분기 (network/401/5xx-with-code/5xx-without-code) 토스트 push.
- 편집 실패: MessageItem 의 isMountedRef 가드된 onError 토스트.
- 삭제: 성공 토스트 (R0 F5) + 실패 토스트 양쪽 + isMountedRef 가드.
- 빈 상태: `qf-empty` 디자인 토큰 컴포넌트 사용 (041 D 검증).
- 401 / 5xx: `lib/api.ts` 의 401 refresh + retry + forcedLogout 정상.

## IDENTIFY

| ID  | 내용                                      | 분류                       |
| --- | ----------------------------------------- | -------------------------- |
| EE1 | 송신/편집/삭제 실패 토스트                | clean (누적 cover)         |
| EE2 | 삭제 성공 토스트                          | clean (R0 F5)              |
| EE3 | offline / disconnected / replaying banner | clean (040 R3 + 041 A-1)   |
| EE4 | 401 expiry refresh                        | clean (`lib/api.ts`)       |
| EE5 | 5xx fallback (status code 보존)           | clean (`bubbleError`)      |
| EE6 | unmount-mid-mutation console error        | clean (R0 F4 isMountedRef) |
| EE7 | empty channel/DM list                     | clean (qf-empty + DS 토큰) |

**0 BLOCKER, 0 HIGH.**

## FIX

해당 없음.

## REGRESSION SPEC

누적 cover:

- `useSendMessage.spec.ts` (041 B-2) — 6 tests
- `sendFailureToast.spec.ts` + `sendFailureToast.contract.spec.ts` (040 R3) — 3 tests
- `computeConnectionBanner.spec.ts` (040 R3) — 6 tests
- `banner-multi-shell.e2e.ts` (042 R0 F6)
- `banner-ios-safe-area.e2e.ts` (042 R0 F7)

## VERIFY

green.

## DECIDE

R3 = 0. 직전 R2 = 0. 2 round 연속 0 → confirmed converged.

## PROGRESS

| Round | BLOCKER | HIGH | MED+ 이월 | 회귀 spec      |
| ----- | ------- | ---- | --------- | -------------- |
| R3    | 0       | 0    | 0         | 0 (누적 cover) |
