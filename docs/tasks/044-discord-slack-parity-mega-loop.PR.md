# Task 044 — Discord / Slack Parity Mega-Loop (DSPM) — PR notes

> 이 파일은 자율 메가 loop 의 누적 PR 요약입니다. iteration 별 commit 표 + 최종 score 변화 + DoD 체크리스트 + deploy 검증 결과.

## Goal

Beta 진입 전 텍스트 채팅 + DM 영역을 Discord/Slack 수준으로 끌어올림. parity 78% → ≥ 90% AND HIGH 갭 = 0 (또는 cap 10 / convergence).

## Restore point

- Tag: `v0.43-restore-point` (ea5ae50)
- Branch: `restore-point/main-ea5ae50`

## Iterations summary

| Iter | 처리 항목                       | Score 변화   | Develop SHA | Main SHA | /readyz |
| ---- | ------------------------------- | ------------ | ----------- | -------- | ------- |
| 0    | scaffold + visual baseline 시드 | 78% baseline | TBD         | TBD      | TBD     |
| 1    | _filled by loop_                | TBD          | TBD         | TBD      | TBD     |
| 2    | _filled by loop_                | TBD          | TBD         | TBD      | TBD     |

## HIGH gap 처리

| #   | 항목                              | 처리 iteration | 비고 |
| --- | --------------------------------- | -------------- | ---- |
| 1   | Pinned messages                   | TBD            |      |
| 2   | Markdown bold/italic/strike/quote | TBD            |      |
| 3   | Link unfurl / OpenGraph           | TBD            |      |
| 4   | Channel/DM mute                   | TBD            |      |
| 5   | @everyone/@here permission gate   | TBD            |      |
| 6   | Group DM (3+)                     | TBD            |      |
| 7   | Custom status text                | TBD            |      |

## DS 4파일 baseline

- `.task-040-ds-baseline.txt` 와 일치 — md5 출력은 review 산출물에 첨부

## Sub-agent 호출 통계

_loop 종료 후 채워짐 — agent 별 호출 수 + 총 token_

## Visual regression baseline 변경

_iteration 별 의도 변경 시 명시_

## DoD

- [ ] `pnpm verify` green
- [ ] parity score ≥ 90% AND HIGH=0 (또는 cap 10 / convergence)
- [ ] DS 4파일 md5 baseline 일치
- [ ] Visual regression baseline 보존/의도 갱신
- [ ] axe critical=0, serious=0
- [ ] 모든 iteration deploy 성공 + readyz 200
- [ ] Reviewer subagent 1회 스폰
- [ ] Pane 1 auto-forward iteration 별 + 종료 1회

## Memory 준수

- DS source-of-truth (`feedback_design_system_source_of_truth.md`)
- 존댓말 (`feedback_polite_korean.md`)
- MinIO 용어 (`feedback_minio_naming.md`)
- `/volume3/qufox-data/` 데이터 layout
- Skip PR direct-merge to develop (`feedback_skip_pr_direct_merge.md`)
- Auto-promote main on iteration boundary (`feedback_auto_promote_to_main.md`)
- Pane 0 → pane 1 forward (`feedback_pane0_auto_forward_report.md`)
- Webhook audit at `/volume2/dockers/qufox-deploy/.deploy/audit.jsonl` (`reference_deploy_audit_location.md`)
- Feature branch 유지 (`feedback_retain_feature_branches.md`)
- Handoff REPORT 필수 (`feedback_handoff_must_include_report.md`)
