import type { NotifLevel } from '@prisma/client';

/**
 * S46 (D06 / ADR-6 / FR-MN-05/06/07/08): NotifLevel 3계층 resolve + fanout 게이트.
 *
 * 순수 함수 묶음 — DB 접근이 없다. 멘션 fanout(messages.service)이 후보 수신자
 * 전원의 prefs 를 batch 로 한 번에 로드한 뒤(N+1 방지), per-recipient 로 이
 * 헬퍼를 메모리 fold 해 "이 멘션을 알림으로 보낼지" 를 판정한다.
 *
 * 3계층 우선순위(좁은 범위 우선 — ADR-6):
 *   채널(UserChannelMute.level) → 서버(ServerNotificationPref.level) → 글로벌
 *   (UserSettings.notifTrigger). 채널 level=null 이면 서버를, 서버 행이 없으면
 *   글로벌을, 글로벌 행이 없으면 MENTIONS(기본값)를 쓴다.
 *
 * 뮤트(isMuted)는 level 과 독립한 별도 축이다(ADR-6): 서버/채널 어느 한 곳이라도
 * 활성 뮤트면 멘션 outbox 를 스킵한다. 뮤트는 "직접 @username 도 push 는 막되
 * Inbox 기록은 유지"가 정책이나, S46 는 Inbox(S47) 전이라 outbox 스킵으로만 표현한다.
 */

export type MentionKind =
  | 'direct' // 명시적 @username
  | 'broad'; // @everyone / @here / @channel 로 확장된 수신자

export interface ResolvedNotifInputs {
  /** 채널 오버라이드(UserChannelMute.level). null = 서버 상속. 행 부재도 null. */
  channelLevel: NotifLevel | null;
  /** 서버 오버라이드(ServerNotificationPref.level). 행 부재면 null. */
  serverLevel: NotifLevel | null;
  /** 글로벌(UserSettings.notifTrigger). 행 부재면 null → MENTIONS 폴백. */
  globalLevel: NotifLevel | null;
  /** 서버 뮤트 활성 여부(isMuted && (muteUntil null | muteUntil>now)). */
  serverMuted: boolean;
  /** 채널 뮤트 활성 여부(UserChannelMute 행 존재 && (mutedUntil null | >now)). */
  channelMuted: boolean;
}

/**
 * 3계층을 fold 해 effective NotifLevel 을 돌려준다. 좁은 범위(채널)가 우선이며,
 * 채널 level=null 은 "서버 상속"을 뜻한다. 어떤 층도 값을 주지 않으면 MENTIONS.
 */
export function resolveEffectiveLevel(args: {
  channelLevel: NotifLevel | null;
  serverLevel: NotifLevel | null;
  globalLevel: NotifLevel | null;
}): NotifLevel {
  return args.channelLevel ?? args.serverLevel ?? args.globalLevel ?? 'MENTIONS';
}

/**
 * 이 수신자에게 멘션 알림(mention.received outbox)을 보낼지 판정한다.
 *
 *   - 서버/채널 뮤트 활성 → 항상 스킵(level 무관 — ADR-6 isMuted 독립축).
 *   - effective level === 'NOTHING' → 스킵(직접 @username 의 Inbox 기록은 S47).
 *   - effective level === 'MENTIONS' → broad(@everyone/@here/@channel)는 스킵,
 *     직접 @username 은 통과.
 *   - effective level === 'ALL' → 통과(broad/direct 모두).
 *
 * 기존 dnd · ThreadSubscription.OFF 게이트와는 독립이다 — 호출부가 이 판정과
 * 별도로 합성한다(둘 중 하나라도 스킵이면 스킵).
 */
export function shouldNotifyMention(inputs: ResolvedNotifInputs, kind: MentionKind): boolean {
  if (inputs.serverMuted || inputs.channelMuted) return false;
  const level = resolveEffectiveLevel(inputs);
  if (level === 'NOTHING') return false;
  if (level === 'ALL') return true;
  // MENTIONS: 직접 @username 만 통과, broad 는 스킵.
  return kind === 'direct';
}

/** 뮤트 활성 판정(muteUntil null=영구 / 미래=만료전 → 활성). 과거/미설정 비활성. */
export function isMuteActive(isMuted: boolean, muteUntil: Date | null, now: Date): boolean {
  if (!isMuted) return false;
  return muteUntil === null || muteUntil.getTime() > now.getTime();
}
