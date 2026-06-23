# Discord-like Real-time Communication Platform (qufox)

## 🎯 Vision

프로덕션 수준의 실시간 커뮤니케이션 플랫폼. 텍스트 채팅 parity는 대체로 완성됐고
초점은 검증/안정성(메모리 `project_direction_pivot`). 음성/영상은 수평 확장
가능하도록 설계만 해두고 채팅 완성 전까지 후순위.

## 🛠 Tech Stack

> **NAS-only deployment.** 모든 것이 단일 Synology NAS 위에서 돈다 — 클라우드
> 계정·관리형 DB·관리형 오브젝트 스토리지 없음, docker-compose 외 오케스트레이터
> 없음. dev / test / e2e / prod 전부 NAS 컨테이너에 대한 compose 파일.
> 클라우드 서비스로 기울 만한 기능은 self-hosted 컨테이너로 대체한다.
> (메모리 `project_prod_deploy`, `project_data_layout`.)

- Monorepo: pnpm workspaces + Turborepo (`apps/api`, `apps/web`, `packages/{shared-types,config,ui}`)
- Backend: NestJS 10 (Node 22 LTS) + TypeScript strict
- Frontend: React 18 + Vite + TypeScript + Tailwind + shadcn/ui
- DB: PostgreSQL 16 + Prisma · Cache/Pub-Sub: Redis 7 (Socket.IO adapter)
- Real-time: NestJS WebSocket Gateway (Socket.IO + Redis adapter fanout)
- Object Storage: MinIO (single-tenant, dev/prod identical) — 대화/설계엔 "MinIO",
  "S3"는 코드/SDK 한정 (메모리 `feedback_minio_naming`)
- Auth: JWT access(15m) + refresh(7d rotating) HttpOnly cookie

## 🏗 Architecture Principles

1. Domain-driven 모듈: auth, users, workspaces, channels, messages, realtime
2. Stateless API(세션은 Redis, 수평 확장), Write-path vs Read-path 분리, Event-driven
3. Extension-ready — `Channel.type` enum으로 voice/video 확장
4. Domain Model: User, Workspace, WorkspaceMember(role), Channel(type),
   Message(soft delete), Invite, Role(custom, S61)
5. NFR: P95 메시지 전달 < 200ms(WS), 단일 노드 WS 10k, 모든 POST idempotency key,
   Rate limit IP + User 이중

## ✅ Coding Conventions

- TypeScript strict, `any` 금지. ESLint flat config + Prettier, Conventional Commits
- 모든 API input: class-validator + shared Zod (contract는 `packages/shared-types`)
- 도메인 에러 계층 + errorCode enum + HttpException 변환 필터
- 구조화 로그 + traceId 전파. 시크릿 커밋 금지 (gitleaks 강제)
- UI는 design.qufox.com 롤링 CSS 직접 참조가 원본, raw hex/px/shadow 금지. 대화/문서는
  항상 정중한 한국어(~합니다/~세요) (메모리 `feedback_design_system_source_of_truth`,
  `project_ds_extraction_showcase`, `feedback_polite_korean`, `feedback_korean_wording`)

## 🧪 Testing Strategy

- Unit: Vitest(도메인 100%) · Int: Jest+Testcontainers · E2E: Playwright · Contract: Zod
- 결정론 픽스처 규칙(고정 시각·faker seed 등)은 `.claude/agents/tester.md`에.

## 🤖 AI Agent Harness

### 🔁 작업 루프

계획 → 구현(red→green→refactor) → 검증(`pnpm verify`) → 보고. 모델이 작업
복잡도에 맞춰 단계 깊이를 스스로 조절한다(고정 단계 강제·step 마커 불필요).
신규 기능은 짧은 계획(영향 파일/모델/API/테스트)을 먼저 제시하되, 완전 자율
모드에선 경계마다 승인을 기다리지 않는다(메모리 `feedback_autonomous_loop_no_pause`).
독립 표면은 병렬, 교차절단 변경만 직렬화. 모호하면 옵션 2-3개 + trade-off 제시.
**VERIFY 3회 연속 실패 시 중단**하고 가설 3개 + 필요한 정보를 질문한다.
모든 코드 변경 후 `pnpm verify` 필수, 실패 출력은 원문 그대로 첨부.

### 🧰 Single-Command Harness

