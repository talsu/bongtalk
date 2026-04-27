# Task 040 — Reviewer subagent transcript summary

스폰 1회 (반복 룰 준수). 제외: 종합 verify 후 1회.

## 호출

- Subagent type: `reviewer`
- Approx transcript token count: **~5300 tokens** (≈4000 words / 0.75)
- 60 tool calls, 352 sec wall

## 발견

### BLOCKER

해당 없음.

### HIGH (fix-forward 즉시 적용)

- **H1 — ConnectionBanner mount 누락 (early-return paths)**

  - Shell / MobileShell / DiscoverShell 의 `isLoading` / `0-workspaces`
    / `not-found` 분기에서 banner JSX 가 빠져 있음. 가장 빈번한 blank
    page 구간에서 미표시.
  - **Fix**: `App.tsx` 에 `AppRealtimeHost` 신규 컴포넌트로 hoist.
    `useRealtimeConnection()` 단일 호출 + `<ConnectionBanner>` 마운트.
    4 shell 의 capture + mount 제거. socket.ts 가 이미 singleton 이라
    side-effect 동등.
  - Commit: `347f762`

- **H2 — ConnectionBanner DOM-render 테스트 없음**
  - `computeConnectionBanner` 순수 함수만 테스트, React 마운트 +
    `online`/`offline` 이벤트 wiring 미검증.
  - **결정**: vitest env=node 한계 (jsdom 추가 필요). 본 task scope
    초과. **TODO(task-040-follow-banner-dom-render-test)** 로 이월.

### MED (이월)

- **M1** banner z-index 9999 fixed → 토픽바 overlay → `task-040-follow-banner-topbar-offset`
- **M2** sendFailureToast spec 가 grep 기반 → mutation-driven 테스트 추가 필요 → `task-040-follow-send-fail-mutation-test`
- **M3** `clampAttachments` double-pick race (closed-over state) → `task-040-follow-clamp-race`
- **M4** `MobileFriends` username input allowlist 재검토 → `task-040-follow-friends-input-label`

### LOW (이월)

- **L1** vendor-react 53.36/55 KB headroom 좁음
- **L2** input-label-guard 정규식 한계 (createElement 미감지)
- **L3** notification-store id 충돌 확률 ~1/1.7M

## Security

- OWASP Top 10 0 issue.
- ToastViewport 가 `dangerouslySetInnerHTML` 미사용 → server errorCode
  XSS 위험 없음.
- DS 4파일 md5 baseline 일치 (변조 없음).

## Performance

- 신규 ConnectionBanner chunk 4.49 KB gzip (별도 split). 초기 entry/
  Shell 영향 없음.
- `useRealtimeConnection` rerender 빈도 변화 없음.
- `input-label-guard.spec.ts` 의 `find ... -name '*.tsx'` 셸 exec —
  bounded by `apps/web/src` size, 매 verify 1회.
- N+1 / O(n²) 패턴 없음.

## Verdict

`request-changes` (H1+H2 fix 권장) → H1 fix-forward 즉시 적용 후
`approve-with-followup` 로 승격. 전체 BLOCKER 0, 기능 회귀 없음, DS
무수정, 보안 무영향. main auto-promote 통과.

## Co-Authored-By: Claude Opus 4.7 (1M context) &lt;noreply@anthropic.com&gt;
