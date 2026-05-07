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
