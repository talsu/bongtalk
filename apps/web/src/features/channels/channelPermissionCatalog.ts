/**
 * S62 (FR-RM14): 채널 권한 오버라이드 3-state 토글 UI 메타.
 *
 * ⚠️ 채널 override 마스크는 **집행(enforcement) 비트필드**다(서버 controller 가
 * enforcement ALL_PERMISSIONS=0x1FF 로 검증). 역할 권한 카탈로그(shared-types
 * PERMISSIONS · BigInt)와는 비트 레이아웃이 다르므로, 여기서는 채널 ACL 게이트가
 * 실제 검사하는 집행 비트(apps/api auth/permissions.ts Permission)만 노출한다.
 *
 * allow/deny 마스크는 서버에서 string(BigInt-as-string)으로 내려오고(ADR-11),
 * 컴포넌트가 BigInt 로 파싱한 뒤 number 로 좁혀(≤0x1FF 안전) 토글한다.
 */

/** 집행 비트(number). apps/api auth/permissions.ts Permission enum 과 동일 값. */
export const ENFORCEMENT_BITS = {
  READ: 0x0001,
  WRITE_MESSAGE: 0x0002,
  DELETE_OWN_MESSAGE: 0x0004,
  DELETE_ANY_MESSAGE: 0x0008,
  MANAGE_MEMBERS: 0x0010,
  MANAGE_CHANNEL: 0x0020,
  UPLOAD_ATTACHMENT: 0x0040,
  BYPASS_SLOWMODE: 0x0100,
} as const;

export interface ChannelPermissionMeta {
  bit: number;
  label: string;
  description: string;
}

/** 토글 UI 노출 순서. */
export const CHANNEL_PERMISSION_CATALOG: ChannelPermissionMeta[] = [
  { bit: ENFORCEMENT_BITS.READ, label: '채널 보기', description: '채널 조회 · 가시성' },
  { bit: ENFORCEMENT_BITS.WRITE_MESSAGE, label: '메시지 전송', description: '메시지 전송' },
  {
    bit: ENFORCEMENT_BITS.UPLOAD_ATTACHMENT,
    label: '파일 첨부',
    description: '파일/이미지 업로드',
  },
  {
    bit: ENFORCEMENT_BITS.DELETE_OWN_MESSAGE,
    label: '내 메시지 삭제',
    description: '자신의 메시지 삭제',
  },
  {
    bit: ENFORCEMENT_BITS.DELETE_ANY_MESSAGE,
    label: '메시지 관리',
    description: '타인 메시지 삭제',
  },
  {
    bit: ENFORCEMENT_BITS.MANAGE_MEMBERS,
    label: '멤버 관리',
    description: '채널 멤버 추가/제거',
  },
  { bit: ENFORCEMENT_BITS.MANAGE_CHANNEL, label: '채널 관리', description: '채널 설정 변경' },
  {
    bit: ENFORCEMENT_BITS.BYPASS_SLOWMODE,
    label: '슬로우모드 면제',
    description: '슬로우모드 우회',
  },
];

/** 3-state: ALLOW(허용·초록) / DENY(거부·빨강) / INHERIT(상속·회색). */
export type TriState = 'allow' | 'deny' | 'inherit';

/**
 * allow/deny 마스크에서 특정 비트의 3-state 를 계산한다. DENY 가 우선(같은 비트가
 * allow·deny 둘 다면 deny 로 본다 — ADR-4 fold 상 deny 가 이긴다).
 */
export function bitTriState(allowMask: number, denyMask: number, bit: number): TriState {
  if ((denyMask & bit) === bit) return 'deny';
  if ((allowMask & bit) === bit) return 'allow';
  return 'inherit';
}

/**
 * 비트의 3-state 를 다음 상태로 바꾼 (allow, deny) 마스크 쌍을 반환한다(순환:
 * inherit → allow → deny → inherit). 토글은 항상 해당 비트를 양쪽에서 먼저 지우고
 * 새 상태만 켠다(allow·deny 동시 set 방지).
 */
export function applyTriState(
  allowMask: number,
  denyMask: number,
  bit: number,
  next: TriState,
): { allowMask: number; denyMask: number } {
  const allow = (allowMask & ~bit) >>> 0;
  const deny = (denyMask & ~bit) >>> 0;
  if (next === 'allow') return { allowMask: (allow | bit) >>> 0, denyMask: deny };
  if (next === 'deny') return { allowMask: allow, denyMask: (deny | bit) >>> 0 };
  return { allowMask: allow, denyMask: deny };
}

/** inherit → allow → deny → inherit 순환의 다음 상태. */
export function nextTriState(current: TriState): TriState {
  if (current === 'inherit') return 'allow';
  if (current === 'allow') return 'deny';
  return 'inherit';
}

/** string(BigInt-as-string) 마스크를 집행 number 로 좁힌다(≤0x1FF 안전). */
export function parseMaskToNumber(value: string): number {
  // FR-RM14: BigInt(value) 로 파싱 후 number 변환(집행 비트만 담겨 안전 범위).
  return Number(BigInt(value) & 0x1ffn);
}
