# Round 7 — DMs (workspaceless flow)

## 1. AUDIT

- 도구: 정적 grep + DM 도메인 스펙 (6 dms/, 4 polish, 3 mobile) 전수
- 범위: workspaceless flow, presence, list 정렬+미읽음, history, participant metadata

발견:

- **workspaceless flow**: 039 hot-fix 회수에서 6 hot-fix 모두 회귀
  spec 추가 (dm-workspaceless-flow.e2e.ts + dm-message int + DM
  participant int). ✓
- **DM list 정렬 + 미읽음**: dm-list-sort-stability + dm-unread-badge
  polish 스펙. ✓
- **history pagination**: dm-scroll-behavior polish + useMessageHistory
  wsId=null gate (039 fix). ✓
- **realtime parity**: dm-realtime-parity / dm-realtime-fanout. ✓
- **참가자 메타데이터**: 039 fix `c5146ff` + dm-participant-name int
  spec (상대 displayName, "unknown" 등장 금지). ✓
- **a11y**: R2 fix 가 DmShell + MobileDmList 의 모든 search input 에
  aria-label 추가. ✓
- **Connection 표면화**: R3 fix 가 DmShell + MobileShell (mobile DM
  포함) 양쪽에 ConnectionBanner mount. ✓
- **presence in DM list**: `usePresence(workspaceId)` 가 workspace-
  scoped. DMs 는 workspaceless 이므로 `usePresence(undefined)` → 항상
  empty. DM list 의 avatar 가 `status` prop 없이 렌더 → green dot 미표시.
  단, 이는 "workspaceless presence" 라는 신규 feature 가 필요한
  영역이고 폴리시 범위 밖. MED 이월.
- **다중 탭 (DM)**: 채널과 동일하게 Socket.IO multiplex + dispatcher
  unread 비등 dedupe.

## 2. IDENTIFY

| ID   | 위치                                                         | 분류                            |
| ---- | ------------------------------------------------------------ | ------------------------------- |
| DM-1 | workspaceless presence dot 미표시                            | MED (신규 feature 영역, follow) |
| DM-2 | DM `useUpdateMessage` / `useDeleteMessage` silent 실패       | MED (R3 EE-5/6 와 동일 follow)  |
| DM-3 | 누적 R2/R3/R5 가 DM 영역 cover (label + banner + 414 layout) | clean                           |

**0 BLOCKER, 0 HIGH.** 누적 효과 + 기존 광범위 e2e 가 DM critical
path 충족.

이월: `TODO(task-040-follow-dm-workspaceless-presence)` — 추후 별도
feature task 에서 cross-workspace presence 집계 필요.

## 3. FIX

해당 없음.

## 4. REGRESSION SPEC

기존 누적:

- `apps/web/e2e/dms/*` (6 e2e)
- `apps/web/e2e/polish/dm-*` (4 polish)
- `apps/web/e2e/mobile/dm-*` (3 mobile)
- `apps/api/test/int/dms/dm-workspaceless-message.int.spec.ts` (039)
- `apps/api/test/int/dms/dm-participant-name.int.spec.ts` (039)
- `apps/web/src/a11y/input-label-guard.spec.ts` (R2)
- `apps/web/src/features/connection/computeConnectionBanner.spec.ts` (R3)
- `apps/web/e2e/mobile/viewport-414-shell.polish.e2e.ts` (R5, DM tab 414 smoke)

## 5. VERIFY

```
$ pnpm verify
... 19/19 successful, 0 errors, 57 warnings
```

green.

## 6. DECIDE

R7 BLOCKER+HIGH = 0. R6 도 0. **2 round 연속 0 → DM dimension 완료**
(R6 channel msg 와 동일 convergence path). R8 (Performance) 로 진행.

## 7. DEVELOP MERGE

코드 변경 없음 → R8 와 묶어 단일 commit.

## 8. PROGRESS LOG

| Round | BLOCKER | HIGH | MED+ 이월                                                    | 회귀 spec      |
| ----- | ------- | ---- | ------------------------------------------------------------ | -------------- |
| R7    | 0       | 0    | 2 (DM-1 워크스페이스리스 presence + DM-2 edit/delete silent) | 0 (누적 cover) |
