# Discord-like Real-time Communication Platform

## 🎯 Vision

프로덕션 수준의 실시간 커뮤니케이션 플랫폼을 구축한다.
MVP는 텍스트 채팅이지만, 음성/영상/화면공유로 수평 확장 가능한
아키텍처를 처음부터 설계한다.

## 🛠 Tech Stack

> **NAS-only deployment.** Everything runs on a single Synology NAS —
> no cloud account, no managed database, no managed object storage, no
> orchestrator beyond docker-compose. Dev / test / e2e / prod all use
> compose files against containers on the NAS. When adding a
> capability that would otherwise default to a cloud service, use a
> self-hosted container instead.
> (Memory: `project_prod_deploy.md`, `project_data_layout.md`.)

- Monorepo: pnpm workspaces + Turborepo
- Backend: NestJS 10 (Node 20 LTS) + TypeScript strict
- Frontend: React 18 + Vite + TypeScript + Tailwind + shadcn/ui
- Database: PostgreSQL 16 + Prisma
- Cache / Pub-Sub: Redis 7 (Socket.IO adapter)
- Real-time: NestJS WebSocket Gateway (Socket.IO)
- Object Storage: MinIO (single-tenant, NAS docker-compose, dev/prod identical)
- Auth: JWT access(15m) + refresh(7d rotating) HttpOnly cookie
- Observability: Pino + OpenTelemetry + Prometheus
- Container: Docker + docker-compose (dev/prod, no K8s on this deployment)

## 🏗 Architecture Principles

1. Domain-driven modules: auth, users, workspaces, channels, messages, realtime
2. Stateless API — 세션은 Redis, 서버 수평 확장 가능
3. Scalable WS — Socket.IO + Redis adapter로 노드 간 fanout
4. Write-path vs Read-path 분리
5. Event-driven (EventEmitter or Redis Streams)
6. Extension-ready — Channel.type enum으로 voice/video 확장

## 📦 Monorepo Layout

- apps/api, apps/web
- packages/shared-types, packages/config, packages/ui

## 📐 Domain Model (MVP)

- User, Workspace, WorkspaceMember(role), Channel(type), Message(soft delete), Invite

## 🚦 Non-functional Requirements

- P95 메시지 전달 < 200ms (WS)
- 단일 노드 동시 WS 10k
- 모든 POST는 idempotency key
- Rate limiting: IP + User 이중

## 📋 MVP Scope (Phase 1)

- Auth (signup/login/refresh)
- Workspace 생성/초대 가입
- 텍스트 채널 CRUD
- 실시간 메시지 송수신
- 커서 기반 히스토리 페이지네이션
- Presence
- 기본 UI (사이드바 + 메시지 영역)

## 🔮 Future Extensions

- 음성 채널(WebRTC SFU: mediasoup/LiveKit 후보)
- 영상/화면 공유
- 첨부, 반응, 스레드, 알림
- 역할/권한 세분화

## ✅ Coding Conventions

- TypeScript strict, `any` 금지
- ESLint flat config + Prettier, Conventional Commits
- 모든 API input: class-validator + shared Zod
- 도메인 에러 계층 + errorCode enum + HttpException 변환 필터
- 구조화 로그 + traceId 전파
- 시크릿 커밋 금지 (gitleaks 강제)

## 🧪 Testing Strategy

- Unit: Vitest (도메인 서비스)
- Integration: Jest + Testcontainers
- E2E: Playwright (trace retain-on-failure)
- Contract: packages/shared-types Zod 스키마 공유

## 🤝 Collaboration Protocol

1. 신규 기능은 Plan → Code. 계획에 영향 파일/모델/API/테스트 전략 포함.
2. 승인 후 red → green → refactor.
3. 한 번에 한 모듈. 큰 변경은 분할 제안.
4. 완료 시 `pnpm verify` 결과 첨부.
5. 모호한 지점은 옵션 2-3개 + trade-off 제시 후 사용자 선택 대기.

## 🤖 AI Agent Harness

### 🔁 Agent Loop (strict)

UNDERSTAND → PLAN → SCAFFOLD → IMPLEMENT → VERIFY → OBSERVE → REFACTOR → REPORT
VERIFY 3회 연속 실패 시 중단 후 가설 3개 + 필요한 정보를 질문.

### 🧰 Single-Command Harness

| Command           | Purpose                               | Target  |
| ----------------- | ------------------------------------- | ------- |
| `pnpm bootstrap`  | install + db up + migrate + seed      | < 2m    |
| `pnpm dev`        | full-stack hot-reload                 | instant |
| `pnpm verify`     | lint + typecheck + unit + contract    | < 60s   |
| `pnpm test:quick` | changed-file tests only               | < 10s   |
| `pnpm test:int`   | Testcontainers integration            | < 3m    |
| `pnpm test:e2e`   | Playwright + trace                    | < 5m    |
| `pnpm smoke`      | cURL smoke                            | < 30s   |
| `pnpm db:reset`   | clean seed state                      | < 15s   |
| `pnpm fix`        | eslint/prettier autofix               | < 20s   |
| `pnpm debug:dump` | snapshot logs + db + redis to .debug/ | < 10s   |
| `pnpm eval`       | run eval harness                      | varies  |

모든 코드 변경 후 `pnpm verify` 필수. 실패 출력은 원문 그대로 리포트에 첨부.

