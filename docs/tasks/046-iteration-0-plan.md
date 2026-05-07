# Iteration 0 — Carry-over hot-fix PLAN

## 045 reviewer carry-over (BLOCKER 게이트)

### HIGH-1 — SSRF-IPv6-mapped-variant

- **위치**: `apps/api/src/links/ssrf-guard.ts:73-74` (isPrivateIPv6 의 mapped regex)
- **문제**:
  - 현재 `^::ffff:(\d+\.\d+\.\d+\.\d+)$` regex 가 정확한 `::ffff:` prefix 만 cover
  - `::ffff:0:127.0.0.1` (IPv4-translated `/96`) / 와 같이 `::ffff:0:0/96` 영역 누락
  - NAT64 well-known prefix `64:ff9b::/96` 미차단
  - `::1` (loopback) 은 이미 차단 (line 76) — 정상
- **fix 전략**:
  1. `expandIPv6(ip)` 호출 후 group 배열 검사 (regex 의존 제거)
  2. **IPv4-mapped (`::ffff:0:0/96`)**: groups[0..4] === 0 && groups[5] === 0xffff → groups[6,7] 에서 IPv4 추출 → isPrivateIPv4
  3. **IPv4-translated (`::ffff:0:0:0/96`)**: groups[0..3] === 0 && groups[4] === 0xffff && groups[5] === 0 → groups[6,7] → IPv4
  4. **NAT64 (`64:ff9b::/96`)**: groups[0]===0x0064 && groups[1]===0xff9b && groups[2..5]===0 → groups[6,7] → IPv4 (RFC 6052)
  5. **NAT64 RFC 8215 LIR (`64:ff9b:1::/48`)**: groups[0]===0x0064 && groups[1]===0xff9b && groups[2]===1 → 차단
  6. 모든 IPv4 추출 결과는 `isPrivateIPv4` 로 검증 (0.0.0.0/8, 10/8, CGNAT, 127/8 등 차단)
- **추가 차단**: discard prefix `100::/64` (RFC 6666) → groups[0..3]===0x0100,0,0,0 → 차단
- **회귀 spec**: `apps/api/test/unit/links/ssrf-guard.spec.ts` 확장 (각 변종 20+ 케이스)

### HIGH-2 — GDM members endpoint

- **현황**:
  - `apps/api/src/channels/direct-messages/global-dm.controller.ts` 에 GDM list / createGroupDm / listGroups 만 존재
  - `direct-messages.service.ts` 의 listGroups 는 memberIds (string[]) 만 반환 (username/avatar 없음)
- **fix 전략**:
  1. **service 신규**: `getGroupMembers(meId, gdmId): Array<{ userId, username, displayName, avatarUrl, customStatus, customStatusEmoji }>`
     - GDM 멤버십 검증: ChannelPermissionOverride 에 meId.allowMask & 1 > 0 + channel.type=DIRECT + name LIKE 'gdm:%'
     - 통과 시 모든 USER override.principalId → User row join (select username/displayName/avatarUrl/customStatus)
     - ban/leave 후 차단: 본인 override 가 deletedAt IS NULL && allowMask & 1 > 0 인 경우만 통과
  2. **controller 신규**: `@Get('groups/:gdmId/members')` (`/me/dms/groups/:gdmId/members`)
- **권한**: meId 가 GDM 멤버여야만 200, 아니면 404 (반환 시 leak 방지). non-GDM 채널 (1:1 DM / 일반 channel) 은 404
- **회귀 spec**: `apps/api/test/integration/channels/group-dm-members.int.spec.ts`
  - GDM 생성 후 멤버 list 200
  - non-member 의 호출 404
  - 채널 type != DIRECT 404
  - 1:1 DM (gdm: prefix 없음) 404
  - 본인 leave (override deletedAt 또는 allowMask 0) 후 호출 404

### MED-1 — status-broadcast-throttle (MED, fix-forward 권장)

- **위치**: `apps/api/src/users/me-status.controller.ts:81` (PATCH 후 broadcast)
- **현황**: 60/min × workspace fanout = spam 가능
- **fix 전략**: `presence-throttler` 패턴을 차용 — 5초 window 내 동일 (userId, workspaceId) coalesce
- **scope decision**: 045 reviewer 가 MED, 046 carry-over 흡수 권고. **fix-forward 채택** (dispatcher 의존도 적음)

### MED-2 — mute-filter-tx-strict (deprecation comment only)

- **위치**: `apps/api/src/notifications/mutes.service.ts` `filterMutedRecipients`
- **fix 전략**: 외부 호출 시 tx 주입 강제 — JSDoc 에 `@deprecated tx 인자 누락 호출 권장 안 됨` + log warn (NestJS Logger.warn) 추가
- **scope decision**: 코드 안전성 보강 only, 동작 변경 없음

### MED-3, MED-4 — no action (reviewer 결정)

### MED-5 — customStatus in members serializer

- **위치**: workspace members API (찾아서 select 절 추가)
- **fix 전략**: `User` select 에 `customStatus`, `customStatusEmoji`, `customStatusEmojiId`, `customStatusExpiresAt` 추가 + 응답 schema 확장
- **회귀 spec**: 기존 members spec 확장

### MED-6 — live-shell-visual-baseline 시드

- **fix 전략**: 045 의 DS-mockup-only baseline 외에, 라이브 shell 라우트 4-5 개 추가 (auth + DM 라우트 + channel 라우트 등)
- **scope decision**: 046 iter 0 에선 spec 만 시드 — 실제 snapshot 은 iter 2 (모바일 dimension) 와 함께 묶음

## 회귀 spec 표 (iteration 0)

| Spec                                     | 신규 cases | Cover                          |
| ---------------------------------------- | ---------- | ------------------------------ |
| ssrf-guard.spec.ts (확장)                | +20        | HIGH-1 mapped/translated/NAT64 |
| group-dm-members.int.spec.ts (신규)      | 6          | HIGH-2 GDM members endpoint    |
| status-broadcast-throttle.spec.ts (신규) | 3          | MED-1                          |
| (members serializer 확장 spec)           | +1         | MED-5                          |

## DoD (iteration 0)

- [ ] HIGH-1 SSRF fix + 회귀 spec
- [ ] HIGH-2 GDM members endpoint + service + controller + int spec
- [ ] MED-1 throttle 추가 + spec
- [ ] MED-2 deprecation comment + log
- [ ] MED-5 customStatus serializer + spec
- [ ] MED-6 live shell baseline 시드 (spec 만, snapshot 은 iter 2)
- [ ] pnpm verify (cumulative) green
- [ ] feature branch commit + develop merge + main auto-promote
- [ ] audit.jsonl exitCode=0 + /readyz 200 + idle 30s
- [ ] pane1 mini-progress 1줄

## 영향 줄 (예상)

- ssrf-guard.ts: ~30 라인 추가
- ssrf-guard.spec.ts: ~50 라인 추가
- direct-messages.service.ts: ~30 라인 추가 (getGroupMembers)
- global-dm.controller.ts: ~20 라인 추가
- group-dm-members.int.spec.ts: ~80 라인 신규
- me-status.controller.ts + throttler: ~50 라인 (helper 포함)
- mutes.service.ts: ~10 라인 (deprecation log)
- workspace members serializer: ~10 라인
- live-shell baseline spec: ~50 라인

총 ~330 라인 (테스트 포함).
