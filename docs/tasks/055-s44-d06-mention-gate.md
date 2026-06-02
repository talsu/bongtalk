# 055 · S44 D06 멘션·알림 게이트 (FR-MN-01/02/04/16)

## Context

D06 멘션·알림 슬라이스. 현재 서버 멘션 권한 게이트(`gate.ts`)가
`WorkspaceMember.role` enum 만 보고 OWNER/ADMIN 외에는 `@everyone`/`@here`/
`@channel` fanout 을 silently 무효화합니다. PRD FR-MN-02/16 는 ADR-4
`MENTION_EVERYONE`(카탈로그 비트 `0x0080`) 권한을 역할/멤버별 override
allow/deny 로 집행하도록 정의합니다(MEMBER 도 override allow 면 `@everyone`
가능, OWNER/ADMIN 도 override deny 면 불가). 또한 WS 이벤트 와이어 이름이
PRD 카탈로그에서 `mention:new` 인데 현재 wire 가 `mention.received` 입니다.

마이그레이션 0(MentionRecord/Activity Inbox 는 S46 carryover).

## Scope

### IN

- FR-MN-02 + FR-MN-16: 서버 멘션 게이트가 `ChannelPermissionOverride` 의
  `MENTION_EVERYONE`(카탈로그 `0x0080`) 비트를 ADR-4 5단계 fold 로 집행.
  base = 역할 기본값(OWNER/ADMIN on, MEMBER off). everyone/here/channel 모두 적용.
- FR-MN-02: `@here` fanout 수신자를 presence ONLINE/IDLE 멤버로 한정.
- FR-MN-01: WS 이벤트 와이어 이름 `mention:new` 로 정렬(내부 outbox dot
  `mention.received` 유지, wire 만 colon).
- FR-MN-16 클라: 권한 없는 사용자가 `@everyone`/`@here` 입력·전송 시 경고 토스트.

### OUT (carryover)

- MentionRecord / Activity Inbox (S46)
- `@role` 자동완성 + ROLE fanout (S45)
- `@here` 팬아웃 SLO perf(200명 cap·5초, S45)
- `@channel` fanout 정렬 (S45)
- D12 권한수렴(API enum 0x80 ↔ 카탈로그 0x80) 전면 통합
- priority.bypassesMute(high) 미적용(기존)
- 사이드바 키보드 a11y (S43 carryover)

## Acceptance Criteria (기계 검증)

- `pnpm verify` 전체 GREEN + 빌드 3종.
- unit: `MENTION_EVERYONE` override fold(MEMBER allow→허용 · OWNER deny→차단 ·
  기본 MEMBER 차단), gate(bool) 다운그레이드, `@here` online 필터.
- int(실DB): override 기반 `@everyone` fanout(MEMBER allow→발생, OWNER deny→차단,
  기본 MEMBER→차단), `@here` online 필터(ONLINE/IDLE 만 수신), `mention:new` 이벤트 정렬.

## Non-goals

- 새 권한 비트 추가, MentionRecord 테이블, BullMQ 비동기 fanout.

## Risks

- D12 비트 충돌: 집행 enum(`auth/permissions.ts`) 의 `0x0080`=PIN_MESSAGE 와
  카탈로그(`shared-types`) `0x0080`=MENTION_EVERYONE 이 같은 비트 위치다.
  멘션 게이트는 **카탈로그 비트(0x0080)를 직접** 검사하므로, 동일 채널에서
  PIN_MESSAGE override 와 MENTION_EVERYONE override 가 동일 비트를 공유한다.
  전면 분리는 D12 carryover. 본 슬라이스는 PRD 지시대로 카탈로그 비트 직접
  검사로 진행하며, 별도 resolver(`resolveMentionEveryone`)로 격리한다.
