# Discord-like Real-time Communication Platform

## 🎯 Vision

프로덕션 수준의 실시간 커뮤니케이션 플랫폼을 구축한다.
MVP는 텍스트 채팅이지만, 음성/영상/화면공유로 수평 확장 가능한
아키텍처를 처음부터 설계한다.

## 🛠 Tech Stack

- Monorepo: pnpm workspaces + Turborepo
- Backend: NestJS 10 (Node 20 LTS) + TypeScript strict
- Frontend: React 18 + Vite + TypeScript + Tailwind + shadcn/ui
- Database: PostgreSQL 16 + Prisma
- Cache / Pub-Sub: Redis 7 (Socket.IO adapter)
- Real-time: NestJS WebSocket Gateway (Socket.IO)
- Object Storage: S3-compatible (MinIO dev / AWS S3 prod)
- Auth: JWT access(15m) + refresh(7d rotating) HttpOnly cookie
- Observability: Pino + OpenTelemetry + Prometheus
- Container: Docker + docker-compose (dev) + K8s (prod)

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

postgres-local(RW), postgres-staging(RW row-limit), postgres-prod(금지),
redis-local(RW), playwright(RW), github(repo scope),
kubernetes-staging(namespace), kubernetes-prod(read-only),
sentry(read-only), filesystem(repo root only).

### 📊 Eval Harness

evals/tasks/\*.yaml — goal, DoD, 채점 스크립트
evals/run.ts — Claude Code headless 실행 → DoD 자동 채점
채점: verify green / 지정 테스트 green / 스코프 준수 / PR 증거 / 턴 수 상한
`pnpm eval` 성공률 ≥ 90% 아니면 머지 차단.

### 🚀 CD: Staging 자율 / Prod 승인 후 자동

feature → PR → develop → auto staging deploy → AI smoke+eval →
release PR(자동) → 사람 1-click merge → prod canary 10/50/100 →
SLO 위반 시 자동 롤백 → post-deploy verify.

SLO: 5xx > 1% / P95 > 500ms / WS 실패 > 5% (5m window) → 자동 롤백.

### 🌍 IaC

infra/terraform, infra/k8s, infra/helm. Terraform plan은 PR 코멘트 자동,
apply는 main merge 시 자동(prod 승인 필요). 시크릿은 AWS Secrets Manager +
External Secrets Operator. 평문 시크릿 커밋 금지.

### 🔭 Production Observability

Logs(Loki/CloudWatch) + Metrics(Prometheus/Grafana) + Tracing(OTEL→Tempo) +
Errors(Sentry) + Synthetic(5m cURL). 알림 → runbook 매칭 + AI 1차 진단.

### 🔐 Security Automation

CodeQL / Dependabot / Gitleaks / Trivy / Syft SBOM / OWASP ZAP nightly.
취약점 알림 수신 시 `security-patch` 태스크 자동 생성 → implementer 위임.
