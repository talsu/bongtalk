import { NotificationEventType } from '@prisma/client';

/**
 * task-047 iter2 (K2): 알림 우선순위 매트릭스.
 *
 * Discord/Slack-parity. mute filter / DnD schedule 와 같이 fanout 단계
 * 에서 dispatcher 가 사용. 본 helper 는 pure mapping — 정책을 한 곳에
 * 모아 변경 시 dispatcher / batch / digest 가 일관되게 따라가게 함.
 *
 * 정책:
 *   high   — DM / mention / friend request (즉시 알림, mute bypass 옵션)
 *   medium — thread reply / @here (그룹 fanout)
 *   low    — reaction (digest 가능, throttle 권장)
 *
 * 향후 user 별 override 추가 시 본 mapping 을 default 로 두고 prefs 가
 * override 하는 패턴.
 */

export type NotificationPriority = 'high' | 'medium' | 'low';

const TABLE: Record<NotificationEventType, NotificationPriority> = {
  MENTION: 'high',
  REPLY: 'medium',
  REACTION: 'low',
  DIRECT: 'high',
  FRIEND_REQUEST: 'high',
};

export function priorityFor(eventType: NotificationEventType): NotificationPriority {
  return TABLE[eventType];
}

/** mute bypass 가능한 priority — high 만. */
export function bypassesMute(priority: NotificationPriority): boolean {
  return priority === 'high';
}

/** digest 로 batch 가능한 priority — low 만. */
export function isDigestable(priority: NotificationPriority): boolean {
  return priority === 'low';
}
