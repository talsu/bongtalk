# Iteration 0 — Carry-over hot-fix PLAN

## 046 reviewer carry-over (BLOCKER 게이트)

### HIGH-046-A — Thread subscribe channel ACL guard (real fix)

- 위치: `apps/api/src/messages/thread-subscriptions.service.ts:24-61`
- 문제: subscribe() 가 root 검증만, channel READ 검증 없음
- fix 전략:
  1. service.subscribe() 의 root 검증 직후 channel ACL 체크 추가
  2. ChannelPermissionOverride 의 USER override allowMask & READ > 0 검증
  3. 실패 시 CHANNEL_NOT_FOUND (존재 leak 방지) — getGroupMembers 와 동일 패턴
- 회귀 spec: thread-subscriptions.spec.ts 에 "non-channel-member subscribes → CHANNEL_NOT_FOUND" + "channel READ 가 있으면 통과" 케이스 추가

### HIGH-046-B — A9 @here e2e payload (real fix)

- 위치: `packages/shared-types/src/message.ts:7-11` + `apps/api/src/messages/events/message-events.ts`
- 문제: extractor + gate 는 here 처리 but Schema/event payload 가 here 누락 → 클라이언트 못 받음
- fix 전략:
  1. MessageMentionsSchema 에 `here: z.boolean().default(false)` 추가
  2. message-events.ts 의 mentions 객체에 here 필드 propagation
  3. messages.service 의 응답 매핑 (line 125-130 the row.mentions ?? default) 도 here 포함
- 회귀 spec: mention-extractor.spec.ts 의 here 케이스가 schema 통과까지 검증 + message-events 테스트 (있으면 확장, 없으면 services-level here propagation unit spec)

### MED-046-1 — IPv6 unspecified expanded `0:0:0:0:0:0:0:0` 차단

- 위치: `apps/api/src/links/ssrf-guard.ts:90-94`
- 문제: `lower === '::'` 만 cover, expanded form 누락
- fix: expandIPv6 후 모든 group === 0 체크 추가
- 회귀 spec: ssrf-guard.spec.ts 에 케이스 추가

### MED-046-2 — 6to4 (`2002::/16`) blanket block

- 위치: `apps/api/src/links/ssrf-guard.ts:159-161`
- 문제: 현재 embedded private IPv4 만 차단. NAT64 patterns 와 일관성 위해 blanket block 권장.
- fix: `groups[0] === 0x2002` 면 무조건 true 반환 (현재 isPrivateIPv4 check 제거)
- 회귀 spec: 기존 6to4 cases 에서 `2002:0808:808::` 도 true 반환 검증 (public IPv4 wrap 도 차단)

### MED-046-3 — Migration `CREATE INDEX CONCURRENTLY` convention

- 새 migration 추가 안 함, 본 fix 는 documentation 만:
  - `docs/conventions/migrations.md` (or 유사한) 에 "populated 테이블에 인덱스 추가 시 CREATE INDEX CONCURRENTLY 사용" 가이드 추가
  - CLAUDE.md 의 architecture principles 절에 한 줄 추가 옵션
- 본 iter 에서는 doc-only fix

### MED-046-4 — DnD validate raw Error → DomainError

- 위치: `apps/api/src/me/dnd-schedule.service.ts:42-77`
- 문제: validate() 가 raw `new Error(...)` 사용 → DomainError 변환 컨벤션 위반
- fix: 모든 throw 를 `new DomainError(ErrorCode.VALIDATION_FAILED, ...)` 로 교체
- 회귀 spec: dnd-schedule.spec.ts 의 validate 케이스가 DomainError instance 검증 추가

### MED-046-5 — SSRF hex-strict per group (defense-in-depth)

- 위치: `apps/api/src/links/ssrf-guard.ts:209-214`
- 문제: parseInt(g, 16) 이 partial hex 도 accept (e.g., '1xx' → 1)
- fix: parseInt 전에 `/^[0-9a-f]{1,4}$/i` regex 검증 추가 (실패 시 null 반환 → 보수적 차단)
- 회귀 spec: ssrf-guard.spec.ts 에 invalid-hex group 케이스 추가

### 모바일 4 row production code scope (정리)

- 046 iter 8 reclass 된 4 row: I3 reaction picker / I4 emoji picker / I7 onboarding / I8 pinned panel
- 4 production component shipping 은 한 iter 분량보다 큼 → **본 iter 에서는 scope 정리만, 실제 ship 은 별도 iter** (047 이후 이월 또는 048 으로)
- iter 0 에서는 매트릭스 항목별 production code 의 의존성 / DS 컴포넌트 / 데이터 모델 / API 정합성 분석 doc 작성
- 향후 iter 에서 1-2 row 씩 ship 하는 옵션 평가

## 회귀 spec 표 (iteration 0)

| Spec                                | 신규 cases | Cover                       |
| ----------------------------------- | ---------- | --------------------------- |
| thread-subscriptions.spec.ts (확장) | +3         | HIGH-046-A channel ACL      |
| mention-extractor.spec.ts (확장)    | +2         | HIGH-046-B here schema 통과 |
| ssrf-guard.spec.ts (확장)           | +5         | MED-046-1, 2, 5             |
| dnd-schedule.spec.ts (확장)         | +2         | MED-046-4 DomainError       |

## DoD (iteration 0)

- [ ] HIGH-046-A real fix + spec 회귀
- [ ] HIGH-046-B real fix + spec 회귀
- [ ] MED 1/2/4/5 fix (코드 + spec)
- [ ] MED 3 doc-only
- [ ] 모바일 4 row scope 명세 (실제 ship 은 다음 iter)
- [ ] pnpm verify (cumulative) green
- [ ] feature branch commit + develop merge + main auto-promote
- [ ] audit.jsonl exitCode=0 + /readyz 200 + idle 30s
- [ ] pane1 mini-progress 1줄

## 영향 줄 (예상)

- thread-subscriptions.service.ts: ~25 라인 추가 (channel ACL check)
- thread-subscriptions.spec.ts: ~50 라인 (3 case)
- packages/shared-types/src/message.ts: 1 라인 (here field)
- apps/api/src/messages/events/message-events.ts: ~5 라인
- apps/api/src/messages/messages.service.ts: ~5 라인 (here default)
- mention-extractor.spec.ts: ~30 라인 (2 case)
- ssrf-guard.ts: ~20 라인 (all-zero + 6to4 blanket + hex-strict)
- ssrf-guard.spec.ts: ~50 라인 (5 case)
- dnd-schedule.service.ts: ~10 라인 (DomainError 교체)
- dnd-schedule.spec.ts: ~20 라인 (2 case)
- docs/conventions/migrations.md: ~30 라인 (신규 doc)
- 모바일 4 row scope doc: ~60 라인

총 ~310 라인 (테스트 포함, doc 포함).
