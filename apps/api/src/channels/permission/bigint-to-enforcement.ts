import { PERMISSIONS } from '@qufox/shared-types';
import { Permission, ALL_PERMISSIONS } from '../../auth/permissions';

/**
 * S62 (D12 / FR-RM03 · Fork A 결정): ADR-4 카탈로그 BigInt 비트필드(packages/
 * shared-types `PERMISSIONS`)를 집행 enum number 도메인(`auth/permissions.ts`
 * `Permission`)으로 변환하는 단방향 shim.
 *
 * ── 왜 shim 인가 ──────────────────────────────────────────────────────────────
 * S61 이 커스텀 Role 시스템(BigInt 14비트 카탈로그)을 도입했지만, 채널 ACL 집행은
 * 13년치 코드가 number 비트필드(`Permission` enum · ~16 사용처가 `(eff & req)===req`
 * 로 검사)를 쓴다. 두 도메인을 한 번에 통일하면 회귀 위험이 너무 커서(prod 권한
 * 붕괴), Fork A 결정대로 **집행 계산만 number 로 유지**하고, 커스텀 Role/카탈로그
 * 기여분을 이 헬퍼로 number 비트로 좁혀 OR 한다.
 *
 * ── 비트 매핑(카탈로그 → 집행) ─────────────────────────────────────────────────
 * 이 매핑은 시스템 5역할의 카탈로그 permissions(shared-types SYSTEM_ROLE_PERMISSIONS)
 * 를 변환했을 때 기존 `ROLE_BASELINE`(number)과 **정확히 일치**하도록 역산해 고정한
 * 다(회귀 critical 테스트가 강제). 단순 1비트→1비트가 아닌 까닭:
 *   - 집행 DELETE_OWN_MESSAGE / MANAGE_MEMBERS 비트는 카탈로그에 1:1 대응이 없다.
 *     ROLE_BASELINE 에서 DELETE_OWN_MESSAGE 는 MEMBER 이상(GUEST 제외)에만 있고,
 *     카탈로그에서 MEMBER 와 GUEST 를 가르는 비트는 ATTACH_FILES 다 → ATTACH_FILES
 *     를 UPLOAD_ATTACHMENT + DELETE_OWN_MESSAGE 두 집행 비트로 확장한다.
 *   - MANAGE_MEMBERS 는 ROLE_BASELINE 에서 ADMIN 이상에만 있고, ADMIN 과 MODERATOR
 *     를 가르는 카탈로그 비트는 MANAGE_CHANNEL 이다 → 카탈로그 MANAGE_CHANNEL 을
 *     집행 MANAGE_CHANNEL + MANAGE_MEMBERS 로 확장한다.
 *   - 카탈로그 READ_HISTORY / ADD_REACTIONS / USE_SLASH_COMMANDS / MENTION_EVERYONE /
 *     MANAGE_WEBHOOKS / CREATE_INVITES / USE_EXTERNAL_EMOJI 는 집행 ACL 게이트가
 *     검사하지 않는다(0 으로 매핑) — 가시성/반응/멘션은 별도 경로가 카탈로그 비트를
 *     직접 본다(reactions.controller·resolveMentionEveryone).
 *   - 카탈로그 ADMINISTRATOR(1<<63) 는 집행 ALL_PERMISSIONS(모든 집행 비트)로 확장.
 *
 * 이 매핑의 정합은 `bigint-to-enforcement.spec.ts` 가 5역할 baseline 일치로 잠근다.
 */

/** 카탈로그 비트 → 집행 비트(들). OR 누적한다. */
const CATALOG_TO_ENFORCEMENT: ReadonlyArray<readonly [bigint, number]> = [
  [PERMISSIONS.VIEW_CHANNEL, Permission.READ],
  [PERMISSIONS.SEND_MESSAGES, Permission.WRITE_MESSAGE],
  // READ_HISTORY: 집행 ACL 은 READ(가시성)로 흡수 — 별도 집행 비트 없음.
  [PERMISSIONS.READ_HISTORY, 0],
  [PERMISSIONS.MANAGE_MESSAGES, Permission.DELETE_ANY_MESSAGE],
  // ATTACH_FILES → 업로드 + 자기메시지 삭제(ROLE_BASELINE 정합: MEMBER 는 DEL_OWN 보유,
  // GUEST 는 ATTACH 미보유라 DEL_OWN 도 없음 — 이 확장이 그 경계를 재현한다).
  [PERMISSIONS.ATTACH_FILES, Permission.UPLOAD_ATTACHMENT | Permission.DELETE_OWN_MESSAGE],
  // 반응/슬래시/멘션/외부이모지/초대/웹훅: 집행 ACL 게이트 미검사(별도 카탈로그 경로).
  [PERMISSIONS.ADD_REACTIONS, 0],
  [PERMISSIONS.USE_SLASH_COMMANDS, 0],
  [PERMISSIONS.MENTION_EVERYONE, 0],
  // MANAGE_CHANNEL → 채널관리 + 멤버관리(ROLE_BASELINE 정합: ADMIN 은 MANAGE_MEMBERS
  // 보유, MODERATOR 는 카탈로그 MANAGE_CHANNEL 미보유라 MANAGE_MEMBERS 도 없음).
  [PERMISSIONS.MANAGE_CHANNEL, Permission.MANAGE_CHANNEL | Permission.MANAGE_MEMBERS],
  [PERMISSIONS.MANAGE_WEBHOOKS, 0],
  [PERMISSIONS.CREATE_INVITES, 0],
  [PERMISSIONS.USE_EXTERNAL_EMOJI, 0],
  [PERMISSIONS.BYPASS_SLOWMODE, Permission.BYPASS_SLOWMODE],
];

/**
 * S62 (FR-RM03): 카탈로그 BigInt 마스크를 집행 number 마스크로 변환한다.
 * ADMINISTRATOR 비트 보유 시 모든 집행 비트(ALL_PERMISSIONS)를 돌려준다.
 *
 * 입력은 부호 없는 논리값(fromStoragePermissions 통과 후) BigInt 라고 가정한다.
 */
export function bigintToEnforcementMask(mask: bigint): number {
  // ADMINISTRATOR(1<<63): 모든 집행 비트(가시성·전송·삭제·관리·업로드·슬로우모드 면제).
  if ((mask & PERMISSIONS.ADMINISTRATOR) !== 0n) {
    return ALL_PERMISSIONS;
  }
  let enforcement = 0;
  for (const [catalogBit, enforcementBits] of CATALOG_TO_ENFORCEMENT) {
    if ((mask & catalogBit) !== 0n) {
      enforcement |= enforcementBits;
    }
  }
  return enforcement >>> 0;
}
