# 076 · webhook 배포 제거 + 로컬 단일 `deploy.sh` 전환 + 단순화

> 상태: DRAFT (구현 중)
> 작성: 2026-06-17
> 동기: 사용자 — webhook 자동배포 완전 제거, 로컬 수동(AI 실행) 배포로 전환, 불필요한 복잡성 축소.

## Context

webhook 자동배포는 이미 죽어 있음(qufox-webhook 컨테이너 down, audit 2026-06-05 멈춤). 메모리
상 배포는 이미 수동(`auto-deploy.sh`)으로 운영 중. 이를 공식화하고 webhook 스택·군더더기를
제거한다. 단, 단일 NAS(kernel4.4, btrfs)·카나리 없음이라 **load-bearing 안전장치는 유지**한다.

## 결정 (사용자 승인)

- **차단기**: 무거운 circuit-breaker(`breaker.sh` state.json + threshold + `reset-breaker.sh`)는
  webhook 자동재시도 루프용 → **제거**. 대신 **경량 가드**로 대체(배포를 사람 아닌 AI가
  실행하므로 적절한 가드 필요):
  1. `.deploy/last-result`(ok|fail+sha+ts) 기록 → 직전 실패면 다음 배포는 `--force` 요구(블라인드 재시도 차단).
  2. 배포 전 btrfs 공간 하드 체크(`btrfs-watchdog`) → CRIT면 거부.
  3. 항상-on: health 게이트(`health-wait`) + 실패 시 `:prev` 자동 롤백(`rollback`).
- **워크트리**: 별도 클론 `/volume2/dockers/qufox-deploy` **제거**. 빌드는 메인 repo에서,
  `.deploy/{audit,last-result,lock}`를 메인 repo로 이전, `qufox-backup` 마운트 재지정.

## Scope

### IN — Phase 1: webhook 스택 제거

- 삭제: `services/webhook/`, `compose.deploy.yml`의 **qufox-webhook 서비스 블록만**
  (qufox-backup·파일·internal 네트워크·pgdata 볼륨은 유지). **`.env.deploy`는 backup이 사용하므로
  유지**(webhook-only 키만 dead — 후속 정리), `apply-nginx-diff.sh`·`post-switchover-smoke.sh`도 정리.
- 외부 참조 정리: nginx `location /hooks/github`, `infra/prometheus/prometheus.yml`의 qufox-webhook
  job, `infra/prometheus/alerts-deploy.yml`, `infra/k8s/monitoring/servicemonitor-webhook.yaml`.
- qufox-backup 조정: `WEBHOOK_HEARTBEAT_CRON` 제거(webhook 없음), `scripts/deploy/tests/webhook-heartbeat.sh` 삭제.
- 문서/잔재: `docs/ops/runbook-webhook-debug.md`, `runbook-nginx-diff.md`, `scripts/setup/migrate-webhook-worktree.sh`, `evals/tasks/022-webhook-hmac-reject.yaml`.
- 사용자 측(코드 밖): GitHub repo Settings → Webhooks 삭제 + Deploy Key 제거, `/volume1/secrets/qufox-ssh` 제거.

### IN — Phase 2: 워크트리 제거 + 단일 `deploy.sh`

- `.deploy/` → 메인 repo(`/volume2/dockers/qufox/.deploy`)로 이전, `compose.deploy.yml`의
  qufox-backup `.deploy` 마운트를 메인 repo로 재지정. `/volume2/dockers/qufox-deploy` worktree 제거.
- **신규 `scripts/deploy/deploy.sh`** = `auto-deploy.sh` + `prod-reload.sh` 통합:
  - 현재 워킹트리 빌드(SHA 인자 옵션, 기본 HEAD). `DEPLOY_BRANCH` 파라미터 제거.
  - 플래그: `--service api|web|all`(기본 all), `--[no-]migrate`(기본 migrate ON), `--force`(가드 우회+감사).
  - 흐름: lock → 경량가드(공간/last-fail) → (옵션)checkout → build-and-push(격리+`:prev`) →
    prisma migrate → deploy-hook SQL → rollout(pull+up+health-wait+자동롤백) → smoke →
    last-result 기록 → lock release. **registry-gc 자동 루프 제거**(수동 옵션만).
  - 유지 호출: `lock.sh`, `build-and-push.sh`, `rollout.sh`, `health-wait.sh`, `rollback.sh`,
    `btrfs-watchdog.sh`. 제거: `breaker.sh`, `reset-breaker.sh`.
- 삭제: `auto-deploy.sh`, `prod-reload.sh`(통합 후), `breaker.sh`, `reset-breaker.sh`.

### OUT

- 앱 기능 incoming-webhook(`apps/api/src/workspaces/webhooks/`, `shared-types/webhook.*`) — 별개, 유지.
- qufox-backup 백업/복구/GC 로직 자체 — 유지.
- build 격리 + 로컬 레지스트리 + `:prev` 롤백 — **유지**(btrfs churn 방지, 단순화 대상 아님).
- prisma migrate, health-wait, rollback, lock, smoke, btrfs-watchdog — **유지**(안전장치).

## Acceptance Criteria

1. `qufox-webhook` 관련 파일/서비스/외부참조 잔존 0 — grep `services/webhook|hooks/github|qufox-webhook` (앱 incoming-webhook 제외) = 0.
2. `scripts/deploy/deploy.sh` `bash -n`(test-syntax) green, `--help` 동작.
3. **deploy.sh로 실제 prod 재배포 1회 성공** — health-gate 통과, `/readyz` 200, 라이브 정상(dogfood).
4. 경량 가드 동작: 강제 실패 후 다음 배포가 `--force` 없이는 거부됨(스모크).
5. qufox-backup이 새 `.deploy` 마운트로 정상 기동(백업 크론 살아있음).
6. `/volume2/dockers/qufox-deploy` worktree 제거됨, `git worktree list`에 없음.
7. `pnpm verify` green(repo 측 스크립트 변경이 게이트 무영향).

## Risks

- 안전장치를 "복잡함"으로 오인해 제거하지 말 것(health-wait/rollback/migrate/build격리/lock = load-bearing).
- `.deploy` 이전 중 lock/state 유실 → backup 마운트 재지정 + 이전을 원자적으로.
- deploy.sh 검증 전 `auto-deploy.sh` 삭제 금지(롤백 가능 상태 유지).
- worktree 제거 전 backup이 메인 repo `.deploy`를 읽도록 먼저 재지정.

## DoD

- [ ] AC 1–7 green, deploy.sh dogfood 배포 로그 첨부
- [ ] reviewer 적대 재독(안전장치 보존 확인) BLOCKER 0
- [ ] 런북 갱신(`runbook-deploy.md` — 새 deploy.sh 사용법), 메모리 갱신
