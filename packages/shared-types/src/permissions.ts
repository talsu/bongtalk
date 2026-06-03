/**
 * ADR-4 · ChannelPermissionOverride 권한 비트 단일 출처.
 *
 * 권한 비트는 본 파일 1회만 정의합니다. Role / AutoModRule / API /
 * 프론트엔드 모두 이 파일을 참조하며, 다른 곳에서 재정의하지 않습니다.
 * (domain-model ADR-4 / ADR-11)
 *
 * 폐기됨: D02(7개 비트 표기) · D12(13개 비트 표기) · D06(MENTION_EVERYONE=0x100000)
 * 표기는 모두 폐기. 본 표(채널 overwrite 13 + ADMINISTRATOR 1 = 14개)가 유일 권위.
 */

/**
 * 14개 권한 플래그(BigInt 비트마스크). 채널 overwrite 가능 플래그 13개 +
 * ADMINISTRATOR 1개. ADMINISTRATOR 비트 소유자는 모든 권한을 가지며 채널
 * overwrite 검사 전체를 면제받습니다.
 */
export const PERMISSIONS = {
  VIEW_CHANNEL: 1n << 0n, // 0x0001 채널 조회
  SEND_MESSAGES: 1n << 1n, // 0x0002 메시지 전송
  READ_HISTORY: 1n << 2n, // 0x0004 이전 메시지 열람
  MANAGE_MESSAGES: 1n << 3n, // 0x0008 타인 메시지 삭제/핀
  ATTACH_FILES: 1n << 4n, // 0x0010 파일/이미지 첨부
  ADD_REACTIONS: 1n << 5n, // 0x0020 이모지 반응 추가
  USE_SLASH_COMMANDS: 1n << 6n, // 0x0040 슬래시 커맨드 사용
  MENTION_EVERYONE: 1n << 7n, // 0x0080 @everyone / @here
  MANAGE_CHANNEL: 1n << 8n, // 0x0100 채널 설정 변경
  MANAGE_WEBHOOKS: 1n << 9n, // 0x0200 웹훅 CRUD
  CREATE_INVITES: 1n << 10n, // 0x0400 초대 링크 생성
  USE_EXTERNAL_EMOJI: 1n << 11n, // 0x0800 외부 커스텀 이모지
  BYPASS_SLOWMODE: 1n << 12n, // 0x1000 슬로우모드 면제
  // S63 (D12 / FR-RM05·06·07): 워크스페이스 레벨 모더레이션 비트. 채널 overwrite
  // 대상이 아니라 CHANNEL_OVERWRITE_FLAGS 에 포함하지 않는다(아래). 13~62 의 빈 비트
  // 중 14~16 을 사용한다 — moderation 컨트롤러가 카탈로그 비트를 직접 검사한다(S62
  // 채널 집행 enum 과 별개의 워크스페이스 권한이라 enforcement mask 와 무관).
  KICK_MEMBERS: 1n << 14n, // 0x4000 멤버 강제 퇴장(재가입 가능)
  BAN_MEMBERS: 1n << 15n, // 0x8000 멤버/비멤버 userId 영구 차단(재진입 불가)
  TIMEOUT_MEMBERS: 1n << 16n, // 0x10000 멤버 임시 음소거(타임아웃)
  ADMINISTRATOR: 1n << 63n, // 0x8000000000000000 모든 권한 + overwrite 전체 면제
} as const;

export type PermissionFlag = keyof typeof PERMISSIONS;

/** 채널 overwrite 가능한 13개 플래그(ADMINISTRATOR 제외). */
export const CHANNEL_OVERWRITE_FLAGS = [
  'VIEW_CHANNEL',
  'SEND_MESSAGES',
  'READ_HISTORY',
  'MANAGE_MESSAGES',
  'ATTACH_FILES',
  'ADD_REACTIONS',
  'USE_SLASH_COMMANDS',
  'MENTION_EVERYONE',
  'MANAGE_CHANNEL',
  'MANAGE_WEBHOOKS',
  'CREATE_INVITES',
  'USE_EXTERNAL_EMOJI',
  'BYPASS_SLOWMODE',
] as const satisfies readonly PermissionFlag[];

/** 정의된 모든 비트의 OR — 유효 비트 검증/마스킹용. */
export const ALL_PERMISSIONS: bigint = Object.values(PERMISSIONS).reduce(
  (acc, bit) => acc | bit,
  0n,
);

/**
 * mask 가 flag 비트를 포함하는지 검사합니다. ADMINISTRATOR 비트를 가진
 * mask 는 (ADMINISTRATOR 자기 자신 외) 모든 플래그에 대해 true 를 반환합니다.
 */
export function has(mask: bigint, flag: bigint): boolean {
  if ((mask & PERMISSIONS.ADMINISTRATOR) !== 0n && flag !== PERMISSIONS.ADMINISTRATOR) {
    return true;
  }
  return (mask & flag) === flag;
}

