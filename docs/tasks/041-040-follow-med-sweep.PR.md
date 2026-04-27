# Task 041 — 040 follow MED+ sweep · PR

## Summary

040 가 이월한 11 follow 항목 중 9건을 4 chunks 로 일괄 처리. 큰 두 건
(`lighthouse-ci` / `virtualization`) 은 별도 task 로 분리.

- A UX (3): banner offset, edit/delete skeleton, DM presence dot
- B Spec (3): banner DOM render e2e, send-fail mutation test, clamp race
- C A11y (2): input-label-guard 확장 (ALLOWLIST 7→1)
- D Visual (1): inline-px 14→4 (71% 감소, baseline 대비)
- DS 4파일 git diff 0 (md5 baseline 일치)
- 49 → 67 unit tests (+18); 1 신규 e2e (banner DOM)

## Test plan

- [x] `pnpm verify` green (lint + typecheck + 67 unit, 0 errors / 58 warn pre-existing)
- [x] `cd apps/web && pnpm test src/a11y/input-label-guard.spec.ts` green
- [x] `cd apps/web && pnpm test src/features/messages/useSendMessage.spec.ts` 6/6 green
- [x] `cd apps/web && pnpm test src/features/messages/clampAttachments` 12/12 green
- [x] DS 4파일 md5 == `.task-040-ds-baseline.txt`
- [ ] (e2e) `pnpm test:e2e` — dev/api 서버 필요, 본 PR scope 밖 (banner DOM e2e + 040 R5 414 viewport e2e 모두 e2e pipeline 의존)

## Diff highlights

### A. UX

- `apps/web/src/App.tsx` — `AppLayout` flex column wrapper; banner in normal flow pushes content down (review M1 fix)
- `apps/web/src/features/connection/ConnectionBanner.tsx` — `position: fixed` 제거, `flexShrink: 0` + `safe-area-inset-top`
- `apps/web/src/features/messages/MessageItem.tsx` — `editPending` / `deletePending` state, opacity overlay + 실패 toast
- `apps/web/src/features/messages/MessageList.tsx` — onDelete `mutateAsync` 로 변환 (await 필요)
- `apps/web/src/features/realtime/useDmPresence.ts` (신규) — workspace presence 캐시 union → `getStatus(userId)`
- `apps/web/src/lib/query-keys.ts` — `qk.presence.all()` prefix-only key
- `apps/web/src/shell/DmShell.tsx` + `MobileDmList.tsx` — Avatar `status={getStatus(otherUserId)}`

### B. Spec

- `apps/web/e2e/connection/banner-dom-render.e2e.ts` (신규) — normal/disconnect/reconnect + single-mount
- `apps/web/src/features/messages/useSendMessage.spec.ts` (신규, 6 tests) — buildSendFailureToastBody 4 branch + react-query mutation 2회 재현
- `apps/web/src/features/messages/clampAttachments.race.spec.ts` (신규, 5 tests) — Promise.all + immutable + 12→10
- `apps/web/src/features/messages/useMessages.ts` — `buildSendFailureToastBody` export로 추출
- `apps/web/src/features/messages/clampAttachments.ts` — non-truncate 경로도 fresh array 반환 (B-3 spec이 발견한 immutability 버그 fix)

### C. A11y

- `apps/web/src/a11y/input-label-guard.spec.ts` — ALLOWLIST 6 entries 제거 + label window 400→1500
- `apps/web/src/features/auth/SignupPage.tsx` + `LoginPage.tsx` — `htmlFor` + `id` association
- `apps/web/src/features/friends/FriendsPage.tsx` + `MobileFriends.tsx` — `aria-label="추가할 친구의 사용자 이름"`
- `apps/web/src/features/emojis/WorkspaceEmojiManager.tsx` — file input `aria-label`

### D. Visual

- `apps/web/src/shell/mobile/MobileHome.tsx` — 9건 raw px → DS tokens (`var(--s-9)`, `var(--s-10)`, `var(--s-2)`, `calc(var(--w-serverlist) + var(--s-2))`)
- `apps/web/src/features/threads/ThreadPanel.tsx` — textarea sizing tokens
- `apps/web/src/shell/mobile/MobileDrawer.tsx` — comment for 360px (no exact token, justified)

## 11 follow → 처리 매핑

| #   | follow item                                            | 청크 | 처리                               |
| --- | ------------------------------------------------------ | ---- | ---------------------------------- |
| 1   | task-040-follow-banner-topbar-offset (M1)              | A-1  | ✅                                 |
| 2   | task-040-follow-error-states-edit-delete-skeleton (R3) | A-2  | ✅                                 |
| 3   | task-040-follow-dm-workspaceless-presence (R7 DM-1)    | A-3  | ✅                                 |
| 4   | task-040-follow-banner-dom-render-test (H2)            | B-1  | ✅ (e2e, dev pipeline 의존)        |
| 5   | task-040-follow-send-fail-mutation-test (M2)           | B-2  | ✅                                 |
| 6   | task-040-follow-clamp-race (M3)                        | B-3  | ✅ + 부수효과로 immutable 버그 fix |
| 7   | task-040-follow-a11y-input-labels-out-of-scope (R2)    | C-1  | ✅ (ALLOWLIST 7→1)                 |
| 8   | task-040-follow-friends-input-label (M4)               | C-2  | ✅                                 |
| 9   | task-040-follow-visual-inline-px-jsstrings (R1)        | D    | ✅ (14→4, 71% 감소)                |
| 10  | task-040-follow-lighthouse-ci (R8 P-2)                 | OUT  | 042 후보 (별도 task)               |
| 11  | task-040-follow-virtualization (R6 CM-2)               | OUT  | 별도 task (1일 단위)               |

## Co-Authored-By: Claude Opus 4.7 (1M context) &lt;noreply@anthropic.com&gt;
