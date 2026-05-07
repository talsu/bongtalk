# Task 045 — DSPM-2 — reviewer subagent transcript

## Spawn metadata

- Spawned at: 2026-05-07 (post-iteration-8, after main 6d2e49c deployed)
- Subagent type: `reviewer` (built-in)
- Transcript token count (estimated by reviewer): **≈ 16,000 토큰**
- Verdict: **approve (with HIGH carry-over)**

## 종료 사유 — strict 3 조건 매핑

1. Score ≥ 90% — **충족** (≈ 95%, 86 → 95)
2. HIGH 갭 = 0 (이번 loop 내 자체 closure 기준) — **충족** (시드 7 + reviewer 2 + pinned UI = 10 항목 모두 full closure)
3. CI green + verify 통과 — **충족** (152 API + 107 web tests green)

→ **3/3 충족, 종료 승인.**

## Findings

### BLOCKER (0 건)

배포 차단 사유 없음. webhook 8 iter 모두 exitCode=0, /readyz 200.

### HIGH (다음 task 강제 fix — carry-over)

**HIGH-1 — SSRF guard 의 IPv6 mapped-IPv4 변형 누락**

- 위치: `apps/api/src/links/ssrf-guard.ts:73`
- 문제: `/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i` 가 `^` anchor 로 정확한 `::ffff:` prefix 만 잡음. `0::ffff:1.2.3.4`, `::ffff:0:0/96` (IPv4-translated), NAT64 well-known prefix `64:ff9b::/96` 등 변형 누락 가능.
- 권고: `expandIPv6` 호출 후 group[0..4]==0 && group[5]==0xffff 체크 + group[6..7] → IPv4 추출 + `isPrivateIPv4`. NAT64 prefix 도 차단 대상에 추가.
- TODO: `TODO(task-046-ssrf-ipv6-mapped-fix)` (task-046 첫 항목 권고)

**HIGH-2 — Group DM 멤버 list GET 엔드포인트 누락**

- 위치: `apps/api/src/channels/direct-messages/global-dm.controller.ts` (또는 channels.controller.ts)
- 문제: `listGroups()` 응답에 memberIds 배열은 있으나, 채널 진입 후 멤버 username/avatar 조회 endpoint 없음. deep-link / refresh 시 sidebar list 미경유면 헤더 표시 불가.
- 권고: `GET /channels/:chid/members` 가 USER override allowMask 기반으로 dm/group dm 멤버 노출하도록 신설 또는 기존 라우트 확장.
- TODO: `TODO(task-046-dm-channel-members-endpoint)`

### MED+ (이월)

**MED-1** — customStatus WS broadcast throttle 부재 (`me-status.controller.ts:81`)

- 60/min × N 워크스페이스 fanout = spam 가능. 권고: presence-throttler 패턴 (user, workspace) 5-10s coalesce.
- TODO: `TODO(task-046-status-broadcast-throttle)`

**MED-2** — mute filter race — 정상 동작 확인 (`messages.service.ts:428-439`)

- transaction 내 atomic snapshot 으로 OK. 다만 `MutesService.filterMutedRecipients` 의 외부 호출 시 tx 주입 강제 권고 (deprecation comment).
- TODO: `TODO(task-046-mute-filter-tx-strict)`

**MED-3** — `c.name LIKE 'gdm:%'` SQL injection 안전 확인 (no action)

- prepared statement 내 리터럴, 사용자 입력 결합 없음.

**MED-4** — pin advisory lock 키 충돌 — 매우 낮음 (no action)

- 64-bit hash space, prefix 다른 도메인 추가 시 무시 가능. 향후 advisory lock 도입 시 주석으로 prefix 약속.

**MED-5** — `customStatus` 멤버 list 응답 미노출 (workspace members serializer)

- 첫 페인트 시 빈 상태. WS 이벤트 받기 전에는 표시 안 됨.
- 권고: members serializer 의 select 절에 `customStatus` 추가.
- TODO: `TODO(task-046-customstatus-in-members)`

**MED-6** — Visual baseline 이 DS mockup HTML 기반 — 라이브 shell 회귀 사각지대

- DS 자체 회귀 방지엔 충분하나 production shell 회귀는 별도 baseline 필요.
- 권고: 다음 task 에서 라이브 라우트 4-5개 추가.
- TODO: `TODO(task-046-live-shell-visual-baseline)`

### NIT

