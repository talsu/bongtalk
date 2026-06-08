# Task 067 — FR-MSG-14 @channel/@here 권한 분리 + 서버 임계값 enforce (S94)

## Context

FR-MSG-14(P1, S18 partial): "@channel, @here, @everyone 특수 멘션. @everyone 은 OWNER/ADMIN
전용이며 채널 멤버수 ≥ EVERYONE_CONFIRM_THRESHOLD(6) 시 확인 dialog. @channel/@here 는 설정
가능(**기본 MEMBER 허용**)하며 채널 멤버수 ≥ BULK_MENTION_CONFIRM_THRESHOLD(50) 시 전송 전
확인 dialog. **서버도 동일 임계값으로 enforce**한다."

> **구현 주석(용어 정정)**: PRD 의 "채널 멤버수" 는 직관적 표현이고, 실제 서버 enforce 는
> **워크스페이스 멤버수**(WorkspaceMember count)를 기준으로 한다. broad 멘션 fanout
> (`resolveBroadMentionRecipients`)이 채널 멤버가 아니라 **워크스페이스 멤버 전원**을 대상으로
> 하므로, 임계값도 그 실제 핑 폭과 일치하는 워크스페이스 멤버수로 검사해야 안전망이 의미를 갖는다.

**현재 상태(매핑 — S18 carryover 대비 대폭 진전)**:

- ✅ `@channel` 추출(S21)·fanout(S44 — `resolveBroadMentionRecipients`: @everyone/@channel→워크스페이스
  멤버 전원·@here→online/idle)·임계값 상수(`constants.ts` 6/50)·클라 confirm(`specialMention.ts`)·
  gate 함수(`gate.ts`) 전부 존재.
- ⚠️ **권한 모델 편차(사용자 결정=Option B)**: 현재 `gateHereMention`/`gateChannelMention` 이
  `@everyone` 과 **단일 `MENTION_EVERYONE`(0x80·base OWNER/ADMIN/MODERATOR)** 로 게이트 →
  MEMBER 다운그레이드. PRD 는 @channel/@here **기본 MEMBER 허용**. → **별도 권한 비트 신설**.
- ⚠️ **서버 임계값 enforce 없음**: 6/50 은 클라 confirm 전용. 서버는 미검증(클라 우회 시 무제한 mass-ping).

## 사용자 결정

**Option B (PRD 대로·별도 권한)**: 새 `MENTION_CHANNEL` 비트(기본 MEMBER-on)로 @here/@channel 게이트,
`MENTION_EVERYONE` 은 @everyone 전용 유지. + 서버 임계값 6/50 enforce 함께 구현.

## Scope

### IN

**권한 비트 분리 (DB 마이그레이션 없음 — base 가 코드 role-enum 맵·override Int 는 기존 컬럼)**

1. **shared-types `permissions.ts`**: `MENTION_CHANNEL: 1n << 13n`(0x2000·free 비트) 추가 +
   `CHANNEL_OVERWRITE_FLAGS` 에 추가(13→14개). `ALL_PERMISSIONS` 자동 갱신. 주석: @here/@channel 게이트.
2. **`channel-access.service.ts`**: `MENTION_CHANNEL_BIT` 상수 + `MENTION_CHANNEL_ROLE_BASE`(**모든
   역할 ON**: OWNER/ADMIN/MODERATOR/MEMBER on·GUEST off[보수] — PRD "기본 MEMBER 허용") +
   `computeMentionChannel(channel, userId, role, roleUuids)` 메서드(`computeMentionEveryone` 미러 —
   동일 override 5단계 fold·MENTION_CHANNEL_BIT 만). hot-path 메타 로드에 `hasMentionChannel` 동반.
3. **`gate.ts`**: `gateHereMention`/`gateChannelMention` 시그니처를 `hasMentionEveryone` →
   `hasMentionChannel` 로 변경(또는 별도 인자 추가). `gateEveryoneMention` 은 `hasMentionEveryone` 유지.
4. **`messages.service.ts` send()/그 외 broadGated 호출 2곳(라인 ~1624·~3065)**: `hasMentionChannel`
   인자 수용 + 게이트 분리 적용(@everyone=hasMentionEveryone·@here/@channel=hasMentionChannel).
5. **컨트롤러(messages.controller + DM)**: `hasMentionEveryone` 산출 옆에 `hasMentionChannel` 산출
   (ChannelAccessService.computeMentionChannel) → send args 로 전달. 채널 override fold 일관.

**서버 임계값 enforce**

6. **ErrorCode**: `BULK_MENTION_CONFIRM_REQUIRED`(409·`CHANNEL_CONFIRM_REQUIRED` 선례 미러) —
   api enum + HTTP map + shared-types index.
7. **send DTO/스키마**: `bulkMentionConfirmed?: boolean`(optional·기본 false) 추가(shared-types Zod
   - class-validator + web 송신).
8. **`messages.service.ts` send()**: **게이트 통과 후·메시지 INSERT 전**에 임계값 체크 —
   게이트 살아남은 특수멘션이 있고 **워크스페이스 멤버수**(=broad fanout 대상이라 실제 핑 폭과
   일치 — resolveBroadMentionRecipients 가 WorkspaceMember 전원을 enumerate) ≥ 임계값
   (@everyone≥6·@here/@channel≥50)이며 `!bulkMentionConfirmed`
   → `throw BULK_MENTION_CONFIRM_REQUIRED`(details: {mention, count, threshold}).
   **INSERT 전 throw → idempotencyKey 미소비**(재전송 시 정상). 멤버수는 1쿼리(WorkspaceMember count).
   권한 없어 strip 된(FR-MSG-15) 멘션은 fanout 0 이라 체크 불요.

