# task-077: AI 하네스 최적화 (dead-config 정리 + ceremony 축소)

## Context

오랜 기간 누적된 AI 작업 하네스가 유지보수 단계(buildable FR 352/354 완료,
자율 큐 비어 있음) 기준으로 과도하게 무겁고, 무게의 대부분이 진짜 안전장치가
아니라 (1) 이미 사라진 인프라(webhook/K8s/canary/AWS)를 가리키는 죽은 설정과
(2) Opus 4.8이 인라인으로 처리할 수 있는 일을 의무화한 ceremony에서 온다는
멀티에이전트 감사 결과(11 에이전트, scratchpad `tasks/wd9tb7s51.output`)에 기반.

핵심 원칙: **핵심 보호선은 그대로 유지하면서 죽은 설정과 누적 cruft만 걷어낸다.**
2026 best practice(CLAUDE.md ≤200줄·강제는 hook으로·메모리 선택적 큐레이션)에 정합.

## Scope

### IN

- **권한/훅**: `.claude/settings.json` + `.claude/hooks/guard.sh`의 죽은 인프라 규칙
  8종(kubectl/helm/terraform staging+prod, aws secretsmanager, mcp-postgres-prod,
  `.env.production` 변형) 제거. `psql *prod*` deny는 실 prod 컨테이너
  (`qufox-postgres-prod`) 기준으로 현대화. force-push deny에 `--force-with-lease`/
  `--force-if-includes` 우회 패턴 보강. `rm -rf` 변형 강건화. prod 배포 진입점
  (`deploy.sh`)에 `ask` 가드 추가. settings ↔ guard self-test 동기.
- **CLAUDE.md**: 8단계 명명 Agent Loop + step 마커 강제 완화(advisory 골격으로),
  테스트 픽스처 세칙을 tester.md로 이전, Collaboration Protocol의 "승인 대기"·
  "한 번에 한 모듈" 모순 해소, eval 90% 머지차단 문장 cut, Agent Team 목록 갱신,
  자명/중복 섹션 압축. 목표 ~120줄대.
- **에이전트**: release-manager cut, implementer ↔ feature-implementer 통합,
  db-migrator/ops를 NAS 현실(deploy.sh/.deploy/logs)로 modernize,
  competitive-capture-analyst ↔ feature-benchmarker 통합,
  visual-regression-scanner BLOCKER를 결정론적 CLI 결과로 재바인딩 + 압축.
- **메모리**: webhook 전제 dead 메모리 정리(auto_promote_to_main/deploy_audit_location
  cut, deploy_hook_stdin_hang은 결론 압축 흡수), stale 배포 명령부(auto-deploy.sh/
  prod-reload.sh/reset-breaker.sh) → `deploy.sh` 일괄 치환, skip_pr↔retain 모순 해소,
  MEMORY.md 인덱스 정리. 환경/도메인 고유 메모리는 유지.
- **eval**: stale `evals/report.{md,json}` 삭제, `.github/workflows/eval.yml` cut,
  CLAUDE.md eval 머지차단 규칙 cut(하네스 표·package.json 정합 유지).
- **docs/tasks**: 휘발성 progress/iteration/audit 로그 77개를 `docs/tasks/archive/`로
  `git mv`(삭제 아님).

### OUT

- 새 기능 구현, 앱 코드(apps/\*\*) 변경, prod 배포 실행.
- vitest `setupFiles` 전역 setSystemTime 코드화(테스트 전수 영향 → 별도 task).
- sops/age 시크릿 암호화, Loki 로그 집계(기존 TODO 유지).

## Acceptance Criteria (기계 검증)

- [x] `bash .claude/hooks/guard.sh --self-test` green (force-with-lease·rm 변형·
      deploy.sh ask 케이스 추가 포함) — PASS
- [x] `.claude/settings.json` JSON 유효, kubectl/helm/terraform/secretsmanager/
      postgres-prod/`.env.production` 문자열 0건 — dead-string count = 0
- [x] CLAUDE.md `wc -l` ≤ 140 — 140
- [x] `release-manager.md` 부재, competitive-capture → feature-benchmarker 통합,
      feature-implementer → implementer 통합(강한 규칙 DS 4파일·--no-verify·gitleaks 보존)
- [x] 메모리: stale 배포 스크립트는 "removed" historical 언급만, dead 메모리 3개 cut,
      MEMORY.md dead 라인 부재, dangling wikilink 0, 배포 SSOT = `reference_manual_deploy_no_sha`
- [x] `evals/report.{md,json}` 부재, `.github/workflows/eval.yml` 부재,
      CLAUDE.md "≥90% 머지 차단" 문자열 부재
- [x] `docs/tasks/archive/` 생성 + 76개 로그 이동, 루트 .md 225 → 149
- [x] `pnpm verify` green — 16 tasks 성공, api 1409 tests passed, OOM 없음

## DoD

체크리스트 전부 green + `pnpm verify` green(단독 실행, 113s, FULL TURBO). 앱 코드
무변경(apps/**·packages/** 미수정)이라 런타임 회귀 없음. 메모리 정리는 git 외부
(`~/.claude/.../memory/`)라 별도 커밋 없음. 커밋 분할: task doc → 권한/훅 → CLAUDE.md →
에이전트 → eval → tasks 아카이브 → lock.sh.

## Non-goals

- 안전장치 약화(main force-push/prod-DB write/secret write/rm-rf 차단, gitleaks,
  reviewer, deploy.sh /readyz 롤백, VERIFY 3-strike, DoD 모두 유지·일부 강화).
- 메모리의 학습된 교훈 소실(오진 서사는 "결론 1줄 + 함정 1줄"로 압축, 폐기 가설은
  task 문서로 강등).

## Risks

- settings↔guard 비동기 변경 → 이중강제 정합성 붕괴. 완화: self-test green을 증거로.
- 에이전트 통합 시 강한 규칙 누락(S36 BLOCKER 재발). 완화: 통합본에 명시 보존.
- deploy.sh deny가 운영자 정당 실행까지 차단. 완화: `deny`가 아닌 `ask` 사용.
- 메모리 압축 시 근본원인 문장 소실. 완화: 파일별 수동 검토(일괄 sed 금지).
- dead-config 삭제 후 향후 클라우드 확장 시 재필요. 완화: 커밋 메시지에 복원 근거 기록.
