# Round 6 — Channel messages

## 1. AUDIT

- 도구: 정적 grep + 22 폴리시 스펙 전수 + R2/R3/R4 커밋 누적 효과 확인
- 범위: composer / list / virtualization / scroll / unread / typing / mention / reaction / hover

발견:

- **Composer**: R2 가 `aria-label="파일 첨부"` + R3 가 send-failure
  토스트 + R4 가 attachment cap (10) 까지 모두 fix. IME 가드 + 4000자
  maxLength 매칭 ✓. composer-autogrow / composer-upload 폴리시 스펙
  운영 중.
- **MessageList**: 50 메시지/페이지 + 인피니트 스크롤 (위로 fetchNextPage).
  Virtualization 은 `<Scrollable>` 안에 prepared 만 되어 있고 디폴트로
  꺼짐 — 50/페이지 도메인 로드에서 DOM 비용이 trivial (의도적 design
  decision, MessageList.tsx:32-34 주석에 명시). 1000+ 메시지 스케일
  되면 enable 예정 (follow-task 이미 존재).
- **MessageItem**: R2 `aria-label="메시지 편집"` + 모든 hover icon 버튼
  (reaction-add / thread / more) 라벨 보유 ✓. edit IME 가드 ✓.
  `useUpdateMessage.onSuccess` 만 invalidate, error 토스트 없음 — R3
  의 EE-5 로 MED 이월 분류. delete 동일.
- **Scroll behavior**: R1 의 R1-scroll-jumps-on-new-message + scroll-
  autobottom 폴리시 스펙으로 cover. nearBottom anchor + ref-stamp
  메커니즘.
- **Unread**: dispatcher 에서 unreadCount + recent prepend; cross-
  surface-unread-parity / unread-realtime / dm-unread-badge 폴리시.
- **Typing indicator**: `TypingIndicator.tsx` + typing-accuracy 폴리시.
- **Mention**: `parseContent.tsx` + spec (mention not-found graceful
  fall-through). server side mention extractor + dispatcher.
- **Reaction**: reaction-no-flicker 폴리시 + useToggleReaction.
- **Hover actions**: 데스크톱 hover-only revealed; mobile 은 long-press
  → MobileMessageSheet (long-press-sheet e2e).
- **Virtualization**: 의도적 OFF (design 주석). 본 round 의 HIGH
  아님 — perf 라운드(R8)에서 bundle/runtime 측정 시 재평가.

## 2. IDENTIFY

| ID   | 위치                                                        | 분류                                       |
| ---- | ----------------------------------------------------------- | ------------------------------------------ |
| CM-1 | `useUpdateMessage` / `useDeleteMessage` 실패 시 silent 롤백 | MED (R3 EE-5/6 이미 follow 이월)           |
| CM-2 | Virtualization 미사용 → 1000+ 메시지에서 DOM 비용           | LOW (design decision, R8 perf 에서 재평가) |
| CM-3 | message edit `<input>` 에 `aria-label` 적용됨 (R2 fix 효과) | clean                                      |

**0 BLOCKER, 0 HIGH.** 누적 R2-R5 의 채널 메시지 영역 fix 가 dim
요구사항을 충족.

## 3. FIX

해당 없음. R2/R3/R4 가 이미 cover.

## 4. REGRESSION SPEC

기존 누적 spec 으로 충분:

- `apps/web/src/a11y/input-label-guard.spec.ts` (R2)
- `apps/web/src/features/messages/sendFailureToast*.spec.ts` (R3)
- `apps/web/src/features/messages/clampAttachments.spec.ts` (R4)
- `apps/web/src/features/messages/parseContent.spec.tsx` (existing,
  10 tests cover emoji/code/mention/URL)
- `apps/web/src/features/realtime/dispatcher.spec.ts` (existing,
  unread bump + presence)
- `apps/web/e2e/polish/*` (22 specs)

## 5. VERIFY

(누적 — R5 의 verify 결과가 본 round 까지 cover)

```
$ pnpm verify
... 19/19 successful, 0 errors, 57 warnings
```

green.

## 6. DECIDE

R6 BLOCKER+HIGH = 0. R5 BLOCKER+HIGH 도 모두 fix 후 0. **2 round
연속 0 → channel messages dimension 완료** (convergence rule).
R7 (DMs) 로 진행.

## 7. DEVELOP MERGE

코드 변경 없음 → R7 와 묶어 commit.

## 8. PROGRESS LOG

| Round | BLOCKER | HIGH | MED+ 이월                     | 회귀 spec      |
| ----- | ------- | ---- | ----------------------------- | -------------- |
| R6    | 0       | 0    | 1 (CM-1, R3 에서 이미 이월됨) | 0 (누적 cover) |