**FE**

9. composer: 서버 `BULK_MENTION_CONFIRM_REQUIRED` 응답 시 확인 dialog(기존 클라 임계값 UX 재사용) →
   확인 시 `bulkMentionConfirmed: true` 로 재전송. 클라 선제 임계값 dialog 는 유지(서버는 안전망).
10. 역할 편집 UI 권한 카탈로그에 MENTION_CHANNEL 노출(있으면)·@here/@channel 자동완성 복원(클라가
    종전 "거짓약속 차단"으로 제거했다면 — MEMBER 도 기본 가능해졌으므로 복원).

**TEST**

- unit: gate 분리(MEMBER 가 @here/@channel 기본 통과·@everyone 차단·DENY override 로 @channel 박탈·
  computeMentionChannel fold). 임계값 판정 헬퍼.
- int(`messages.channel-mention-frmsg14.int.spec.ts`): MEMBER @here/@channel 기본 fanout 도달 /
  @everyone MEMBER 차단(strip) / 채널 override DENY MENTION_CHANNEL → MEMBER @channel 박탈 /
  멤버수 ≥6 @everyone + !confirm → 409 / ≥50 @channel + !confirm → 409 / confirm=true → 전송 /
  임계값 미만 → confirm 불요.

### OUT (후속/Non-goals)

- @here online 판정 정밀화(기존 presence 기반 유지). GUEST @here/@channel(보수적 off).
- 워크스페이스 멤버수 정확 캐시(count 쿼리로 충분·고빈도 아님).
- 권한 카탈로그 UI 대규모 개편(MENTION_CHANNEL 1개 노출만).

## Acceptance Criteria (기계 검증)

- [ ] `MENTION_CHANNEL`(0x2000) shared-types 정의 + CHANNEL_OVERWRITE_FLAGS 14개 + ALL_PERMISSIONS 포함.
- [ ] MEMBER 가 override 없이 @here/@channel 멘션 → fanout 도달(MentionGate 통과·strip 안 됨).
- [ ] MEMBER 가 @everyone → strip(FR-MSG-15·기존 MENTION_EVERYONE base off 유지).
- [ ] 채널 ROLE override DENY(MENTION_CHANNEL 비트) → 해당 역할 MEMBER @channel 박탈.
- [ ] 워크스페이스 멤버수 ≥6 @everyone(권한자) + bulkMentionConfirmed 미동봉 → 409 BULK_MENTION_CONFIRM_REQUIRED
      (idempotencyKey 미소비). ≥50 @here/@channel 동일. confirmed=true → 정상 전송. 미만 → 무confirm 전송.
- [ ] **편집(PATCH) 으로 새로 추가된** broad 멘션도 send 와 동일 임계값 enforce(HIGH-1 보안 갭) —
      평문 send 후 편집으로 @channel 주입 시 ≥50 + 미confirm → 409, confirmed=true → 적용, 기존
      @channel 메시지의 내용만 편집(신규추가 아님) → 재confirm 불요.
- [ ] verify(lint+typecheck+unit+contract) green · 신규 int green(container standalone).
- [ ] **DB 마이그레이션 없음**(base=코드 role-enum 맵·override 기존 Int 컬럼·bit13 unset=DENY 없음=기본 ON).

## Risks

- **권한 완화(보안)**: @here/@channel 가 MEMBER 기본 허용 → 멤버 대량-핑 가능. **임계값 enforce(6) 가
  안전망**(≥6 멤버 채널은 @everyone confirm·≥50 은 @here/@channel confirm). 소규모 채널은 무confirm 허용
  (PRD 의도). 채널 ADMIN 은 override DENY 로 특정 역할 박탈 가능.
- **gate 시그니처 변경**: `gateHereMention`/`gateChannelMention` 호출처 전수(send 2곳 + 테스트) 갱신 필요.
  단위 테스트가 시그니처 변경을 잡는다. `hasMentionEveryone` 단일 인자였던 것을 두 boolean 으로.
- **마이그레이션 불요 검증**: computeMentionEveryone(channel-access.service:490-538)이 base 를
  role-enum 맵에서·override 를 Int 컬럼에서 fold → 신규 비트도 동일 경로. 기존 override 에 bit13 없음 =
  DENY 없음 = 기본 ON. 단, 역할 편집 UI/권한 카탈로그가 ALL_PERMISSIONS 를 노출하면 새 비트가 보임(의도).
- 임계값 throw 위치: INSERT 전(idempotency 미소비). resolveBroadMentionRecipients 는 INSERT 후라
  별도의 가벼운 멤버 count 쿼리를 게이트 직후 수행.

## DoD

체크리스트 green + standalone container `pnpm verify` + 신규 int green + 7차원 리뷰
(reviewer/contract/security/perf/ui/a11y/visual·**security 중점**=권한 완화) fix-forward +
fr-matrix FR-MSG-14→done + handoff LIVE + 수동 배포(승인 후·DEPLOY_SHA 없이) + `/readyz=200` + 디스크 모니터.
