# Task 044 — DSPM — reviewer subagent transcript

## Spawn metadata

- Spawned at: 2026-05-07 (post-iteration-3, after main 18e1b9a deployed)
- Subagent type: `reviewer` (built-in; project `.claude/agents/*.md` definitions are committed to disk but not picked up by this session's harness — verifications run inline by main agent + final review by built-in reviewer)
- Transcript token count (estimated by reviewer): **≈ 22,200 토큰**

## Verdict

**request-changes (soft)** — 배포는 green, 즉시 롤백 사유 없음. H1 + H2 는 task-045 sweep 의 첫 안건으로 강제 권고.

## Findings

### BLOCKER (0 건)

없음. develop → main 자동 promote 후 readyz 200 + audit exitCode=0 확인.

### HIGH (다음 iteration 강제 fix)

**H1 — pin cap race window**

- 위치: `apps/api/src/messages/messages.service.ts:935-948` (pin transaction)
- 문제: `tx.message.count(...)` 가 PostgreSQL READ COMMITTED 격리 + `SELECT … FOR UPDATE`/advisory lock 부재 → 동시 admin 의 49→둘 다 49 셈 → cap+1 (51) 가능. partial unique 제약도 없어 DB 가 잡지 못함.
- 권고: (a) `pg_advisory_xact_lock(hashtextextended('pin:'||channelId,0))` 채널 직렬화, 또는 (b) UPDATE 조건부 + affected row 0 시 throw. testcontainers race spec 추가.
- TODO: `TODO(task-044-follow-pin-cap-race-fix)` (이월 → 045 sweep 첫 항목 권고).

**H2 — visual regression baseline 미캡처**

- 위치: `apps/web/e2e/visual/README.md`
- 문제: Acceptance Criteria 의 "Visual regression baseline 보존 또는 명시 갱신" 미충족. baseline 자체가 없어 향후 drift detect 불가.
- 권고: 다음 iteration 진입 전 `chore(visual-regression): seed baseline @ <sha>` commit 으로 11 surface (데스크톱 7 + 모바일 4) 첫 캡처.
- TODO: `TODO(task-044-follow-visual-baseline-seed)`.

### MED+ (이월 가능)

**M1 — pin endpoint idempotency-key 부재**

- 위치: `apps/api/src/messages/messages.controller.ts:278-304`
- CLAUDE.md "모든 POST 는 idempotency key" 비기능 요건 어긋남. pin 자체는 row-level idempotent 라 영향 작음.
- TODO: `TODO(task-044-follow-pin-idempotency-key)`.

**M2 — `actorRole` 기본값 silent**

- 위치: `apps/api/src/messages/messages.service.ts:351,831` (`args.actorRole ?? 'MEMBER'`)
- 현재는 안전 (DM workspaceId=null short-circuit) 하나, group DM 추가 시 fail-open 위험. explicit `null role → false` 분기 + spec 권고.
- TODO: `TODO(task-044-follow-gate-explicit-null-role)`.

**M3 — pin/unpin spec 의 트랜잭션 stub**

- 위치: `apps/api/test/unit/messages/pin.unit.spec.ts:68-70`
- `$transaction` 이 단순 `cb(tx)` stub → 트랜잭션 격리/롤백/race 미검증. testcontainers integration spec 보완 권고.
- TODO: `TODO(task-044-follow-pin-int-spec)`.

**M4 — listPins 권한 광범위**

- 위치: `apps/api/src/messages/messages.controller.ts:126-145`
- 모든 워크스페이스 멤버가 핀 목록 조회 가능 (Discord/Slack 동일 정책으로 명시됨). archived channel 의 pin 노출 정책 회귀 spec 1개 권고.
- TODO: `TODO(task-044-follow-listpins-archived-spec)`.

## Security / Performance

- **Pin 권한 우회 path**: `WorkspaceMemberGuard` + `ChannelAccessGuard` 선행. controller `m.role` 가드 + service `channelId` 필터 → cross-channel 차단. 양호.
- **@everyone 우회**: DM 채널 (workspaceId=null) → mention-extractor 가 `everyone=false` 강제. Thread reply 도 동일 send path. extractor → gate 직렬, 우회 불가.
- **WS dispatcher 미연결**: `apps/web/src/features/realtime/dispatcher.ts` `DISPATCHED_EVENTS` 에 `message.pin.toggled` 미포함 → 클라이언트 fail-safe 무시. backend 는 outbox 만 쌓음. UI 후속 작업 시 replay 가능.
- **Performance**: pin/unpin 단건 transaction 4 query, listPins partial index sparse scan, parseContent 단일 패스 O(n). N+1 없음.
- **Schema 호환**: `pinnedAt`/`pinnedBy` nullable + `MessageDtoSchema.default(null)` → 구버전 클라이언트 호환 OK.

## Test coverage 결손

- pin race (concurrent admin) integration spec 없음 (H1 연동).
- `MESSAGE_PIN_TOGGLED` outbox dispatcher 통과 테스트 없음.
- visual regression baseline 미캡처 (H2).
- @everyone gate 의 update path 회귀는 service 통합 spec 으로만 간접 커버.

## Memory 준수

- DS 4 파일 md5 baseline 일치 (tokens 8608…21b / components 4589…db9 / mobile 64bd…668 / icons 3886…252).
- 존댓말 / "MinIO" 용어 / `/volume3` 데이터 layout 준수.
- NAS-only 원칙 위반 없음.

## 잔여 risk

1. pin cap race (H1) — 실서비스 OWNER/ADMIN 활성도 낮으면 거의 안 터지지만 ToCToU 클래식.
2. Visual baseline 부재 (H2) — 향후 DS 변경 회귀 detect 불가.
3. **종료 조건 미충족** — score 86% < 90% + HIGH 갭 4/7 잔류 → task contract line 117-122 의 종료 조건 (≥90% AND HIGH=0 / cap10 / convergence <1%) 중 어느 것도 명확히 충족 안 됨. FINAL REPORT 에 "조기 종료" 사유 (컨텍스트 budget) 명시.

## 이월 follow-up TODO

- pin UI / pin panel / mobile pin / channel pin perm
- here mention / channel mention grant / composer warn everyone
- gate explicit null role / pin idempotency-key / pin int spec / pin cap race fix
- listpins archived spec / visual baseline seed
- **link unfurl (BE OG scraper + SSRF guard) — 시드 HIGH #3 미처리**
- **channel/DM mute — 시드 HIGH #4 미처리**
- **group DM (3+) — 시드 HIGH #6 미처리**
- **custom status text — 시드 HIGH #7 미처리**

## Iteration log

| Iteration | Sub-agent (built-in) | Calls | Tokens (est) | Findings                         |
| --------- | -------------------- | ----- | ------------ | -------------------------------- |
| 1         | (inline)             | 0     | -            | 5+3 검증 인라인 처리             |
| 2         | (inline)             | 0     | -            | 5+3 검증 인라인 처리             |
| 3         | (inline)             | 0     | -            | 5+3 검증 인라인 처리             |
| Final     | reviewer             | 1     | ~22,200      | H1 + H2 + 4 MED+ 발견, BLOCKER 0 |

> 프로젝트 `.claude/agents/*.md` 의 10 개 신규 sub-agent 정의는 commit 에 포함되어 있으나 본 세션의 Agent tool 은 framework default 만 노출 (claude-code-guide / db-migrator / Explore / general-purpose / implementer / ops / Plan / planner / release-manager / reviewer / statusline-setup / tester). 미래 세션에서는 이들 정의 파일이 자동 등록될 것으로 기대합니다.

## Final assessment

배포는 green, 사용자 영향 없음. 본 task 는 시드 HIGH 갭 7개 중 3개 (markdown 완전, pinned BE 부분, @everyone gate) 처리 + 4개 명시 이월 상태로 컨텍스트 budget 사유 조기 종료. 정량 종료 조건 미충족 — task-045 sweep 으로 잔류 HIGH 갭 + H1 race fix + H2 visual baseline 시드 + UI 후속 처리를 묶어 진행 권고.
