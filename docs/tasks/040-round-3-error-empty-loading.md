# Round 3 — Error / Empty / Loading

## 1. AUDIT

- 도구: 정적 grep (`navigator.onLine`, `RealtimeStatus`, `useMutation.onError`, 빈/로딩 상태)
- 범위: `apps/web/src/**`

발견:

- `RealtimeStatus` 정의 + 추적은 있음 (`useRealtimeConnection.ts`).
  하지만 어떤 UI 도 status 를 소비하지 않음. socket 끊김이 사용자에
  invisible — Discord 처럼 상단 banner 가 필요.
- `navigator.onLine` 리스너 0건. OS 네트워크 끊김이 무반응.
- `useSendMessage.onError` 가 optimistic 메시지 rollback 만 하고
  사용자에게 토스트 / 다이얼로그를 보내지 않음. 메시지가 조용히
  사라짐 — 핵심 채팅 흐름에서 silent failure.
- 401 / 5xx 처리: `lib/api.ts` 가 401 refresh + retry + forcedLogout
  를 잘 함. `bubbleError` 로 5xx 도 statuscode 보존. 채널/DM 흐름의
  consumer (Mutation) 만 표면화 부족.
- Empty/Loading: 텍스트 "불러오는 중…" / "loading…" 다수. Skeleton
  loader 는 없지만 텍스트 fallback 으로 충분 — MED 이월.

## 2. IDENTIFY

| ID   | 위치                                                       | 분류       |
| ---- | ---------------------------------------------------------- | ---------- |
| EE-1 | `useSendMessage.onError` silent 실패 — 토스트 없음         | HIGH       |
| EE-2 | `navigator.onLine` 변화 미감지 → 오프라인 banner 없음      | HIGH       |
| EE-3 | `RealtimeStatus === 'disconnected'` UI 표면화 없음         | HIGH       |
| EE-4 | 텍스트 로딩 → skeleton 변환                                | MED (보류) |
| EE-5 | `MessageItem` edit / `useUpdateMessage`도 same silent 패턴 | MED        |
| EE-6 | `useDeleteMessage`도 same silent                           | MED        |

3 HIGH (EE-1/2/3), 0 BLOCKER. EE-4/5/6 → `TODO(task-040-follow-error-states-edit-delete-skeleton)`.

## 3. FIX (BLOCKER + HIGH only)

### EE-1: send-failure 토스트

`apps/web/src/features/messages/useMessages.ts`:

```ts
onError: (err, _vars, ctx) => {
  if (ctx?.prev) qc.setQueryData(keys.list(wsId, channelId), ctx.prev);
  // task-040 R3: surface send-failure to the user. ...
  const status = (err as { status?: number } | undefined)?.status;
  const code = (err as { errorCode?: string } | undefined)?.errorCode;
  useNotifications.getState().push({
    variant: 'danger',
    title: '메시지 전송 실패',
    body: status === undefined
      ? '네트워크 연결을 확인하세요.'
      : `서버 응답 ${status}${code ? ` (${code})` : ''}. 잠시 후 다시 시도하세요.`,
    ttlMs: 5000,
  });
},
```

### EE-2 + EE-3: ConnectionBanner

신규 컴포넌트 `apps/web/src/features/connection/ConnectionBanner.tsx`:

- `navigator.onLine` 변화 감지 (`online` / `offline` 이벤트)
- `RealtimeStatus` + `replaying` props 소비
- 우선순위: offline > disconnected > replaying > hidden
- `position: fixed; top: 0` + `z-index: 9999` (DS 토큰만 사용 inline)
- `role="status"` + `aria-live="polite"` (a11y)
- DS 4 파일 무수정 — `var(--warn-400)` / `var(--text-strong)` 사용

상태 결정 로직은 순수 함수로 분리:
`apps/web/src/features/connection/computeConnectionBanner.ts`.

mount: `Shell`, `MobileShell`, `DmShell`, `DiscoverShell` 모두에
`<ConnectionBanner realtimeStatus={...} replaying={...} />` 추가.
4 shell 의 `useRealtimeConnection()` 콜에서 반환값 capture
(원래는 side-effect-only 호출이었음).

## 4. REGRESSION SPEC

| spec                                                               | cover                                                                                   |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `apps/web/src/features/connection/computeConnectionBanner.spec.ts` | EE-2/EE-3 banner state matrix (6 tests)                                                 |
| `apps/web/src/features/messages/sendFailureToast.spec.ts`          | EE-1 토스트 push shape (2 tests)                                                        |
| `apps/web/src/features/messages/sendFailureToast.contract.spec.ts` | EE-1 정적 contract: useMessages.ts 의 onError 안에 push 호출이 살아있는지 grep (1 test) |

## 5. VERIFY

```
$ pnpm verify
... 19/19 successful, 0 errors, 57 warnings (pre-existing)
$ cd apps/web && pnpm test
... 11 files passed, 48 tests passed
```

green.

## 6. DECIDE

Round 3 BLOCKER+HIGH = 3 → fix 됨. 다음 round 에서 동일 dim 재 audit
시 0 이어야 dim 종료 (regression spec 으로 확정). R4 (Edge cases)
로 진행.

## 7. DEVELOP MERGE

(commit + merge 후 SHA 기록)

## 8. PROGRESS LOG

| Round | BLOCKER | HIGH      | MED+ 이월 | 회귀 spec                                    |
| ----- | ------- | --------- | --------- | -------------------------------------------- |
| R3    | 0       | 3 (fixed) | 3         | 3 (computeBanner / sendFailToast / contract) |
