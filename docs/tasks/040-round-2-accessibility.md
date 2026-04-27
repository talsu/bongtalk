# Round 2 — Accessibility

## 1. AUDIT

- 도구: 정적 grep (`<button>` / `<input>` 라벨 점검) + 기존 `axe-scan.e2e.ts`
- 범위: `apps/web/src/**/*.tsx`

`<button>` 점검: Python 스크립트로 전수 검사. icon-only / svg-only
button 중 `aria-label` 없는 케이스 0건 (BottomBar, MessageItem,
MessageComposer 모두 라벨 보유 — 1차 grep 은 false positive).

`<input>` 점검: 19건이 `aria-label` / `<label htmlFor>` / 부모
`<label>` wrap 없음. axe-core `label` 룰 = serious.

## 2. IDENTIFY

| ID     | 위치                                                                   | 분류               |
| ------ | ---------------------------------------------------------------------- | ------------------ |
| A11-1  | `shell/DmShell.tsx:101` (DM 검색)                                      | HIGH (axe serious) |
| A11-2  | `shell/mobile/MobileChannelList.tsx:79` (채널 검색)                    | HIGH               |
| A11-3  | `shell/mobile/MobileDmList.tsx:56` (DM 검색)                           | HIGH               |
| A11-4  | `shell/mobile/MobileDmList.tsx:141` (새 DM 멤버 검색)                  | HIGH               |
| A11-5  | `shell/mobile/MobileDiscover.tsx:50` (워크스페이스 검색)               | HIGH               |
| A11-6  | `features/discovery/DiscoverPage.tsx:37` (워크스페이스 검색)           | HIGH               |
| A11-7  | `features/messages/MessageComposer.tsx:316` (파일 첨부)                | HIGH               |
| A11-8  | `features/messages/MessageItem.tsx:129` (메시지 편집)                  | HIGH               |
| A11-9  | `shell/mobile/MobileMessages.tsx:342` (모바일 메시지 입력)             | HIGH               |
| A11-10 | `features/workspaces/WorkspaceSettingsPage.tsx:147,159`                | MED (out of scope) |
| A11-11 | `features/settings/NotificationSettingsPage.tsx:140`                   | MED                |
| A11-12 | `features/friends/FriendsPage.tsx:116`, `MobileFriends.tsx:209`        | MED                |
| A11-13 | `features/emojis/WorkspaceEmojiManager.tsx:131,149`                    | MED                |
| A11-14 | `features/threads/ThreadPanel.tsx:294` (disabled checkbox)             | LOW                |
| A11-15 | `design-system/primitives/Input.tsx:11` (DS forwards label from props) | LOW (보호)         |

**9 HIGH, 6 MED+ (이월).** 0 BLOCKER.

## 3. FIX (BLOCKER + HIGH only)

채널/DM critical path 9건 — 각 input 에 적절한 한국어 `aria-label` 추가.

| 변경                                        | 파일                                    |
| ------------------------------------------- | --------------------------------------- |
| `aria-label="다이렉트 메시지 검색"`         | `shell/DmShell.tsx`                     |
| `aria-label="채널 검색"`                    | `shell/mobile/MobileChannelList.tsx`    |
| `aria-label="다이렉트 메시지 검색"`         | `shell/mobile/MobileDmList.tsx` (list)  |
| `aria-label="새 다이렉트 메시지 멤버 검색"` | `shell/mobile/MobileDmList.tsx` (sheet) |
| `aria-label="워크스페이스 검색"`            | `shell/mobile/MobileDiscover.tsx`       |
| `aria-label="워크스페이스 검색"`            | `features/discovery/DiscoverPage.tsx`   |
| `aria-label="파일 첨부"`                    | `features/messages/MessageComposer.tsx` |
| `aria-label="메시지 편집"`                  | `features/messages/MessageItem.tsx`     |
| `aria-label="메시지 입력"`                  | `shell/mobile/MobileMessages.tsx`       |

이월: `TODO(task-040-follow-a11y-input-labels-out-of-scope)` —
WorkspaceSettings / NotificationSettings / Friends / EmojiManager
input 6건 (out of scope but should still be labelled).

## 4. REGRESSION SPEC

`apps/web/src/a11y/input-label-guard.spec.ts` (신규)

- 정적 audit: `apps/web/src/**/*.tsx` 의 `<input>` 중 `aria-label`,
  `aria-labelledby`, 부모 `<label>` wrap, `htmlFor` association 어느
  것도 없는 input 을 재발견 시 fail.
- ALLOWLIST 로 out-of-scope 6 파일 + DS Input primitive 만 허용.
- 9 fix 모두를 cover.

## 5. VERIFY

```
$ pnpm verify
... 19/19 successful, 0 errors, 57 warnings (pre-existing)
$ cd apps/web && pnpm test src/a11y/input-label-guard.spec.ts
... ✓ 1 passed
```

green.

## 6. DECIDE

이번 Round 2 BLOCKER+HIGH = 9 → fix 됨. 다음 round 에서 동일 dim
재 audit 시 0 이어야 dim 종료. R3 (Error/Empty/Loading) 으로 진행.
누적 verify 가 새 spec 을 매 round 에 재실행하므로 회귀 확정.

## 7. DEVELOP MERGE

(commit + merge 후 SHA 기록)

## 8. PROGRESS LOG

| Round | BLOCKER | HIGH      | MED+ 이월 | 회귀 spec             |
| ----- | ------- | --------- | --------- | --------------------- |
| R2    | 0       | 9 (fixed) | 6         | 1 (input-label-guard) |
