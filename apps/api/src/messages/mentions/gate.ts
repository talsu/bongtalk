import type { Mentions } from './mention-extractor';

export type GateActorRole = 'OWNER' | 'ADMIN' | 'MEMBER';

/**
 * task-044-iter3: `@everyone` 멘션 권한 게이트.
 *
 * Discord 정책 준용: MEMBER 가 `@everyone` 입력 시 텍스트는 그대로
 * 보존하되 fanout 효과만 silently 무효화합니다 (mentions.everyone
 * = false). OWNER/ADMIN 는 효과 유지.
 *
 * mention-extractor 의 순수성 (workspace 스코프, 권한 무지) 을 유지
 * 하기 위해 service 계층 후처리 함수로 분리했습니다. send/update 의
 * extractMentions 직후에 호출합니다.
 *
 * 이 다운그레이드는 응답에 별도 신호 없음 — 사용자 경험은 Discord 와
 * 동일하게 "텍스트는 보이지만 알림은 안 감" 입니다. composer 측의
 * 사전 안내는 별도 follow-up.
 */
export function gateEveryoneMention(mentions: Mentions, actorRole: GateActorRole): Mentions {
  if (!mentions.everyone) return mentions;
  if (actorRole === 'OWNER' || actorRole === 'ADMIN') return mentions;
  return { ...mentions, everyone: false };
}

/**
 * task-046 iter8 (A9): `@here` 멘션 권한 게이트.
 *
 * `@everyone` 보다 부드러운 성격 (online 멤버만) 이지만 fanout 폭은 클
 * 수 있어 같은 게이트 적용. MEMBER 가 here=true 입력 시 silently false.
 */
export function gateHereMention(mentions: Mentions, actorRole: GateActorRole): Mentions {
  if (!mentions.here) return mentions;
  if (actorRole === 'OWNER' || actorRole === 'ADMIN') return mentions;
  return { ...mentions, here: false };
}

/**
 * S21 (FR-RS-16): `@channel` 멘션 권한 게이트. 현재 채널 멤버 전원을 깨우는
 * 범위 멘션이라 @everyone/@here 와 동일한 OWNER/ADMIN 게이트를 적용한다.
 * MEMBER 가 channel=true 입력 시 silently false 로 다운그레이드 → unread
 * mentionCount 집계에서도 자동 제외(S18 정합).
 */
export function gateChannelMention(mentions: Mentions, actorRole: GateActorRole): Mentions {
  if (!mentions.channel) return mentions;
  if (actorRole === 'OWNER' || actorRole === 'ADMIN') return mentions;
  return { ...mentions, channel: false };
}
