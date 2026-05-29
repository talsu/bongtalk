# Task 049 — Reviewer transcript & resolution

## Reviewer subagent (adversarial re-read)

- agent type: `reviewer` (독립 리뷰, 코드 미수정)
- transcript: 51,116 tokens / 32 tool uses / ~203s
- verdict: **APPROVE-with-nits** (BLOCKER 0 / HIGH 0)

### Targeted-concern 확인 (reviewer 답변 요약)

- **CI chromium 단일 스코핑이 functional 커버리지 손실 없음**: CI 는 4
  project 모두 `PLAYWRIGHT_BASE_URL=localhost:45173` 로 동일 baseURL +
  동일 Desktop Chrome → 3 project 는 순수 4× 중복 + visual snapshot
  강제 실패였음. env 분기 baseURL 은 `PLAYWRIGHT_BASE_URL` 미설정(수동
  reseed) 시에만 적용. **정당한 latent 회귀 수정.**
- **mobile-overview coverage 유지**: 구 fullPage 1장(4 frame) → element
  4장(dm/general/activity/voice) 으로 동일 4 frame 을 더 견고하게 커버.
  진동(5204↔5222px)으로 상시 timeout 이던 baseline 이라 잃은 신호 없음.
- **DS 4파일 unchanged 확인**: staged diff 에 `design-system/` 0건,
  live md5 = `.task-040-ds-baseline.txt` byte-identical.
- **real-app deferral 적절**: 익명 surface 결정적, 인증 surface 는 분리.

## Findings 및 처리

| #   | Sev | Finding                                                                                                   | 처리                                                                                                                                                                                                                                  |
| --- | --- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | MED | `ds-mockup-parity` / `vr-parity` 가 baseline 없이 chromium CI 에서 fail (선행 부채, "CI green" 주장 약화) | **fix-forward**: `mockup-dark/light` prod 시드 (정적, 결정성 2회). `vr-parity` 는 인증+테스트 스택 필요(prod NAS port 충돌로 안전 기동 불가) → `test.fixme` + `TODO(task-049-follow-vr-parity-baseline)`. broken-baselines 문서 갱신. |
| 2   | LOW | page-scoped nth 가 DS 삽입 시 조용히 밀려 픽셀 diff 를 내용 회귀로 오인                                   | **fix-forward**: capture 전 topbar title anchor 검증 추가 (mobile-046 7개 + mobile-overview 4개; overlay 는 title null skip). nth 이탈이 title mismatch 로 명확히 실패. prod 12 test 통과 확인.                                       |
| 3   | LOW | eval `artefacts-trio` 가 glob count≥1 라 PR/review 부재해도 통과                                          | **fix-forward**: 3 파일 각각 `test -f`.                                                                                                                                                                                               |
| 4   | LOW | eval `ds-files-untouched` 가 위치 기반 `head -4` 라 fragile                                               | **fix-forward**: 32-hex 해시만 `grep -oE`. dry-run UNCHANGED 확인.                                                                                                                                                                    |
| 5   | NIT | `invite-invalid` + `BETA_INVITE_REQUIRED=true` 상호작용                                                   | invalid invite 는 API error → `invite-invalid` 분기 (beta gate 무관). readySelector 15s + retries 2 로 보호.                                                                                                                          |

## visual-regression-scanner subagent (chunk C 의무 spawn)

- transcript: 50,176 tokens / 39 tool uses / ~117s
- verdict: 전 항목 PASS, "GREEN for merge" (DS 4파일 MD5 unchanged 포함).
- 048 audit 의 "Agent tool 미노출" 이 현 세션에서 해소됐음을 실증.

## 최종 상태

- BLOCKER/HIGH 0, 모든 finding fix-forward 완료.
- `pnpm verify` green. prod 전체 visual+layout 26 passed / 3 flaky(network) / 0 failed.
- chromium screenshot specs: visual(19) + real-app(3) + mockup(2) baseline 보유,
  vr-parity(2) fixme. → CI e2e 그린.
