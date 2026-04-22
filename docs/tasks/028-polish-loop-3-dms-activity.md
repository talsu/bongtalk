# Task 028 — Polish Loop #3 (Round 8+, DMs / Activity new surfaces) → main deploy

## Context

027 shipped 1:1 DMs + mobile tabbar all-tabs-active + an
accidental reviewer catch of a 15-task-latent `req.member` typo in
ChannelAccessGuard. DMs and Activity inbox are the newest user-
facing surfaces and the current 27 polish specs (14 desktop +
13 mobile) don't cover them yet. 028 reruns the 021/022/025 loop
machinery with 10 new harness scenarios targeted at these
surfaces.

## Loop structure

Identical to 021/022/025. Round numbering continues from R7 →
**R8 onward**. Same `polish-backlog.md`, same commit prefix
`fix(polish-R<N>-<slug>)`, same exit criteria.

## Scope (IN)

### A. Harness extension (10 new specs)

Total polish harness 27 → 37. New specs under
`apps/web/e2e/polish/` (desktop) or `apps/web/e2e/mobile/`
(mobile viewport).

**DMs (5 specs):**

- **`dm-unread-badge.polish.e2e.ts`** — DM 수신 후 server rail
  - mobile tab badge 2초 이내 count 반영; 읽으면 즉시 clear
- **`dm-list-sort-stability.polish.e2e.ts`** — 새 메시지 도착
  시 DM list가 last-activity desc로 재정렬; 스크롤 보존
- **`dm-realtime-parity.polish.e2e.ts`** — DM 채널의 실시간
  (typing, presence, message append) 동작이 일반 채널과 동등
- **`dm-scroll-behavior.polish.e2e.ts`** — DM 채널 scroll
  autobottom / prepend (021의 scroll 규약 준수)
- **`dm-mobile-fab-flow.polish.e2e.ts`** — 모바일 FAB 클릭 →
  멤버 검색 sheet → 생성 → chat으로 이동 (ScreenDMs 기반)

**Activity (3 specs):**

- **`activity-live-update.polish.e2e.ts`** — 4 sources (mention
  / reply / reaction / direct) 수신 시 inbox 즉시 prepend +
  스크롤 안 튐 (사용자가 중간 스크롤 중이면 "N new" pill)
- **`activity-filter-direct-row.polish.e2e.ts`** — 4 필터 (All
  / Mention / Reply / Reaction) 정확성 + DIRECT 정규화된 포함
  방식 (026 → 027 확장 후 Activity에 DIRECT가 나오는지)
- **`activity-mark-all-read-large.polish.e2e.ts`** — 50+ row
  일괄 read 처리 (026-follow-2 재현 + fix 검증)

**통합 (2 specs):**

- **`mobile-all-tabs-navigate.polish.e2e.ts`** — 4탭 Home →
  DMs → Activity → You 왕복 이동 시 각 탭의 state (스크롤,
  필터, 현재 DM 대상 등) 유실 없음
- **`cross-surface-unread-parity.polish.e2e.ts`** — DMs 수신
  / mention / reply / reaction 각각에 대해 server rail badge
  - Activity counter + Channel unread dot이 동일 count로 반영

### B. Backlog seed (INIT append)

`docs/polish-backlog.md`에 새 rows append (021~027 rows 전부
유지). seed 후보 (Discovery가 confirm):

- `dm-unread-not-clearing-after-read` (HIGH, realtime)
- `activity-direct-source-missing` (HIGH, realtime) — 026
  UNION에 DIRECT 포함 안 됐을 수도
- `dm-list-last-message-cache-drift` (MED, realtime)
- `mobile-fab-shadow-overlap` (MED, ui)
- `activity-unread-count-drift` (MED, realtime)
- `notification-preference-direct-ui-row` (MED, ui) — 019
  설정 페이지에 DIRECT row 표시 여부
- `dm-self-chat-button-state` (LOW, ui)

Exact severity는 R8 Discovery에서 확정. 일부는 cannot-repro
가능 (harness pass).

### C. Round 8+ execution

Identical 8-step loop:

1. Discovery — run all 37 polish specs
2. Backlog update (status 컬럼 변경)
3. Pick top 6 — area `direct` / `activity` 우선, 동일 severity
   시 detection 오래된 것 먼저
4. Fix + regression test (각 fix 1 commit)
5. Reviewer subagent per Round
6. `pnpm verify` green
7. Progress log append (§ Rounds below)
8. Exit check (021/022/025와 동일):
   - open CRITICAL+HIGH = 0 → EXIT normal
   - 2 consecutive Rounds 0 new HIGH → EXIT converged
   - Round > R10 (Max 3 in this task) → EXIT cap
   - wall > 3h → EXIT cap
   - user "stop polish" → EXIT user
   - verify red 3× → abort

### D. Final merge + auto-promote + deploy verify

Standard per `feedback_auto_promote_to_main.md`:

1. `git checkout develop && git pull --ff-only && git merge --no-ff feat/task-028-polish-loop-3-dms-activity -m "Merge task-028: polish loop #3 — DMs+Activity surfaces (R8..R?)" && git push origin develop`
2. `git checkout main && git pull --ff-only && git merge --no-ff develop -m "Deploy task-028 to prod: polish loop #3" && git push origin main`
3. Wait 1–3 min, verify `/volume2/dockers/qufox-deploy/.deploy/audit.jsonl` last entry `exitCode=0` + sha, `/readyz` 200, idle-window 30s

### E. Pane 1 auto-forward (6th application)

Per memory. Standard format.

## Scope (OUT)

