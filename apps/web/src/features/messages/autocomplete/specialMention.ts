import {
  EVERYONE_CONFIRM_THRESHOLD,
  BULK_MENTION_CONFIRM_THRESHOLD,
  type WorkspaceRole as SharedWorkspaceRole,
} from '@qufox/shared-types';

/**
 * S18 (FR-MSG-14 / FR-MSG-15) · S94 (067 / FR-MSG-14, Option B) — 특수 멘션 권한
 * 게이트 + confirm 임계값.
 *
 * 권한 — 서버 게이트와 1:1 정합:
 *   - `@everyone` : OWNER/ADMIN(+MODERATOR) 전용. 서버 `gateEveryoneMention`
 *     (MENTION_EVERYONE) 이 일반 MEMBER 의 fanout 을 무효화하므로 자동완성/confirm
 *     에서도 MEMBER 에게는 숨깁니다.
 *   - `@here` / `@channel` : S94(Option B)로 별도 `MENTION_CHANNEL`(0x2000) 권한이
 *     생겨 **기본 MEMBER 허용**입니다. 서버 `gateHere/ChannelMention` 이 MEMBER 도
 *     통과시키므로 자동완성/confirm 에 노출합니다(종전 "거짓 약속 차단"으로 제거했던
 *     @channel/@here-MEMBER 표시를 복원). 채널 override DENY 로 박탈될 수 있으나
 *     클라이언트는 override 를 모르므로 역할 기본값으로만 표시합니다(서버가 최종 권위).
 *
 * confirm 임계값(FR-MSG-14) — 서버 임계값 enforce(BULK_MENTION_CONFIRM_REQUIRED)와
 * 동일하게 클라이언트도 선제 confirm dialog 를 띄웁니다(서버는 안전망):
 *   - `@everyone` : 채널 멤버수 >= EVERYONE_CONFIRM_THRESHOLD(6) 시 확인 dialog.
 *   - `@here` / `@channel` : >= BULK_MENTION_CONFIRM_THRESHOLD(50) 시 확인 dialog.
 *
 * 임계값은 shared-types 상수를 재사용합니다(재정의 금지).
 */
// S61: 시스템 역할 5단계 확장 — shared-types 단일 출처를 재노출한다.
// S94 (067, Option B): @here/@channel 은 MENTION_CHANNEL(기본 MEMBER 허용)이라
// 자동완성에 노출하고, @everyone 만 OWNER/ADMIN(+MODERATOR) 전용으로 게이트한다.
export type WorkspaceRole = SharedWorkspaceRole;
export type SpecialMentionKey = 'everyone' | 'here' | 'channel';

export type SpecialMentionItem = {
  key: SpecialMentionKey;
  /** 삽입 토큰(앞의 @ 포함). */
  token: string;
  /** 자동완성 라벨. */
  label: string;
  /** 보조 설명(__sub). */
  description: string;
};

const ITEMS: Record<SpecialMentionKey, SpecialMentionItem> = {
  here: {
    key: 'here',
    token: '@here',
    label: '@here',
    description: '온라인 멤버에게 알림',
  },
  channel: {
    key: 'channel',
    token: '@channel',
    label: '@channel',
    description: '채널 멤버 전체에 알림',
  },
  everyone: {
    key: 'everyone',
    token: '@everyone',
    label: '@everyone',
    description: '워크스페이스 전체에 알림',
  },
};

/**
 * FR-MSG-15 · S94(067, Option B): 역할별 특수 멘션 사용 권한. 서버 게이트와 1:1 정합:
 *   - `@everyone` : MENTION_EVERYONE base 가 OWNER/ADMIN/MODERATOR 만 ON 이므로 그 셋만.
 *   - `@here` / `@channel` : MENTION_CHANNEL base 가 MEMBER 까지 ON(GUEST 만 off)이라
 *     GUEST 를 제외한 전 역할이 기본 사용 가능. 채널 override DENY 박탈은 서버가 최종 판정.
 */
export function canUseSpecialMention(key: SpecialMentionKey, role: WorkspaceRole): boolean {
  if (key === 'everyone') {
    return role === 'OWNER' || role === 'ADMIN' || role === 'MODERATOR';
  }
  // @here / @channel — GUEST 만 기본 차단(MENTION_CHANNEL base off).
  return role !== 'GUEST';
}

/**
 * FR-RC03: 팝업 상단에 노출할 특수 멘션 항목. 권한 없는 항목은 제외하고,
 * 타이핑한 prefix 로 필터합니다. 순서는 here → channel → everyone.
 */
export function specialMentionItems(role: WorkspaceRole, query: string): SpecialMentionItem[] {
  const q = query.toLowerCase();
  const order: SpecialMentionKey[] = ['here', 'channel', 'everyone'];
  return order
    .filter((key) => canUseSpecialMention(key, role))
    .map((key) => ITEMS[key])
    .filter(
      (item) => q.length === 0 || item.key.startsWith(q) || `@${item.key}`.startsWith(`@${q}`),
    );
}

/**
 * FR-MSG-14: 멤버수 기준 confirm 필요 여부. `@everyone` 은 6, `@here`/`@channel` 은
 * 50(BULK_MENTION_CONFIRM_THRESHOLD)에서 확인 dialog 를 띄운다(서버 임계값과 동일).
 */
export function needsSpecialMentionConfirm(key: SpecialMentionKey, memberCount: number): boolean {
  if (key === 'everyone') return memberCount >= EVERYONE_CONFIRM_THRESHOLD;
  return memberCount >= BULK_MENTION_CONFIRM_THRESHOLD;
}

/**
 * S44 (FR-MN-16) · S94 (067, Option B): 본문에서 사용자가 입력한 특수멘션 중
 * **권한이 없는** 키를 찾습니다. 권한 판정은 `canUseSpecialMention`(역할 기본값)을
 * 그대로 씁니다 — 클라이언트는 채널 override 까지는 알 수 없으므로 역할 기준으로만
 * 경고하고, 권한 없는데 입력하면 서버 게이트가 fanout 을 무효화하므로(FR-MN-02),
 * 전송 전 경고 토스트로 "알림이 가지 않을 수 있음"을 사전 고지하는 용도입니다.
 *
 * S94 로 @here/@channel 은 기본 MEMBER 허용이 됐으므로, 일반 MEMBER 가 입력해도
 * 경고하지 않습니다(GUEST 만 @here/@channel 권한이 없음). everyone/here/channel
 * 모두 검사하되 canUseSpecialMention 이 역할 기준으로 판정합니다.
 *
 * 반환: 권한 없는 첫 특수멘션 키(everyone/here/channel) 또는 null.
 */
export function firstUnauthorizedSpecialMention(
  text: string,
  role: WorkspaceRole,
): SpecialMentionKey | null {
  const lower = text.toLowerCase();
  const keys: SpecialMentionKey[] = ['everyone', 'here', 'channel'];
  for (const key of keys) {
    const re = new RegExp(`(?<![A-Za-z0-9_])@${key}(?![A-Za-z0-9_])`);
    if (!re.test(lower)) continue;
    if (!canUseSpecialMention(key, role)) return key;
  }
  return null;
}
