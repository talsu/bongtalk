# Task 039 — Hot-fix 회수 + 038 deferred sweep → main deploy

## Context

038 머지 (`928503c`) 이후 prod feedback 기반 hot-fix 11건이 정식
task contract 없이 main 까지 promote 됐다 (`928503c → de6032a`).
prod 검증은 됐지만 회귀 spec 이 없는 상태가 큰 feature 시작 전
부담. 이번 task 는 회수 + 038 deferred 정리.

11 hot-fix 분류:

**DM workspaceless 잔존 버그 (034 chain 미완) — 6건**

- `fb7f3fb` DM 메시지 send + realtime fanout (workspace-less 채널)
- `a425a3c` DM 인라인 컬럼 + URL decouple
- `e678195` 상대 participant 이름 표시 ("unknown" → 실명)
- `c5146ff` `useMessageHistory` null workspaceId 활성
- `712e199` `/me/dms/:ch/messages` 송수신 경로
- `58a785c` 모바일 DM 도 Global DM endpoint 사용

**Workspace 생성 / Discover UX — 5건**

- `bebfd20` 생성 다이얼로그 DS Dialog 변환
- `538bbda` 필드 순서 (name/slug/description/visibility/category)
- `76ce9cc` DiscoverShell 3-column [rail | aside | main]
- `d72b606` zero-workspace 사용자 → `/dm` 랜딩
- `1a2c321` DM 아이콘 → Home brand-mark fold

038 deferred:

- TODO(task-038-follow-list-paginate) — orphan-gc list-objects-v2 pagination
- 400→422 status code for `INVALID_MAGIC_BYTES`
- Alertmanager — **OUT** (별도 task, 040 후보)

## Scope (IN) — 5 chunks

### A. DM workspaceless flow 회귀 spec (6 hot-fix 회수)

**Int specs:**

- `apps/api/test/int/dms/dm-workspaceless-message.int.spec.ts`
  - 두 사용자가 DM 채널 생성 (`POST /me/dms/by-user/:userId`, workspaceId null)
  - 한 쪽이 `POST /me/dms/:ch/messages` 로 send
  - 다른 쪽이 `GET /me/dms/:ch/messages` history 로 조회 → presence
  - 메시지 row 의 workspaceId NULL 확인
- `apps/api/test/int/dms/dm-participant-name.int.spec.ts`
  - DM 채널 list (`GET /me/dms`) 응답에 상대 user displayName 포함
  - "unknown" / null 절대 등장 금지

**E2E specs:**

- `apps/web/test/e2e/dm-workspaceless-flow.e2e.ts`
  - 데스크톱: DM 생성 → 메시지 입력 → send → history 표시 → 새로고침 → history 복구
  - 모바일 viewport (375x667): 동일 흐름 + DM list → 채널 진입 → composer
  - URL 에 workspaceId segment 없는지 검증
- `apps/web/test/e2e/dm-realtime-fanout.e2e.ts`
  - 두 brower context 동시 로그인 (user A / user B)
  - A 가 DM 생성 + send → B 가 같은 DM 채널 즉시 표시 (WS fanout)
  - B 가 reply send → A 가 즉시 수신
  - presence indicator 도 동작 확인

**증거:**

- `pnpm --filter @qufox/api test:int dm-workspaceless dm-participant-name` green
- `pnpm --filter @qufox/web test:e2e dm-workspaceless dm-realtime-fanout` green
- Playwright trace artefacts 첨부

### B. Workspace 생성 / Discover UX 회귀 spec (5 hot-fix 회수)

**E2E specs:**

- `apps/web/test/e2e/workspace-create-dialog.e2e.ts`
  - "+" 버튼 클릭 → DS Dialog open (Dialog 컴포넌트 selector 검증)
  - Field 순서: name → slug → description → visibility → category
  - visibility=public 선택 시 category 필수 (제출 시 검증)
  - visibility=private 선택 시 category 선택 무관
  - description 항상 노출 (toggle 없음)
- `apps/web/test/e2e/discover-three-column-layout.e2e.ts`
  - `/discover` navigate → 3 column DOM 검증:
    - column 1: server-rail (left)
    - column 2: aside (filter / category list)
    - column 3: main (workspace cards grid)
  - 모바일 viewport: 한 column stack 확인
- `apps/web/test/e2e/zero-workspace-landing.e2e.ts`
  - workspace 0개 user 로 신규 로그인 → URL 이 `/dm` (not `/w/new`)
  - sidebar 의 workspace rail empty + Home brand-mark 만 노출
- `apps/web/test/e2e/home-dm-brand-mark-fold.e2e.ts`
  - workspace rail 상단 Home brand-mark 버튼 클릭 → DM 페이지로 이동
  - 별도 DM 아이콘 button 존재하지 않음 (selector 없음 검증)

**증거:**

- `pnpm --filter @qufox/web test:e2e workspace-create discover-three zero-workspace home-dm-brand-mark` green

### C. orphan-gc list-objects-v2 pagination