/** mask 가 flag 비트를 정확히 포함하는지 — ADMINISTRATOR 우회 없이 raw 검사. */
export function hasRaw(mask: bigint, flag: bigint): boolean {
  return (mask & flag) === flag;
}

/** 여러 플래그를 단일 비트마스크로 결합합니다. */
export function combine(...flags: bigint[]): bigint {
  return flags.reduce((acc, flag) => acc | flag, 0n);
}

/**
 * Discord 권한 해석 순서(ADR-4): base → 역할 ALLOW → 역할 DENY →
 * 개인 ALLOW → 개인 DENY. 마지막에 적용된 DENY 가 우선합니다.
 * (계산 순서 표기 "개인 DENY > 개인 ALLOW > 역할 DENY > 역할 ALLOW > 기본"
 *  = 우선순위 내림차순. 적용은 그 역순.)
 */
export interface PermissionResolutionInput {
  base: bigint;
  roleAllow?: bigint;
  roleDeny?: bigint;
  userAllow?: bigint;
  userDeny?: bigint;
}

export function resolvePermissions(input: PermissionResolutionInput): bigint {
  const { base, roleAllow = 0n, roleDeny = 0n, userAllow = 0n, userDeny = 0n } = input;
  let mask = base;
  // 역할 tier: ALLOW 먼저, 그다음 DENY (역할 DENY > 역할 ALLOW)
  mask |= roleAllow;
  mask &= ~roleDeny;
  // 개인 tier: ALLOW 먼저, 그다음 DENY (개인 DENY > 개인 ALLOW) — 최우선
  mask |= userAllow;
  mask &= ~userDeny;
  return mask;
}

/**
 * ADR-11 BigInt 직렬화 헬퍼. 응답 DTO 의 allow/deny 등 BigInt 는 string 으로
 * 직렬화되며, 수신 시 서비스 레이어에서 BigInt 로 역변환합니다. DTO 타입
 * 표기는 string (BigInt as string).
 */
export function serializePermissions(mask: bigint): string {
  return mask.toString();
}

/**
 * S12 BLOCKER: validate a permission mask supplied as a JS number (the
 * ChannelPermissionOverride masks are stored as `Int` columns). Rejects
 * non-integers, negatives (two's-complement `-1` would set every bit and
 * smuggle in ADMINISTRATOR / undefined bits) and any bit outside the defined
 * ALL_PERMISSIONS range. Returns the same value on success so callers can use
 * it inline.
 */
export function assertValidPermissionMaskNumber(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`permission mask must be a non-negative integer: ${value}`);
  }
  if ((BigInt(value) & ~ALL_PERMISSIONS) !== 0n) {
    throw new RangeError(`permission mask out of range: ${value}`);
  }
  return value;
}

export function isValidPermissionMaskNumber(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && (BigInt(value) & ~ALL_PERMISSIONS) === 0n;
}

/**
 * S61 (FR-RM02): PostgreSQL signed bigint 저장 ↔ 부호 없는 논리값 변환.
 *
 * ADMINISTRATOR(1n<<63n = 9223372036854775808)는 PG signed bigint 최대값
 * (9223372036854775807)을 1 초과하므로, 64비트 패턴이 동일한 음수(-(2^63))로
 * 저장한다(two's-complement). 다른 13비트(0x1FFF 이하)는 양수라 변환이 항등이다.
 *
 * - toStoragePermissions: 도메인 논리값(부호 없음) → DB 저장값(signed).
 * - fromStoragePermissions: DB 에서 읽은 값(signed 가능) → 도메인 논리값(부호 없음).
 *
 * Role.permissions(BigInt) 읽기/쓰기 전 지점에서 이 한 쌍만 거치면 ADMINISTRATOR
 * 비트가 손실 없이 왕복한다. ChannelPermissionOverride 의 allow/deny 는 채널
 * overwrite 13비트만 담아 항상 양수이므로 이 변환을 거쳐도 무해하다.
 */
export function toStoragePermissions(mask: bigint): bigint {
  return BigInt.asIntN(64, mask);
}

export function fromStoragePermissions(stored: bigint): bigint {
  return BigInt.asUintN(64, stored);
}

export function deserializePermissions(value: string): bigint {
  // 권한 마스크는 부호 없는 비트필드. 음수("-1")를 허용하면 2의 보수로
  // 모든 비트가 켜진 것처럼 동작해 ADMINISTRATOR 비트가 포함되는 권한
  // 상승이 가능하다(리뷰 [M4]/[H-02]). 양의 정수(leading-zero 금지)만 허용.
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new RangeError(`invalid permission bitmask string: ${value}`);
  }
  const mask = BigInt(value);
  // 정의된 유효 비트(ALL_PERMISSIONS) 범위를 벗어난 마스크는 거부한다.
  // 미정의 비트(13~62)나 64비트 초과 garbage 가 영구 저장되는 것을 막는다.
  if ((mask & ~ALL_PERMISSIONS) !== 0n) {
    throw new RangeError(`permission bitmask out of range: ${value}`);
  }
  return mask;
}