### 🧪 Test Pyramid & Fixtures

- 도메인 서비스 100% 커버
- 모킹은 vi.fn()만, 외부 모킹 라이브러리 금지
- 모든 테스트 시작 시 `vi.setSystemTime('2025-01-01T00:00:00Z')`
- faker는 fixed seed
- Playwright: trace retain-on-failure, screenshot only-on-failure

### 📡 Observability for AI

- Pino JSON 로그 + traceId/module/errorCode
- 모든 도메인 에러는 errorCode enum
- /healthz(liveness), /readyz(DB+Redis)
- `pnpm debug:dump` → ./.debug/latest.json (최근 로그 + DB 상태 + Redis 키)
- 모든 응답에 requestId 헤더 echo

### 🧱 Deterministic Environment

- .nvmrc, packageManager pin
- .env.example 전 키 나열, bootstrap이 누락 검증
- seed: uuid v5 fixed namespace → 항상 동일 ID
- docker-compose profiles: dev / test / e2e
- Devcontainer 제공

### 📋 Task Contract

모든 작업은 `docs/tasks/NNN-<slug>.md` 필요. Context / Scope(IN/OUT) /
Acceptance Criteria(기계 검증) / Non-goals / Risks 섹션 필수.
DoD = 체크리스트 green + `pnpm verify` 통과 로그 첨부.

### 🛡 Safe Autonomy (완전 자율 모드)

AI가 사전 승인 없이 수행: 의존성 메이저 업데이트, 마이그레이션 신규/수정
(destructive는 reversible 동반), feature 브랜치 push/PR/셀프 리뷰,
CI 수정, develop 머지(CI green 조건), staging 배포/DB 무제한, 외부 API 호출.

AI가 수행하지 않음: main force push, history 재작성, **prod DB 직접 접근**,
**prod 시크릿 쓰기**, **prod 배포 실행**(사람 1-click merge 후 파이프라인 자동),
결제 실거래 API.

이중 강제: .claude/settings.json permission rules + GitHub branch protection +
.claude/hooks/guard.sh.

### 🤖 Agent Team (Subagents)

planner / implementer / tester / reviewer / db-migrator / release-manager / ops
.claude/agents/\*.md에 정의. 각자 제한된 도구 권한.

### 🧩 MCP Servers

postgres-local(RW), redis-local(RW), playwright(RW), github(repo scope),
filesystem(repo root only). No remote/cloud MCP servers are expected on
this NAS-only deployment — prod postgres access is strictly direct via
the NAS, and there is no external orchestrator or error-tracker to
bridge.

### 📊 Eval Harness

evals/tasks/\*.yaml — goal, DoD, 채점 스크립트
evals/run.ts — Claude Code headless 실행 → DoD 자동 채점
채점: verify green / 지정 테스트 green / 스코프 준수 / PR 증거 / 턴 수 상한
`pnpm eval` 성공률 ≥ 90% 아니면 머지 차단.

### 🚀 CD: reviewer subagent → direct develop merge → NAS auto-deploy

feature branch → reviewer subagent (adversarial re-read; BLOCKER/HIGH
fixed forward) → `git merge --no-ff` to develop → AI smoke + eval →
develop merge to main → GitHub webhook → NAS auto-deploy (009 stack)
→ /readyz gate + auto-rollback on failure → post-deploy verify.

No human 1-click merge step; no K8s canary; no staging environment
distinct from prod. `scripts/deploy/prod-reload.sh` (manual fallback)
shares a flock with the webhook so the two paths never race.

SLO gate for rollback (009 `rollout.sh`): /readyz non-200 within
120s of container recreate → `:latest ← :prev` auto-restore.

### 🌍 Infra

All infra lives under `/volume2/dockers/qufox/` on the NAS:
`docker-compose.prod.yml` (app stack), `compose.deploy.yml` (webhook

- backup), `scripts/setup/` (one-shot init scripts),
  `scripts/deploy/` (rollout + rollback + health-wait),
  `scripts/backup/` (pg + redis + minio + orphan-gc). Secrets live in
  `.env.prod` and `.env.deploy` (git-ignored, 0600 admin:users);
  rotation happens via `scripts/setup/init-env-deploy.sh` and
  `scripts/setup/init-minio.sh`. sops / age migration for at-rest
  secret encryption is a future task.

Persistent data lives at `/volume3/qufox-data/` (see
`project_data_layout.md` memory for the per-purpose subdir layout).
`/volume2` is code + container images only.

### 🔭 Production Observability

Metrics (Prometheus / Grafana, self-hosted) + Tracing (OTEL, stdout
exporter on NAS) + app-level health (Pino JSON + /healthz + /readyz).
Deploy pipeline metrics (`qufox_deploys_total`,
`qufox_deploy_duration_seconds`, etc.) via the webhook's prom-client
registry at `deploy.qufox.com/internal/metrics`. Log aggregation
(Loki self-hosted on NAS) is a future task — TODO(task-019). Synthetic
probe is the `post-switchover-smoke.sh` + periodic cron-based curl.

### 🔐 Security Automation

CodeQL / Dependabot / Gitleaks / Trivy / Syft SBOM / OWASP ZAP nightly.
취약점 알림 수신 시 `security-patch` 태스크 자동 생성 → implementer 위임.
