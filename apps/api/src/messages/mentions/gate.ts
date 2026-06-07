import type { Mentions } from './mention-extractor';

/**
 * S44 (FR-MN-02 / FR-MN-16): `@everyone` / `@here` / `@channel` 멘션 권한 게이트.
 *
 * task-044~046 까지는 게이트가 `WorkspaceMember.role` enum 만 보고 OWNER/ADMIN
 * 외에는 silently false 였습니다. PRD FR-MN-02/16 은 ADR-4 `MENTION_EVERYONE`
 * (카탈로그 비트 0x0080) 권한을 역할/멤버별 override allow/deny 로 집행하도록
 * 정의합니다 — MEMBER 도 채널 override allow 면 `@everyone` 가능하고, OWNER/ADMIN
 * 도 override deny 면 불가합니다.
 *
 * 그래서 게이트 시그니처를 `role` 대신 **불리언 `hasMentionEveryone`** 으로 바꿉니다.
 * 권한 산정(역할 기본값 → 채널 override 5단계 fold)은 호출자(messages.service)가
 * `ChannelAccessService.resolveMentionEveryone` 로 수행해 결과만 넘깁니다. 이로써
 * gate 는 권한 정책을 모르는 순수 후처리 함수로 유지되고, 권한 fold 의 단일 출처는
 * channel-access 서비스가 됩니다.
 *
 * Discord 정책 준용: 권한 없는 사용자가 특수멘션을 입력해도 텍스트는 그대로
 * 보존하되 fanout 효과만 silently 무효화합니다(everyone/here/channel = false).
 * 응답에 별도 신호는 없습니다(클라이언트 FR-MN-16 경고 토스트가 사전 안내).
 */
export function gateEveryoneMention(mentions: Mentions, hasMentionEveryone: boolean): Mentions {
  if (!mentions.everyone) return mentions;
  return hasMentionEveryone ? mentions : { ...mentions, everyone: false };
}

/**
 * S44 (FR-MN-02): `@here` 게이트. `@everyone` 과 동일한 `MENTION_EVERYONE`
 * 권한 비트를 적용합니다(online 멤버만 깨우지만 fanout 폭은 클 수 있음).
 * online/idle 수신자 한정 필터는 messages.service 의 outbox emit 단계에서
 * 적용합니다(여기서는 권한 게이트만).
 */
export function gateHereMention(mentions: Mentions, hasMentionEveryone: boolean): Mentions {
  if (!mentions.here) return mentions;
  return hasMentionEveryone ? mentions : { ...mentions, here: false };
}

/**
 * S21 (FR-RS-16) / S44: `@channel` 게이트. 현재 채널 멤버 전원을 깨우는 범위
 * 멘션이라 `@everyone`/`@here` 와 동일한 `MENTION_EVERYONE` 권한을 적용합니다.
 * 권한 없으면 silently false 로 다운그레이드 → unread mentionCount 집계에서도
 * 자동 제외(S18 정합).
 */
export function gateChannelMention(mentions: Mentions, hasMentionEveryone: boolean): Mentions {
  if (!mentions.channel) return mentions;
  return hasMentionEveryone ? mentions : { ...mentions, channel: false };
}

/**
 * S88a (FR-MN-03 · D3): `@<RoleName>` 역할 멘션 게이트(순수 함수).
 *
 * 접근제어 정책은 "역할별 `mentionable===true` OR actor 가 MENTION_EVERYONE 권한
 * 보유" 입니다. 정책 판정(mentionable 플래그 로드 + non-mentionable 1개 이상일 때만
 * lazy `resolveMentionEveryone` 호출)은 service 가 수행하고, 이 함수는 그 결과로
 * 산출된 **허용 roleId 집합**으로 `mentions.roles` 를 필터링하기만 합니다 — gate 가
 * prisma/권한에 의존하지 않게 유지(다른 게이트들과 동일한 순수성).
 *
 * 게이트 탈락 역할은 silent downgrade(roles 에서 제거) — 권한 없는 특수멘션과 동일
 * 정책입니다. allowedRoleIds 가 mentions.roles 와 동일하면 새 객체 할당을 피합니다.
 */
export function gateRoleMention(mentions: Mentions, allowedRoleIds: ReadonlySet<string>): Mentions {
  if (mentions.roles.length === 0) return mentions;
  const filtered = mentions.roles.filter((id) => allowedRoleIds.has(id));
  if (filtered.length === mentions.roles.length) return mentions;
  return { ...mentions, roles: filtered };
}
