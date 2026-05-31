# Task 054 — PRD 자율 구현 프로그램 (P0~P3)

## Goal

PRD v3(`/prd/`, 17도메인 · 299 FR)를 **충실하게 전부 구현**한다. 한 번에 큰
작업을 하지 않고 **작고 검증가능한 FR 클러스터 슬라이스(3~8 FR)** 단위로,
각 슬라이스를 **여러 팀 협업 구조**로 구현 → 검증 → 머지 → 배포 → 다음, 반복.
사용자의 per-slice 지시 없이 백로그를 따라 **자율 진행**.

## 접근 (053 전략 합성 기반)

- **brownfield 점진 정렬** (greenfield 기각). PRD domain-model(ADR-1~13) = SSOT.
- **컨트랙트-퍼스트**: shared-types(Zod)+Prisma 먼저 PRD에 수렴 → API DTO → 클라이언트.
- 기존 코드 재사용. **PRD와 안 맞으면 과감히 재구현** (사용자 명시 승인).

## 슬라이스 단위 다팀 협업 흐름 (per slice)

1. **planner** — 슬라이스를 BE/FE/contract/migration/test 작업으로 분해 (Task Contract).
2. **AC→red test** — 클러스터 FR의 기계검증 AC를 실패 테스트로 먼저 커밋.
3. **feature-implementer** — red→green→refactor 구현 (BE Nest + FE React + Prisma + 테스트). scope 제한.
4. **리뷰 패널 (병렬, read-only)** — reviewer(adversarial) + contract-validator + security-scanner
   - (FE면) ui-designer/accessibility-auditor + performance-profiler → BLOCKER/HIGH/MED.
5. **fix-forward** — BLOCKER/HIGH 반영.
6. **VERIFY 게이트** — `pnpm verify`(lint+typecheck+unit+contract) exit 0 + 슬라이스 AC green.
   3연속 실패 시 중단 + 가설 3개 보고.
7. **머지·배포** — feat→develop→main(--no-ff) → webhook NAS auto-deploy → /readyz 게이트 +
   실패 시 자동 롤백. feat 브랜치 보존. REPORT(머지 SHA·reviewer·청크·verify·main SHA/exitCode/readyz).

## 정확성 (삼중 강제)

- `docs/tracing/fr-matrix.csv` — 299 FR × {fr_id, domain, priority, adr_refs, ac, test_files, status}.
- 기계검증 AC만 (산문 금지). AC를 red→green으로.
- contract-validator가 매 슬라이스 Zod↔class-validator↔Prisma 드리프트 0.

## 단계 (의존성 순서)

- **P-1 컨트랙트 수렴** (머지 차단 토대): shared-types permissions/constants/events,
  Prisma ADR-1~13(cuid2·Message canonical·BigInt 권한·UserPresence/Role/ChannelReadState/EditHistory/Mention),
  BigIntSerializationInterceptor.
- **P0**: D01 메시징 · D02 채널 · D03 DM · D09 읽음 · D17 실시간.
- **P1**: D04 스레드 · D05 반응 · D06 멘션/알림 · D08 presence · D10 핀 · D11 첨부.
- **P2**: D12 역할/모더레이션 · D13 워크스페이스/초대 · D07 검색 · D14 프로필 · D15 커맨드 · D16 리치.
- **P3**: Outbox DLQ · rate-limit · 인덱스 · src 단위 테스트 갭(c8) · Loki · eval 러너.

## 자율 루프 규칙

- 백로그(`docs/tracing/slice-backlog.md`) 순서대로 1슬라이스씩. 완료 시 fr-matrix status 갱신 + 다음.
- **멈추고 묻는 경우만**: (a) expand-contract로도 안전하지 않은 비가역 prod-DB 결정,
  (b) VERIFY 3연속 실패, (c) PRD 방향을 바꾸는 모호성, (d) 사용자 개입 요청.
- 그 외는 자동 진행. 각 슬라이스 배포 후 1줄 REPORT.

## 리스크

- cuid2 전면 전환(ADR-1) → **expand-contract 2단계**(신컬럼→백필→스위치→구컬럼 제거, reversible).
- 신계층(NotifLevel/UserPresence) 의미 충돌 → 어댑터 매핑 후 e2e 동등성 → 구 경로 제거.
- 자율 폭주 → scope_allow glob + max_turns + Edit scope 이중 제한.

## DoD

- [ ] fr-matrix.csv 299행 + slice-backlog 생성
- [ ] 슬라이스 0(shared-types 컨트랙트) green·배포
- [ ] P-1~P3 전 슬라이스 구현·머지·배포, fr-matrix 전 status=done
- [ ] PRD 전 FR이 코드+테스트로 추적됨
