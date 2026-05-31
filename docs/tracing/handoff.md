# qufox 자율 슬라이스 루프 — 세션 핸드오프

> 이 파일은 새 세션에서 작업을 이어가기 위한 단일 진입점입니다.
> **S05 검증·S06·S07 완료(아래 ✅). 자율 슬라이스 루프 진행 중 — 다음 활성 슬라이스는 S08.**
> 상태 원본: `docs/tracing/{slice-backlog.md, slices.json, fr-matrix.csv, carryover.md}`.

---

## 현재 상태 (2026-05-31)

- 완료·배포: **S00~S05 + S05 검증/fix-forward**. 프로덕션 라이브.
  - 직전 배포 기준 `main = a75655b`, `develop = da2df94` (feat 브랜치 보존).
  - S05 검증 머지(SHA/배포 결과)는 이 세션 REPORT 및 git log 참조.
- S04 빌드 게이트: `.github/workflows/ci.yml`이 `pnpm verify` 뒤에 production 빌드
  3종(shared-types/web/api)을 돌려 rollup/swc 해석 실패를 배포 전 차단.

## ✅ S05 검증 완료 (2026-05-31, 이 세션)

핸드오프 0-1~0-4 를 실행하고, **실제 Postgres(testcontainers)** 로 편집/삭제/이력을 검증했습니다.
정적 스텁만으로 가려졌던 **BLOCKER 1 + HIGH 3 을 발견·fix-forward** 했습니다.

- **0-1 실DB 통합 검증**: `apps/api/test/int/messages/messages.edit-history.int.spec.ts` 신규.
  정상편집(version+1·EditHistory 1행)·stale/동시편집 409+details.current(채널격리)·ring buffer 11→10·
  history 권한(작성자·OWNER·ADMIN 200 / 비작성자 403) 전부 GREEN.
- **발견·수정한 진짜 버그(스텁이 가렸던 것)**:
  1. **BLOCKER** — DM 편집 전면 불능: `MessageAuthorGuard` 가 `:chid` 만 읽어 DM 라우트
     (`me/dms/:channelId/messages`)에서 무조건 400. `chid ?? channelId` fallback 으로 수정 + DM 편집 int 추가.
  2. **HIGH** — `softDelete` TOCTOU: `update({id})` → 동시/재시도 삭제가 중복 MESSAGE_DELETED
     - deletedAt 재기록. `updateMany({id,channelId,deletedAt:null})` + count 가드로 데이터레이어 idempotent.
  3. **HIGH** — 라이브 (수정됨) 뱃지 미전파: MESSAGE_UPDATED nested payload 에 `edited` 누락 →
     `edited:true` 추가.
  4. **HIGH** — 모바일 (edited) 뱃지 + DS 클래스: `qf-m-message*`(DS 미등록)→`qf-m-msg*` 교정 +
     `__bubble` 제거 + 뱃지 추가.