| Command           | Purpose                               | Target  |
| ----------------- | ------------------------------------- | ------- |
| `pnpm bootstrap`  | install + db up + migrate + seed      | < 2m    |
| `pnpm dev`        | full-stack hot-reload                 | instant |
| `pnpm verify`     | lint + typecheck + unit (turbo)       | < 60s   |
| `pnpm test:quick` | changed-file tests only               | < 10s   |
| `pnpm test:int`   | Testcontainers integration            | < 3m    |
| `pnpm test:e2e`   | Playwright + trace                    | < 5m    |
| `pnpm smoke`      | cURL smoke                            | < 30s   |
| `pnpm db:reset`   | clean seed state                      | < 15s   |
| `pnpm fix`        | eslint/prettier autofix               | < 20s   |
| `pnpm debug:dump` | snapshot logs + db + redis to .debug/ | < 10s   |

> kernel 4.4 OOM 주의: 큰 슬라이스에서 combined verify가 turbo 동시 fork로 OOM 날
> 수 있음 — standalone VERIFY green 후 `--no-verify` push (메모리
> `reference_int_not_in_push_gate`, `reference_container_verify_concurrency`).

### 📡 Observability

Pino JSON 로그 + traceId/module/errorCode(모든 도메인 에러는 errorCode enum),
`/healthz`(liveness)·`/readyz`(DB+Redis), 모든 응답에 requestId echo,
`pnpm debug:dump` → `.debug/latest.json`.

### 🧱 Deterministic Environment

`.nvmrc` + packageManager pin, `.env.example` 전 키 나열(bootstrap이 누락 검증),
seed는 uuid v5 fixed namespace(항상 동일 ID), compose profiles dev/test/e2e.
frozen install 후 `prisma generate` 필수(누락 시 typecheck/test 광범위 실패).

### 📋 Task Contract

작업은 `docs/tasks/NNN-<slug>.md`에 Context / Scope(IN/OUT) /
Acceptance Criteria(기계 검증) / Non-goals / Risks로 기록한다. 규모에 비례한
경량 contract를 허용한다(단일 파일·설정 한 줄 변경에 5섹션 풀 contract 불요).
DoD = 체크리스트 green + `pnpm verify` 통과 로그 첨부.

### 🛡 Safe Autonomy

AI가 사전 승인 없이 수행: 의존성 업데이트, 마이그레이션 신규/수정(destructive는
reversible 동반), feature push, 셀프 리뷰, develop 머지, 외부 API 호출. **수행하지
않음**: main force push, history 재작성, **prod DB 직접 접근**, **prod 시크릿 쓰기**,
**prod 배포 실행**(운영자 승인), 결제 실거래. 이중 강제 = `settings.json` 권한 +
`guard.sh`(`--self-test` 검증). GitHub은 push-only(메모리 `feedback_github_push_only`).

### 🤖 Agents (`.claude/agents/*.md`)

핵심: **reviewer**(적대적 재독, CD 게이트) · planner · implementer · tester ·
db-migrator · ops. 변경 표면별 **on-demand 검증 에이전트**(ui-designer,
accessibility-auditor, ux-heuristic-auditor, visual-regression-scanner,
contract-validator, security-scanner, performance-profiler, feature-benchmarker)
— 의무 게이트가 아니라 해당 표면을 실제로 건드릴 때 호출한다. 서브에이전트는
머지/배포/prod-DB 접근을 하지 않는다(메모리 `feedback_subagent_no_merge_deploy`).

### 🧩 MCP Servers

postgres-local(RW), redis-local(RW), playwright(RW), filesystem(repo root).
원격/클라우드 MCP 없음 — prod postgres는 NAS 직접 접근만.

### 🚀 CD: reviewer → develop → main → local deploy

feature → reviewer(적대적 재독, BLOCKER/HIGH fix-forward) → `merge --no-ff`
develop → AI smoke → develop 머지 main → 로컬 `sudo bash scripts/deploy/deploy.sh`
→ /readyz 게이트 + 실패 시 auto-rollback. GitHub webhook·1-click·K8s canary·별도
staging 없음(webhook은 task-076에서 제거). `deploy.sh`가 단일 진입점(build-isolated
→ local registry → pull rollout); flock 직렬화 + 경량 가드(last-fail → `--force`,
btrfs CRIT → 거부). 롤백 SLO: 재생성 후 120s 내 /readyz non-200 → `:latest ← :prev`.

### 🌍 Infra & Security

NAS `/volume2/dockers/qufox/` 아래: `docker-compose.prod.yml`(앱),
`compose.deploy.yml`(백업 cron), `scripts/{setup,deploy,backup}/`. 시크릿은
`.env.prod`·`.env.deploy`(git-ignored, 0600). 영속 데이터는 `/volume3/qufox-data/`,
`/volume2`는 코드·이미지만(메모리 `project_data_layout`). Observability:
Prometheus/Grafana + OTEL(stdout) + Pino. Loki는 future — TODO(task-019).
Security: CodeQL/Dependabot/Gitleaks/Trivy/Syft/ZAP nightly → 취약점은
`security-patch` 태스크 → implementer 위임.