- New product features (Voice, Group DM, Friend system, Custom emoji)
- 021/022/025에서 resolved된 rows — harness 재실행에만 참여
  (regression guard), 재fix 대상 아님 (harness가 fail하면 reopen)
- 모든 026/027 follow 자동 처리는 아님 (harness가 surface하면
  처리, 수동 pick X)
- mecab-ko / Loki / PITR / sops

## Acceptance Criteria (mechanical)

- `pnpm verify` green at FINAL.
- 10 new harness specs present (5 DMs + 3 Activity + 2 integration).
- Round R8+ commits prefixed `fix(polish-R<N>-<slug>)`.
- `docs/polish-backlog.md` extended with new DMs/Activity rows;
  021~027 rows preserved.
- Reviewer subagent per Round with token count recorded.
- 3 artefacts: `028-*.md`, `028-*.PR.md`, `028-*.review.md`
  (aggregate reviewer output across Rounds).
- Direct develop merge.
- develop → main auto-promoted via webhook.
- `audit.jsonl` last entry `exitCode=0` + sha matches main tip.
- `/readyz` 200 + idle-window 30s verified.
- **Pane 1 auto-forwarded** FINAL summary (6th application).
- Feature branch retained.
- FINAL REPORT auto-printed, includes:
  - Round count (R8..R?), wall clock, exit reason
  - Per-Round commit + reviewer table
  - Backlog snapshot (021~028 separated; resolved in this task
    by area)
  - develop SHA + main SHA + deploy exitCode + /readyz + idle-
    window + deploy duration
  - qf-m-\* usage count post-task (for trend)

## Prerequisite outcomes

- 027 merged + deployed (`19e370e` main).
- `polish-backlog.md` with 021~027 rows intact.
- DMs + Activity + all-tabs-active live on prod.
- `feedback_auto_promote_to_main` + `feedback_pane0_auto_forward_report`
  memories active.

## Design Decisions

### Round numbering continues (R8+)

Same polish machine, just different surfaces. `git log --grep
'polish-R'` stays one ascending series.

### Harness count: 10

5 DMs + 3 Activity + 2 integration. 025에서 6개 모바일 추가했던
precedent. DMs는 서버 채널 + unread + realtime + 모바일 전부
연관이라 커버리지 필요. Activity는 026 이후 큰 변경 없어서 3개면
충분. 통합 2개는 탭 간 일관성 검증.

### Max Round 3 (R8 ~ R10)

025와 동일. 수렴 패턴이 2 Round였던 전례. 3 Round 이전에
normally exit.

### Round cap 6, Wall 3h

021/022/025 동일.

### 통합 harness가 탭 왕복 state 검증

024 이후 4탭 다 enabled가 된 첫 task. 탭 이동 시 React remount
/ state reset / 스크롤 위치 유실 여부는 이번에만 생기는 관심사.

### 인 branch review at each Round

015-R1 이후 일관된 패턴. reviewer token 비용은 polish 가치
대비 작음.

## Non-goals

- 021~027 resolved rows 재심사
- 새 기능 추가
- DS mobile.css / tokens.css / components.css 수정
- Mock iOS device 렌더링 업데이트
- mobile.css에 새 qf-m-\* 클래스 추가 (DS source of truth)

## Risks

- **DM harness가 관측하는 cache drift가 R8에서 많이 나올 수 있음**
  — 027이 신선하고 dispatcher invalidation 분기가 새로 추가
  됐기 때문. Round cap 6 + Max 3 Round가 버퍼.
- **Activity DIRECT source 누락이 실제로 있다면** HIGH로 잡힘.
  026 UNION 쿼리에 `type='DIRECT'` 메시지가 `mention` source에서
  어떻게 처리되는지 확인 필요. (DM에 @mention이 없다는 가정이
  깨지면 누수 가능)
- **통합 harness가 flaky**: 4탭 왕복 네비는 route 변화 + React
  remount + WS re-subscribe 등 타이밍 이슈가 많음. `waitFor`
  deadline 넉넉히 + pixel 위주 assertion.
- **R8에서 많은 새 HIGH 발견** → Round cap 초과. 일부는 R9로
  이월. Max Round 3 cap이 있으니 최대 18 fixes 처리 가능. 초과는
  FINAL REPORT에 남기고 029 task로 이월.
- **027이 만든 P2002 race fix가 R8 regression test에 잡혀야** —
  dm-create-flow 재실행으로 guard 유지.

## Progress Log

_Implementer 채움. Append per Round._

- [ ] UNDERSTAND (027 follow + 026 follow 재검토, harness 스펙
      시나리오 확정, polish-backlog.md 현 상태 확인)
- [ ] PLAN approved
- [ ] SCAFFOLD (10 harness 스펙 red)
- [ ] INIT (harness 실행 baseline, backlog seed append)
- [ ] Round loop begins at R8 (§ Rounds below)
- [ ] EXIT condition met + reason recorded
- [ ] FINAL merge + promote + deploy verify
- [ ] FINAL REPORT auto-printed + pane 1 auto-forwarded

## Rounds

_Implementer appends per Round._

### Round 8

_(not yet run)_

### Round 9

_(not yet run)_

### Round 10

_(not yet run)_

## Final REPORT

_(filled at EXIT)_

- Total Rounds run (R8..R?):
- Wall clock:
- Exit reason:
- Backlog snapshot by area:
  - Resolved this task: CRITICAL/HIGH/MED/LOW/NIT by (direct, activity, mobile, ui)
  - Still-open:
  - Deferred / cannot-repro:
- develop merge SHA:
- main merge SHA:
- Deploy exitCode:
- /readyz:
- Idle-window verified:
- Deploy duration:
- qf-m-\* usage count post-task:
- Pane 1 auto-forward: success / warning