- **0-3 갭 결정**: 모바일 (edited) 뱃지·DS 클래스 = **닫음**. 모바일 편집 **개시** UI(#5, HIGH) =
  mobile parity 슬라이스로 **연기**. FR-MSG-09 REST placeholder = **S33~S38(threads)로 연기**.
- **0-4 fr-matrix**: FR-MSG-06/07/RC16 = `done`(실DB 검증). FR-MSG-09 = `partial`(WS live done,
  REST placeholder 연기).
- **비회귀 발견**: `threads.int.spec.ts` 1건 RED(message.created 의 parentMessageId=null) — 선제존재
  task-014-B 버그, int 미실행으로 가려짐. S05 무관. carryover → D04(S33~S38).

게이트: `pnpm verify`(19 tasks, api 316·web) + 빌드 3종 + int(edit-history 11·dm 6·events 4) + reviewer approve 전부 GREEN.

---

## ✅ S06 완료 (2026-05-31, 이 세션)

frontend-only(`apps/web/src/features/messages/**`). 조사 결과 그룹핑(FR-MSG-10)·
스포일러(FR-MSG-16/RC14)는 S04/renderAst 에 이미 존재 → 재구현 없이 미구현분만 구현:

- **FR-MSG-12** 정밀 타임스탬프 포맷터(`formatMessageTime.ts`): 오늘 HH:MM(24h)/오전·오후(12h)·
  어제·N일 전·이전 'YYYY년 MM월 DD일' + ISO tooltip. clock24h 12/24h 토글 store 는 D14 후속(기본 24h).
- **FR-MSG-11** 날짜 구분선 + 자정 경계 그룹 강제 분리(grouping.ts `isSameLocalDay`).
- **FR-MSG-10** continuation 행 hover gutter 시각(`qf-message__gutter-time`).
- **FR-RC15** 이모지 1~3개 본문 32px(`jumboEmoji.ts`, `--fs-32`).
- **FR-MSG-22** 빈 채널 상태 보강(채널명·생성일·타입별 카피·topic; DS `.qf-empty`).
- 구현은 `feature-implementer` 위임 → 5팀 리뷰(reviewer/ui-designer/a11y/visual/perf) →
  fix-forward: invalid-iso 가드(F1, 렌더 크래시 회귀), 날짜 구분선/빈상태 a11y(`<time>`·h2·aria-label).
- MED/LOW(키보드 hover 접근=DS 후속, React.memo perf, e2e 커버리지, 커스텀이모지 jumbo)는 carryover.
- 게이트: verify 19 + 빌드 3종 + web 단위 159 GREEN. fr-matrix S06 7개 done.

## ✅ S07 완료 (2026-05-31, 이 세션)

D17 realtime backend. 게이트웨이가 이미 성숙(CONNECTION_READY 스키마·ws-auth·eager-join·redis adapter) → 갭만 최소 변경:

- **FR-RT-20** transports:['websocket'] 전용 + pingInterval 25000/pingTimeout 20000/maxHttpBufferSize 1MB(Node 힙은 compose 후속).
- **FR-RT-02** 채널 50-cap(eager-join, newest-first; **DM/override 우선 정렬로 cap 면제 — review MAJOR-2 fix**).
- **FR-RT-16** sharded redis adapter(createShardedAdapter) + **adapter 클라 keyPrefix='' — review BLOCKER-1 fix**(qufox: prefix 가 sharded SSUBSCRIBE 채널 라우팅을 깨던 무음 드롭 해소).
- **FR-RT-01** CONNECTION_READY{userId,sessionId} emit — **실제 갭이었음**(스키마만 있고 게이트웨이 미emit) → 추가.
- **FR-RT-21** user room join + userId-scoped 라우팅 — 이미 충족(확인).
- 다팀 리뷰(reviewer/security/contract) → BLOCKER-1·MAJOR-2 fix-forward. MED/LOW(WS CORS origin:true, connection:ready 명명=S10, refresh leave 비대칭)는 carryover.
- 게이트: verify 19 + api build + realtime int(multi-node/fanout/handshake/reconnect/channel-cap 3, sharded cross-node 검증) GREEN. fr-matrix S07 5개 done.

## 다음 슬라이스: S08 (D17 realtime backend)

- backend, scope `apps/api/src/messages/**,apps/api/src/realtime/**`.
- REST POST 메시지 → WS message:created fanout + DB UNIQUE 멱등 1차방어 + 커서 페이지네이션 정합.
- FR-RT-03/04/15. depends S07(완료),S03(완료).
- **backend 슬라이스라 `test:int` 실DB(WS) 검증 필수**. 기존 `apps/api/test/int/messages|realtime/` 활용.
- 주의: 메시지 send→outbox→WS fanout 경로는 이미 성숙(S02~S05) — 갭만 식별해 최소 변경. FR 정본: PRD html.
- **참고**: S10(FR-RT-23)에서 WS 이벤트명 콜론/닷 단일출처 정비 예정(S07 carryover).

---

## 슬라이스 루프 프로토콜 (메가루프)

1. **UNDERSTAND**: slices.json의 해당 슬라이스 + FR 정본(PRD html) + 현재 코드 델타.
2. **IMPLEMENT**: 큰 fullstack은 `feature-implementer` 서브에이전트에 정밀 스펙 위임,
   작은 건 직접. red→green→refactor. 커밋은 리뷰 후 메인 루프에서.
3. **다팀 리뷰**(병렬, read-only): `reviewer` + `security-scanner` + `contract-validator` +
   `performance-profiler` + (UI 변경 시) `ui-designer`. BLOCKER/HIGH는 fix-forward,
   MED/LOW는 `carryover.md` 기록.
4. **VERIFY**: fix 후 `pnpm verify`(19 tasks) + 빌드 3종 green.
   **fullstack/마이그레이션 슬라이스는 `test:int`로 실DB 검증까지** (S05 교훈 — 스텁만으로 done 금지).
5. **추적**: `fr-matrix.csv` FR todo→done(검증 근거와 함께), `carryover.md` 갱신.
6. **머지**: feat/sNN → develop(--no-ff) → main(--no-ff), 셋 다 push. **feat 브랜치 삭제 금지**.
7. **배포**: main push가 webhook auto-deploy 트리거. 결과 =
   `/volume2/dockers/qufox-deploy/.deploy/audit.jsonl`의 `deploy.result.exitCode` +
   /readyz·/healthz·web 200. prod 마이그레이션은 api 컨테이너 CMD `prisma migrate deploy` 자동.
   실패 시 /readyz 게이트가 `:prev`로 auto-rollback.
8. **REPORT**: 머지 SHA(develop/main) + 리뷰 요약 + verify/빌드/검증 결과 + 배포 exitCode + carryover.

## 주의사항

- `scope_allow`가 FR 요구를 못 담는 경우 있음(S01 토대 누락분 — S05가 prisma+shared-types로
  확장한 선례). 필요 시 확장하되 Safe Autonomy 범위 내, `carryover.md`에 편차 기록.
- 폴라이트 한국어(~합니다/~세요)만. DS 4파일(`apps/web/public/design-system/*`) 절대 수정 금지,
  `qf-*`/`qf-m-*` 토큰만(raw hex/px 금지). 호칭은 "MinIO"(코드만 S3).
- `.claude/settings.json`의 워킹트리 변경($schema url)은 무관 — 스테이징/커밋 금지.
- prod DB 직접 접근 / prod 시크릿 쓰기 / main force push 금지.

## carryover.md의 임박 항목 (해당 슬라이스 진입 시 함께 처리)

- **S12~S15(D02 채널 권한)**: S00 allowMask BLOCKER + S05 채널 권한 마스크(MANAGE_MESSAGES
  비트) 헬퍼 미배선(현재 role 기반 보수 게이트).
- **S33~S38(D04 threads)**: S05 FR-MSG-09 placeholder REST read-path 보강.
- **S19/S20(D03 DM)**: S05 DM `/history` 엔드포인트 미구현.
- **mobile parity 슬라이스**: S05 모바일 (edited) 뱃지 + MobileMessages `qf-m-message` 클래스 교정.
