# Task 043 — Reviewer subagent transcript summary

스폰 1회.

## 호출

- Subagent type: `reviewer`
- Approx transcript token count: **~38,000 tokens**
- 39 tool calls, 257 sec wall

## 발견

### BLOCKER

해당 없음.

### HIGH (5건 fix-forward, 1건 follow-up)

- **H1 — anchor e2e 가 실제 invariant 미검증** → fix-forward

  - `before/after` 둘 다 non-null 만 검증, delta 비교 없음. anchor 코드를 삭제해도 spec 통과.
  - **Fix**: `before.delta` (topmost row 의 list 상단 대비 y offset) 캡처 → prepend 후 `after.delta` 측정 → `Math.abs(before.delta - after.delta) <= 5` assert.

- **H2 — Scrollable padding 으로 인한 8px drift** → fix-forward

  - `py-[var(--s-3)]` 가 inner virtual-list-inner 외부에 있어 scrollTop coordinate system mismatch.
  - **Fix**: padding 제거. snapshot/restore 가 같은 좌표계 사용해도 `scrollToIndex('end')` 가 padding box 만큼 어긋남. visual breathing room 은 deferred (페이지 스크롤이 자연스럽게 처리).

- **H4 — prepend vs append 구분 못함** → fix-forward

  - `messages.length > prevLen` 만 체크. WS append 시 snapshot 이 살아있으면 prepend 분기 잘못 진입.
  - **Fix**: `prevFirstIdRef` + `prevLastIdRef` 추가 → `isPrepend` (first id 변경) vs `isAppend` (last id 변경) 명시 분기. WS append 분기는 무조건 anchorSnapshotRef 클리어.

- **H5 — scroll listener 매 render 재부착** → fix-forward

  - `[history, messageIds, virtualizer]` deps 가 fresh-per-render → remove/add 윈도우 사이 momentum scroll event 누락.
  - **Fix**: refs (`messageIdsRef`, `historyRef`, `virtualizerRef`) 도입 + listener effect deps `[]` (mount 1회).

- **H6 — e2e seed 가 API rate-limit 초과** → fix-forward

  - `MESSAGE_RATE_USER_MAX = 30/10s` vs 25 concurrent × 40 batch = 정지점에서 throttle.
  - **Fix**: BATCH=5 + PACE_MS=1700 (≈17/10s, 한도 내). seed 수 1000→120 (DOM cap 검증에 충분).

- **H3 — restore-while-user-moved-on race** → MED 이월
  - 사용자가 momentum scroll 로 이미 다른 위치에 있는데 prepend 결과가 강제로 복원.
  - 이월 사유: edge case (fast scroll + slow fetch), UX glitch 1 frame, prod 영향 작음.
  - `task-043-follow-anchor-fast-scroll-detect`

### MED (이월)

- M1 first-paint scrollToIndex before measureElement → `task-043-follow-first-paint-restable`
- M2 iOS momentum scroll listener 호출 빈도 → `task-043-follow-listener-raf-throttle`
- M3 e2e cap ≤ 60 너무 loose → fix-forward (M3 도 cap 을 50 으로 강화)
- M4 useLayoutEffect deps 에 virtualizer (이미 stable 이라 사실상 무영향) → 코멘트 정리
- M5 empty-state + hasNextPage 동시 표시 transient 1 frame → `task-043-follow-empty-state-gate`

### LOW (관찰만)

- L1 negative offsetWithinRow → fix-forward (`Math.max(0, restored)`)
- L2 startForIndex 폴백 cache 사용 → fix-forward (`virtualizer.measurementsCache[i]?.start`)
- L3 height 숫자 React 직렬화 → 비-bug
- L4 measureElement ref attach to wrapper → 비-bug
- L5 messageIds closure → H5 와 함께 해결됨
- L6 eval 번호 053 (task 043) → 레포 컨벤션 (eval = task + 10)

### 추가 fix-forward (M3)

- `virtualization.e2e.ts` rowCount cap 60 → 50 (acceptance criterion 과 정확히 일치)

### 보안

- OWASP Top 10 0 issue.
- DM channel access 무영향. anchor helpers 가 string id + numeric offset 만 처리.

### 성능

- DOM node O(N) → O(visible+overscan), bundle +5.58 KB gzip in lazy MessageColumn chunk.
- iOS momentum scroll 리스너 호출 빈도는 M2 로 모니터.
- N+1 / O(n²) 도입 없음.

### Test coverage

- B-1 anchor invariant: ✅ fix-forward 후 5px tolerance 실제 검증
- B-3 resize: 미검증 (follow-up `task-043-follow-resize-e2e`)
- B-4 row height shift: 미검증 (follow-up `task-043-follow-row-shift-e2e`)
- WS append while scrolled-up: dm-realtime-parity polish 누적 cover

### Note: prompt injection 의심 (false alarm)

리뷰어가 conversation 시작점의 MCP 서버 인스트럭션 (`qufox-avdb`) 을 prompt injection 시도로 다시 의심. 실제로는 runtime 의 deferred-tool listing 이며 합법 시스템 제공. 042 review 와 동일한 false alarm.

## Verdict

**approve** (H1+H2+H4+H5+H6 fix-forward + M3 cap 강화 후).

원래 verdict 는 `request-changes` 였으나 5 HIGH + 1 MED 즉시 main promote 전 패치. H3 + M-tier + L-tier 잔여는 `task-043-follow-*` 이월.

## Co-Authored-By: Claude Opus 4.7 (1M context) &lt;noreply@anthropic.com&gt;