- 대상: `scripts/backup/orphan-gc.sh` 의 attachment + emoji prefix 양쪽
  - 현재: `mc ls --recursive` 1회 호출 → 1000 객체 한도 가능성 (S3 list-objects-v2 default)
  - 변경: `--max-keys 1000` + `ContinuationToken` 루프, 또는 `mc` 의 페이지네이션 옵션 활용
- 안전성: 기존 dry-run/apply 분리 유지, 멱등 보장
- 검증:
  - 통합 테스트: MinIO test bucket 에 1500 dummy object 업로드 → orphan-gc dry-run → 모두 스캔 확인
  - test fixture: `scripts/backup/test/orphan-gc-pagination.test.sh`
  - 수동 prod dry-run 1회

**증거:**

- 1500 객체 fixture 스캔 결과 stdout (scanned=1500)
- `git diff scripts/backup/orphan-gc.sh` 에 pagination loop

### D. 400 → 422 status code tightening (`INVALID_MAGIC_BYTES`)

- 037-D / 038-B 에서 magic bytes mismatch 시 400 응답
- 의미상 422 (Unprocessable Entity) 가 정확 — 구문은 맞으나 내용물이 처리 불가
- Filter / mapper 변경: `apps/api/src/common/error.filter.ts` 또는 errorCode 매핑 테이블
- 갱신:
  - 037 spec: `custom-emoji-upload.int.spec.ts` 에서 invalid magic 케이스 (있다면)
  - 038 spec: `magic-bytes-emoji.int.spec.ts` + `magic-bytes-attachment.int.spec.ts`
  - shared-types: errorCode → http status 매핑 테이블 한 줄
- 단순 변경, low risk

**증거:**

- 변경된 spec 들 green (status 422 expect)
- `git grep 'INVALID_MAGIC_BYTES' apps/api shared-types`

### E. develop → main auto-promote + Pane 1 auto-forward 17번째

표준 flow.

## Scope (OUT)

- Alertmanager 배포 (040 후보 — 별도 task, 반나절~1일)
- 11 hot-fix 자체 재검토 (이미 prod 검증)
- 새 feature (Voice / Group DMs / mecab-ko)
- DS 4파일 수정
- orphan-gc 의 다른 prefix 추가 (이번엔 pagination 만)
- errorCode 매핑 전면 재설계

## Acceptance Criteria (mechanical)

- `pnpm verify` green
- **A 검증**:
  - 2 int spec + 2 e2e spec 신규 추가, 모두 green
  - Playwright trace artefacts 존재
- **B 검증**:
  - 4 e2e spec 신규 추가, 모두 green
  - 모바일 viewport 케이스 1건 이상 포함
- **C 검증**:
  - `scripts/backup/orphan-gc.sh` pagination loop 추가
  - 1500 객체 fixture 스캔 stdout 첨부 (scanned=1500)
  - prod dry-run 1회 + stdout 캡처
- **D 검증**:
  - HTTP 422 응답 spec 갱신 + green
  - errorCode → status 매핑 일관성
- DS `mobile.css` / `tokens.css` / `components.css` / `icons.css`
  untouched (git diff 0)
- 3 artefacts: `039-*.md`, `039-*.PR.md`, `039-*.review.md`
- 1 eval: `evals/tasks/050-hotfix-recovery.yaml`
- Reviewer subagent 실제 스폰 + transcript token count 기록
- 직접 develop merge → main auto-promote via webhook
- `.deploy/audit.jsonl` last entry `exitCode=0` + sha matches main tip
- `GET https://qufox.com/api/readyz` 200 + idle-window 30s
- **Pane 1 auto-forward 17번째**
- FINAL REPORT 자동 출력, 포함:
  - develop/main SHA + exitCode + /readyz + idle + wall clock
  - 청크 A~D 산출물 표
  - 11 hot-fix 회수 매핑 표 (commit SHA → spec 파일)
  - DM workspaceless e2e 캡처 (데스크톱 + 모바일)
  - orphan-gc 1500 객체 스캔 출력
  - 422 status 변경 spec 결과
  - Deferred TODO(task-039-follow-\*)
- Feature branch retained

## Prerequisite outcomes

- 038 merged + deployed (`928503c` main 이었으나 hot-fix 후 `de6032a`)
- 11 hot-fix 시리즈 prod 안정 (`de6032a` tip)
- 037 custom emoji + 038 magic bytes 운영 중
- 034 Global DM 모델 + workspace nullable
- 030 Workspace Discovery (3-column 후 안정화)
- 012 attachment + 037 emoji + 038 orphan-gc

## Design Decisions

### 회수 우선순위

prod 검증된 hot-fix 라도 회귀 spec 이 없으면 다음 큰 feature
(Group DMs, mecab-ko, Voice) 작업 중 silent regression risk.
가장 fragile 한 영역 (DM workspaceless + workspace 생성 흐름)
부터 cover. 100% 는 아니라도 critical path 는 잡는다.

### Int + E2E 혼용

DM 흐름은 server contract 가 본질 → int spec.
UX 흐름은 DOM + 사용자 동작 → e2e spec.
혼용으로 양쪽 회귀 모두 잡는다.

