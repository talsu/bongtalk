# Round 4 — Edge cases

## 1. AUDIT

- 도구: 정적 grep + spec 전수 점검
- 8 edge case 가설 매트릭스:

| #   | 케이스                | 현재 상태                                                                                                             | 분류                   |
| --- | --------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 1   | 10k chars 메시지      | composer `maxLength={4000}` + zod `MESSAGE_MAX_LENGTH=4000` 일치 — HTML이 typing 차단                                 | clean                  |
| 2   | 한국어 IME 조합 send  | 4 surfaces (composer / thread / message-edit / mobile-msg / command-palette) 모두 `isComposing\|\|keyCode===229` 가드 | clean                  |
| 3   | 다중 첨부 max+1       | composer `onFiles` 가 무제한 업로드, 서버는 zod `attachmentIds.max(10)` 으로 422 — 11번째 orphan-gc 발생              | **HIGH**               |
| 4   | `:emoji:` 텍스트 충돌 | `parseContent.tsx` 가 unknown shortcode 를 plain text 로 fallthrough; spec 으로 cover                                 | clean                  |
| 5   | mention not-found     | `parseContent.tsx` 는 client side 단순 pill render — server resolve 와 분리; 실패 nono-failure                        | clean                  |
| 6   | URL preview           | `parseContent.tsx` 가 `<a target="_blank" rel="noopener">` 만 — rich embed 는 BE follow-up                            | clean (현재 spec 준수) |
| 7   | 코드 블록             | 트리플 백틱 + 인라인 백틱 모두 spec coverage                                                                          | clean                  |
| 8   | 다중 탭               | Socket.IO 자동 multiplex; 같은 채널 여러 탭 = 같은 user-channel pair 인 unread 만 한 번 비움                          | clean (서버 dedupe)    |

## 2. IDENTIFY

| ID   | 위치                                                       | 분류                |
| ---- | ---------------------------------------------------------- | ------------------- |
| EC-1 | `MessageComposer.tsx:onFiles` 무제한 업로드 → server 422   | HIGH                |
| EC-2 | thread / mobile composer 첨부 미지원 — 본 dim out-of-scope | n/a                 |
| EC-3 | rich URL embed 미구현 (BE follow-up)                       | LOW (의도적 미구현) |

**1 HIGH (EC-1)**, 0 BLOCKER.

## 3. FIX (BLOCKER + HIGH only)

### EC-1: 첨부 파일 client-side cap

`apps/web/src/features/messages/clampAttachments.ts` (신규):

- `MAX_ATTACHMENTS = 10` (server zod schema 와 일치)
- 순수 함수 `clampAttachments({ currentCount, incoming })` →
  `{ accepted, rejected, truncated }`
- truncate 케이스: head 만 accept, tail 은 reject + caller toast

`MessageComposer.tsx:onFiles` 수정:

```ts
const incoming = Array.from(files);
const currentCount = pending.length + jobs.length;
const { accepted, rejected, truncated } = clampAttachments({ currentCount, incoming });
if (truncated) {
  notify({
    variant: 'warning',
    title: '첨부 파일 한도',
    body: `최대 ${MAX_ATTACHMENTS}개까지 첨부할 수 있습니다. ${rejected}개를 무시했습니다.`,
    ttlMs: 4000,
  });
}
if (accepted.length === 0) return;
```

## 4. REGRESSION SPEC

| spec                                                      | cover                                                       |
| --------------------------------------------------------- | ----------------------------------------------------------- |
| `apps/web/src/features/messages/clampAttachments.spec.ts` | 7 boundary tests (cap 0/under/at/over, empty, exact, 11→10) |

기존 `parseContent.spec.tsx` 가 emoji/URL/code/IME 4 edge case 의 regression 을 이미 cover.

## 5. VERIFY

```
$ pnpm verify
... 19/19 successful, 0 errors, 57 warnings (pre-existing)
```

green. clampAttachments.spec 7 tests 통과.

## 6. DECIDE

Round 4 BLOCKER+HIGH = 1 → fix 됨. R5 (모바일 viewport) 로 진행.

## 7. DEVELOP MERGE

(commit + merge 후 SHA 기록)

## 8. PROGRESS LOG

| Round | BLOCKER | HIGH      | MED+ 이월 | 회귀 spec                      |
| ----- | ------- | --------- | --------- | ------------------------------ |
| R4    | 0       | 1 (fixed) | 0         | 1 (clampAttachments — 7 tests) |
