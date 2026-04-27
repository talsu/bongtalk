# Task 041 — Reviewer subagent transcript summary

스폰 1회 (반복 룰 준수). 종합 verify 후 1회만.

## 호출

- Subagent type: `reviewer`
- Approx transcript token count: **~7,700 tokens** (≈5800 words / 0.75)
- 83 tool calls, 445 sec wall

## 발견

### BLOCKER

해당 없음.

### HIGH (전부 fix-forward)

- **H1 — `h-screen` / `min-h-screen` overflow when banner ON**

  - AppLayout flex-column 안에서 `flex: 1; minHeight: 0` 으로 Routes 컨테이너가 banner 만큼 줄어듦. 자식이 viewport-relative 를 쓰면 100vh > 부모 → 오버플로우. 9 사이트 영향.
  - **Fix** (663ddb1): `h-screen` / `min-h-screen` → `h-full` / `min-h-full` 일괄 교체
    - LoginPage, SignupPage, InviteAcceptPage(3), NotificationSettingsPage, FriendsPage, DiscoverPage, ActivityPage, ProtectedRoute auth-loading

- **H2 — SignupPage `htmlFor` 적용 누락**

  - 1차 Edit 가 실제 반영되지 않음 (PR.md 클레임은 적었으나 source 가 그대로). 리뷰어가 grep 으로 적발.
  - **Fix** (663ddb1): SignupPage 3 input 모두 `htmlFor` + `id` 추가, post-write grep 으로 검증

- **H3 — input-label-guard 가 `<input>` 만 cover**
  - regex `/<input\b.../` → `<textarea>` / `<select>` 누락. FeedbackDialog (select+textarea) / WorkspaceMembersModal (select) / ThreadPanel (textarea) 가 정적 audit 사각지대.
  - **Fix** (663ddb1):
    - regex `/<(input|textarea|select)\b.../` 로 확장
    - FeedbackDialog `htmlFor` + `id` 바인딩
    - WorkspaceMembersModal select aria-label 추가
    - ThreadPanel textarea aria-label 추가
    - `<Input>` (대문자 DS primitive) 정적 미감지는 알려진 한계 → `task-041-follow-jsdom-testing-env` 이월

### MED (이월)

- M1 useDmPresence 메모이제이션 부재 — `task-041-follow-presence-memo`
- M2 composer attachment race 함수형 업데이터 안 reconcile — `task-041-follow-composer-race-fix`
- M3 setState-after-unmount 시 console.error — `task-041-follow-mutation-unmount-cleanup`
- M4 성공 delete 사용자 신호 부족 — `task-041-follow-delete-success-toast`
- M5 e2e single-mount under-tests — `task-041-follow-banner-multi-shell-e2e`
- M6 iOS Safari address-bar transition 스크린샷 — `task-041-follow-ios-banner-screenshot`

### LOW (관찰만)

- L1 `Promise.resolve(onDelete())` 중복 → 향후 cleanup
- L2 `id={...}` JSX expression 형태 정적 미인식
- L3 `buildSendFailureToastBody` 비-Error 던질 때 네트워크 메시지로 false-attribute
- L4 RailBtn/RailAvatar tooltip semantic 손실 (모바일 한정)
- L5 useDmPresence 초기 렌더 cache 빈 walk

## Security

- OWASP Top 10 0 issue
- DS 4파일 md5 baseline 일치
- `Object.defineProperty(navigator.onLine, ...)` 는 e2e 컨텍스트 한정 — prod 영향 없음
- TanStack Query v5 `Mutation.execute()` 는 public API (`hydration-mKPlgzt9.d.ts:466`)

## Performance

- 신규 ConnectionBanner chunk 4.49 KB gzip → 변동 없음 (A-1 은 layout 만)
- useDmPresence 의 cache walk는 O(presence keys × users) — 이번엔 cap 작아 OK, M1 으로 모니터링

## Verdict

H1+H2+H3 fix-forward 후 → **approve**.

원래 verdict 는 `request-changes` 였으나 BLOCKER 0 + 3 HIGH 모두 main promote 전에 663ddb1 로 즉시 패치. DS 무수정, perf 영향 없음, security 무이슈.

## Co-Authored-By: Claude Opus 4.7 (1M context) &lt;noreply@anthropic.com&gt;