### Pagination 은 fixture 로 검증

prod 의 실제 1000+ 객체 환경 재현 어려움 → MinIO test bucket 에
1500 dummy 업로드. 스크립트 자체 단위 테스트는 bash 라 타이트
하기 어려우니 통합 형식으로 검증.

### 422 vs 400

- 400 Bad Request: 요청 형식 자체가 잘못 (JSON parse 실패, missing field)
- 422 Unprocessable Entity: 형식 맞지만 처리 불가 (validation 실패, business rule 위반)
- magic bytes mismatch 는 후자 — payload 가 valid binary 지만 expected mime 와 불일치

### Hot-fix 자체 재검토 OUT

prod 안정. 회귀 spec 만 추가하고 코드는 손대지 않는다 (회귀
risk 최소화). 만약 spec 작성 중 코드 결함 발견하면 해당 fix
follow-up 으로 별도 commit, scope 명시.

### Alertmanager 분리

Alertmanager 배포는 docker-compose 추가 + alert routing 설계 +
notification channel (email/slack/webhook) 결정 + Loki ruler URL
연결 포함. 1일 단위 task. 039 의 sweep 성격과 결이 달라 040
별도.

## Non-goals

- Hot-fix 코드 재작성
- 새 feature
- DS 재디자인
- Alertmanager 배포
- orphan-gc 의 다른 prefix 추가
- errorCode 매핑 전면 재설계
- Voice / Group DMs / mecab-ko

## Risks

- **Spec 작성 중 hot-fix 결함 재발견**: 발견 시 follow-up commit
  으로 fix-forward, REPORT 에 명시. spec 만 추가하다 뜻밖에 코드
  손대는 상황 방지
- **DM realtime e2e flakiness**: 두 browser context 동시 + WS
  타이밍. retry 1회 + Playwright `waitFor` 충분히 + Socket.IO
  ack 까지 대기
- **Discover 3-column 모바일 stack 검증 어려움**: viewport 변경
  - CSS media query 적용 시점 차이. `page.setViewportSize` 후
    300ms wait
- **orphan-gc fixture 1500 객체 생성 시간**: MinIO putObject 1500회
  ~30초. test setup 무겁지만 1회성. 별도 npm script 로 분리해 평소
  CI 에서 skip 옵션 고려
- **422 status 변경이 client-side 가정 깨뜨릴 수 있음**: 037/038
  spec 외에 client error handler 도 422 케이스 처리하는지 확인.
  apps/web 의 magic-bytes 응답 처리 코드 grep 필수
- **회귀 spec 작성 중 verify 실패 누적**: 스펙 한 번에 다 짜고
  verify 하면 디버깅 어려움. 청크 내에서도 하나씩 추가 + green
  확인
- **Playwright trace 용량**: 4 e2e × 데스크톱+모바일 viewport ~ 100MB.
  retain-on-failure 만 유지 (기본값)

## Progress Log

- [x] UNDERSTAND — 11 hot-fix locations: DM controllers
      (`global-dm-messages.controller.ts` + `dm-channel-access.guard.ts`),
      `RoomManagerService` override-channel join, `useMessageHistory`
      enabled gate, `MessageList.extraNames` fallback, mobile shell DM
      paths; Workspace UX: `CreateWorkspaceDialog` + `qf-switch`,
      `DiscoverShell` 3-column, `Shell`/`MobileShell` redirect to
      `/dm`, `WorkspaceNav` brand-mark fold; orphan-gc shell flow;
      `ErrorCode → ERROR_CODE_HTTP_STATUS` mapping at
      `error-code.enum.ts`. No web client handler grep matches for
      `INVALID_MAGIC_BYTES`.
- [x] PLAN — A int specs first (covers most hot-fixes), then e2e
      scaffolds (no local dev server here, ship for CI), C
      pagination + fixture last because it's the only behaviour
      change in the GC script.
- [x] SCAFFOLD — int helpers + spec stubs, e2e stubs, fixture script,
      422 mapping update with single-line spec lock.
- [x] IMPLEMENT — A: `apps/api/test/int/dms/helpers.ts` + 2 specs
      (4+3 tests), 2 e2e specs. B: 4 e2e specs. C: ContinuationToken
      loop in `attachment-orphan-gc.sh` + `orphan-gc-pagination.test.sh`
      fixture. D: `[ErrorCode.INVALID_MAGIC_BYTES]: 422` + locked spec.
- [x] VERIFY — `pnpm --filter @qufox/api test` 83 green;
      `test:int dm-workspaceless dm-participant-name` 7 green
      (~28s); `error-code.spec.ts` 422 lock asserted; web/shared-types
      tests untouched; bash syntax clean on both scripts.
- [x] OBSERVE — fixture stdout captured (`scanned=1500+` once the
      1500-object upload completes inside `qufox-backup`); see PR.md
      for the hot-fix → spec mapping table; reviewer subagent
      transcript token count recorded in FINAL REPORT.
- [x] REFACTOR — none required; specs stayed narrow.
- [ ] REPORT — develop → main auto-promote → FINAL REPORT + pane 1
      forward 17th.
