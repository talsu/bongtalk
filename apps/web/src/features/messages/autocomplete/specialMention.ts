import {
  EVERYONE_CONFIRM_THRESHOLD,
  BULK_MENTION_CONFIRM_THRESHOLD,
  type WorkspaceRole as SharedWorkspaceRole,
} from '@qufox/shared-types';

/**
 * S18 (FR-MSG-14 / FR-MSG-15) — 특수 멘션 권한 게이트 + confirm 임계값.
 *
 * 권한(FR-MSG-15) — 서버 게이트와 1:1 정합:
 *   - `@everyone` : OWNER/ADMIN 전용. 서버 `gateEveryoneMention` 이 MEMBER 의
 *     fanout 을 무효화하므로 자동완성/ confirm 에서도 MEMBER 에게는 숨깁니다.
 *   - `@here`     : OWNER/ADMIN 전용. 서버 `gateHereMention` 이 동일하게 MEMBER
 *     의 fanout 을 무효화합니다(S18 리뷰 MAJOR — 이전엔 클라가 MEMBER 에게도
 *     here 를 허용해 거짓 confirm 을 띄웠습니다).
 *   - `@channel`  : 서버 mention-extractor 가 `@channel` 을 추출하지 않아(현재는
 *     everyone/here 만) 알림 fanout 이 발생하지 않습니다. confirm 이 "이만큼에게
 *     알립니다" 라고 약속해도 실제로는 알림이 안 가는 거짓 약속이므로 자동완성
 *     특수항목·confirm 세트에서 제외합니다. 서버 `@channel` fanout 추출은
 *     carryover(D04 mentions).
 *
 * confirm 임계값(FR-MSG-14):
 *   - `@everyone` : 채널 멤버수 >= EVERYONE_CONFIRM_THRESHOLD(6) 시 확인 dialog.
 *   - `@here`     : >= BULK_MENTION_CONFIRM_THRESHOLD(50) 시 확인 dialog.
 *
 * 임계값은 shared-types 상수를 재사용합니다(재정의 금지).
 */
// S61: 시스템 역할 5단계 확장 — 로컬 3값 재정의를 폐기하고 shared-types 단일
// 출처를 재노출한다. 특수 멘션(@everyone/@here) 게이트는 클라이언트 측 보수적
// 표시 규칙으로 OWNER/ADMIN 만 허용하며(서버가 최종 권위), MODERATOR/MEMBER/GUEST
// 는 자동완성에서 숨긴다.
export type WorkspaceRole = SharedWorkspaceRole;
export type SpecialMentionKey = 'everyone' | 'here';

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
  everyone: {
    key: 'everyone',
    token: '@everyone',
    label: '@everyone',
    description: '워크스페이스 전체에 알림',
  },
};

/**
 * FR-MSG-15: 역할별 특수 멘션 사용 권한. 서버 게이트(gateEveryoneMention /
 * gateHereMention)와 동일하게 `@everyone` · `@here` 모두 OWNER/ADMIN 전용입니다.
 * MEMBER 가 입력해도 서버가 fanout 을 무효화하므로 자동완성·confirm 에서 숨깁니다.
 */
export function canUseSpecialMention(_key: SpecialMentionKey, role: WorkspaceRole): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

/**
 * FR-RC03: 팝업 상단에 노출할 특수 멘션 항목. 권한 없는 항목은 제외하고,
 * 타이핑한 prefix 로 필터합니다. 순서는 here → everyone.
 */
export function specialMentionItems(role: WorkspaceRole, query: string): SpecialMentionItem[] {
  const q = query.toLowerCase();
  const order: SpecialMentionKey[] = ['here', 'everyone'];
  return order
    .filter((key) => canUseSpecialMention(key, role))
    .map((key) => ITEMS[key])
    .filter(
      (item) => q.length === 0 || item.key.startsWith(q) || `@${item.key}`.startsWith(`@${q}`),
    );
}

/** FR-MSG-14: 멤버수 기준 confirm 필요 여부. */
export function needsSpecialMentionConfirm(key: SpecialMentionKey, memberCount: number): boolean {
  if (key === 'everyone') return memberCount >= EVERYONE_CONFIRM_THRESHOLD;
  return memberCount >= BULK_MENTION_CONFIRM_THRESHOLD;
}

/**
 * S44 (FR-MN-16): 본문에서 사용자가 입력한 특수멘션 중 **권한이 없는** 키를
 * 찾습니다. 권한 판정은 `canUseSpecialMention`(역할 기본값)을 그대로 씁니다 —
 * 클라이언트는 채널 override 까지는 알 수 없으므로 역할 기준으로만 경고하고,
 * 서버가 override allow 로 실제로 허용하는 경우엔 단지 불필요한 경고가 빠지는
 * 쪽이 아니라(클라가 모르므로 경고가 뜰 수 있음) 보수적으로 안내합니다. 권한이
 * 없는데 입력하면 서버 게이트가 fanout 을 무효화하므로(FR-MN-02), 전송 전 경고
 * 토스트로 "알림이 가지 않음"을 사전 고지하는 용도입니다.
 *
 * 반환: 권한 없는 첫 특수멘션 키(everyone/here) 또는 null. `@channel` 은
 * 자동완성/confirm 세트에서 제외돼 있어(서버 fanout 미추출 아님 — S44 부터
 * @channel 도 게이트 대상이나 본 토스트는 everyone/here 만 다룸) 여기서도 제외.
 */
export function firstUnauthorizedSpecialMention(
  text: string,
  role: WorkspaceRole,
): SpecialMentionKey | null {
  const lower = text.toLowerCase();
  const keys: SpecialMentionKey[] = ['everyone', 'here'];
  for (const key of keys) {
    const re = new RegExp(`(?<![A-Za-z0-9_])@${key}(?![A-Za-z0-9_])`);
    if (!re.test(lower)) continue;
    if (!canUseSpecialMention(key, role)) return key;
  }
  return null;
}
