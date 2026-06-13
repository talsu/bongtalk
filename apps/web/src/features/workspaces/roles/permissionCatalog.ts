import { PERMISSIONS, type PermissionFlag, deserializePermissions } from '@qufox/shared-types';

/**
 * S61 (D12 / FR-RM01·02): 역할 권한 토글 UI 가 표시할 14개 권한 플래그 메타.
 *
 * 비트 값은 ADR-4 카탈로그(shared-types PERMISSIONS) 단일 출처를 재사용하며,
 * 여기서는 한국어 라벨/설명만 부여합니다(비트 재정의 금지). permissions BigInt 는
 * string(ADR-11)으로 송수신하므로 토글 상태는 bigint 로 다루고 직렬화 시 string.
 */
export interface PermissionMeta {
  flag: PermissionFlag;
  bit: bigint;
  label: string;
  description: string;
}

/** 토글 UI 노출 순서(ADMINISTRATOR 는 최상단 — 모든 권한 부여 경고용). */
export const PERMISSION_CATALOG: PermissionMeta[] = [
  {
    flag: 'ADMINISTRATOR',
    bit: PERMISSIONS.ADMINISTRATOR,
    label: '관리자',
    description: '모든 권한 + 채널 권한 오버라이드 무시',
  },
  {
    flag: 'VIEW_CHANNEL',
    bit: PERMISSIONS.VIEW_CHANNEL,
    label: '채널 보기',
    description: '채널 조회',
  },
  {
    flag: 'SEND_MESSAGES',
    bit: PERMISSIONS.SEND_MESSAGES,
    label: '메시지 전송',
    description: '메시지 전송',
  },
  {
    flag: 'READ_HISTORY',
    bit: PERMISSIONS.READ_HISTORY,
    label: '기록 보기',
    description: '이전 메시지 열람',
  },
  {
    flag: 'MANAGE_MESSAGES',
    bit: PERMISSIONS.MANAGE_MESSAGES,
    label: '메시지 관리',
    description: '타인 메시지 삭제/핀',
  },
  {
    flag: 'ATTACH_FILES',
    bit: PERMISSIONS.ATTACH_FILES,
    label: '파일 첨부',
    description: '파일/이미지 첨부',
  },
  {
    flag: 'ADD_REACTIONS',
    bit: PERMISSIONS.ADD_REACTIONS,
    label: '반응 추가',
    description: '이모지 반응 추가',
  },
  {
    flag: 'USE_SLASH_COMMANDS',
    bit: PERMISSIONS.USE_SLASH_COMMANDS,
    label: '슬래시 커맨드',
    description: '슬래시 커맨드 사용',
  },
  {
    flag: 'MENTION_EVERYONE',
    bit: PERMISSIONS.MENTION_EVERYONE,
    label: '전체 멘션',
    description: '@everyone',
  },
  // S94 (067 / FR-MSG-14): @channel/@here 범위 멘션 권한(@everyone 과 분리·기본 MEMBER 허용).
  {
    flag: 'MENTION_CHANNEL',
    bit: PERMISSIONS.MENTION_CHANNEL,
    label: '채널 멘션',
    description: '@channel / @here',
  },
  {
    flag: 'MANAGE_CHANNEL',
    bit: PERMISSIONS.MANAGE_CHANNEL,
    label: '채널 관리',
    description: '채널 설정 변경',
  },
  {
    flag: 'MANAGE_WEBHOOKS',
    bit: PERMISSIONS.MANAGE_WEBHOOKS,
    label: '웹훅 관리',
    description: '웹훅 CRUD',
  },
  {
    flag: 'CREATE_INVITES',
    bit: PERMISSIONS.CREATE_INVITES,
    label: '초대 생성',
    description: '초대 링크 생성',
  },
  {
    flag: 'USE_EXTERNAL_EMOJI',
    bit: PERMISSIONS.USE_EXTERNAL_EMOJI,
    label: '외부 이모지',
    description: '외부 커스텀 이모지',
  },
  {
    flag: 'BYPASS_SLOWMODE',
    bit: PERMISSIONS.BYPASS_SLOWMODE,
    label: '슬로우모드 면제',
    description: '슬로우모드 우회',
  },
  // 072-N5-2 (FR-RM05·06·07): 모더레이션 비트(ADR-4 단일출처 기존재, web 카탈로그
  // 누락이라 역할 편집 토글에 노출 안 되던 것 합류). 비트 재정의 없음.
  {
    flag: 'KICK_MEMBERS',
    bit: PERMISSIONS.KICK_MEMBERS,
    label: '멤버 추방',
    description: '멤버 강제 퇴장(재가입 가능)',
  },
  {
    flag: 'BAN_MEMBERS',
    bit: PERMISSIONS.BAN_MEMBERS,
    label: '멤버 차단',
    description: '멤버/비멤버 영구 차단(재진입 불가)',
  },
  {
    flag: 'TIMEOUT_MEMBERS',
    bit: PERMISSIONS.TIMEOUT_MEMBERS,
    label: '멤버 타임아웃',
    description: '멤버 임시 음소거',
  },
];

/** permissions string(BigInt as string) → 토글 상태(bigint). */
export function parsePermissions(value: string): bigint {
  return deserializePermissions(value);
}

/** 마스크에 해당 비트가 켜져 있는지(ADMINISTRATOR 우회 없이 raw 검사 — 토글 표시용). */
export function isBitOn(mask: bigint, bit: bigint): boolean {
  return (mask & bit) === bit;
}

/** 비트 토글: on 이면 끄고, off 면 켠 새 마스크 반환. */
export function toggleBit(mask: bigint, bit: bigint): bigint {
  return isBitOn(mask, bit) ? mask & ~bit : mask | bit;
}