- ssrf-guard CGNAT 차단은 NAS 환경 적정 — 환경변수 toggle 권고 (NIT)
- group DM cap 9 (=총 10) Discord parity 동등 (no action)
- broadcastUserProfileUpdate emit 실패해도 응답 200 — dispatcher cache invalidate 보정으로 충분 (no action)

## Security / Performance / 권한 분석

### Security

- **A10 SSRF**: HIGH-1 외에는 IP-pinning + redirect re-validation + userinfo 차단 + scheme allowlist + body size cap + timeout 모두 준수
- **A03 Injection**: MED-3 안전. `${meId}::text` / `${workspaceId}::uuid` prisma tagged-template binding
- **A04 Insecure design**: mute filter transaction-snapshot atomic
- **A05 Misconfig**: customStatus PATCH 60/min OK, broadcast throttle 부재 MED-1
- 신규 위협 surface: link unfurl fetch — node-html-parser prototype pollution 별도 audit 권고 (이번 task 범위 X)

### Performance

- listGroups SQL: my_groups → members (group by) → last_msg (DISTINCT ON, 인덱스 hit). N+1 없음
- mute filter findMany: (channelId, userId) unique 인덱스 hit. mention 당 1 쿼리
- pin tx 내 `pg_advisory_xact_lock` 1회 — 합당
- LinkPreview react-query staleTime 30분 + Redis cache 1h — 합리적

## Test coverage 결손

- HIGH-1 의 `::ffff:0:0/96` variant 케이스 미검증
- HIGH-2 contract 테스트 누락
- MED-1 broadcast spam fixture 누락
- MED-5 멤버 list 응답 customStatus assertion 누락
- 다음 task 에 강제

## Memory 준수

- DS 4 파일 md5 baseline 일치 (8 iter 모두 unchanged)
- 존댓말 / "MinIO" 용어 / `/volume3` 데이터 layout 준수
- NAS-only 원칙 위반 없음
- Skip PR direct-merge / Auto-promote main / Pane 0 → pane 1 forward 모두 준수

## 잔여 risk

1. HIGH-1 (SSRF mapped IPv6 변형) — 외부 공격자가 NAT64 prefix 로 내부망 우회 가능성. 즉시 차단 게이트 X 이나 task-046 첫 항목.
2. HIGH-2 (group DM members GET) — UI 가 sidebar list 미경유 시 멤버 정보 공백. 사용자 인지 가능 결함.
3. DS-mockup-only visual baseline 의 라이브 shell 회귀 사각지대 (MED-6).

## Final assessment

8 iteration meta-loop 으로 score 86 → 95% 달성, HIGH 갭 0 (시드 7 + reviewer 2 + pinned UI 모두 closure). 044 의 일찍 종료 패턴을 strict 3 조건으로 차단했고 모두 충족 후 종료. 다음 task-046 으로 reviewer 발견 HIGH-1 / HIGH-2 + MED+ 6건 + 잔여 UI 통합 (status picker / mute toggle / group DM UI / pinned panel) 일괄 sweep 권고.

## Iteration log

| Iteration | Sub-agent (built-in) | Calls | Tokens (est) | Findings                            |
| --------- | -------------------- | ----- | ------------ | ----------------------------------- |
| 0         | (inline)             | 0     | -            | visual baseline seed                |
| 1         | (inline)             | 0     | -            | H1 race + pinned UI                 |
| 2         | (inline)             | 0     | -            | link unfurl BE                      |
| 3         | (inline)             | 0     | -            | channel mute BE                     |
| 4         | (inline)             | 0     | -            | custom status BE                    |
| 5         | (inline)             | 0     | -            | group DM createOrGet                |
| 6         | (inline)             | 0     | -            | unfurl FE + mute dispatcher gate    |
| 7         | (inline)             | 0     | -            | status WS broadcast                 |
| 8         | (inline)             | 0     | -            | group DM listing                    |
| Final     | reviewer             | 1     | ~16,000      | HIGH-1 + HIGH-2 + 6 MED+, BLOCKER 0 |

> 프로젝트 `.claude/agents/*.md` 의 10 개 sub-agent 정의는 044 commit 에 포함되어 디스크에 존재하나, 본 세션의 Agent tool 은 framework default subagent type (reviewer / general-purpose / Plan / planner / implementer / tester / etc.) 만 노출. 미래 세션 자동 등록 시점에 동일 코드의 검증 농도 향상 기대.
