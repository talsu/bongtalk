import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PERMISSIONS, SYSTEM_ROLE_PERMISSIONS, CHANNEL_OVERWRITE_FLAGS } from '@qufox/shared-types';
import { bigintToEnforcementMask } from '../../../src/channels/permission/bigint-to-enforcement';
import {
  Permission,
  ROLE_BASELINE,
  ALL_PERMISSIONS,
  CHANNEL_OVERRIDE_BITS,
} from '../../../src/auth/permissions';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

/**
 * S62 (FR-RM03): shim 회귀 잠금. 카탈로그→집행 변환이 시스템 5역할의 카탈로그
 * permissions 를 변환했을 때 기존 ROLE_BASELINE(number)과 **정확히 일치**해야 한다.
 * 이것이 "커스텀 Role 없는 기존 워크스페이스 결과 == 기존 baseline" 의 핵심 불변식.
 */
describe('S62 bigintToEnforcementMask — system role baseline equivalence', () => {
  it('OWNER(ADMINISTRATOR) maps to enforcement ALL_PERMISSIONS', () => {
    expect(bigintToEnforcementMask(SYSTEM_ROLE_PERMISSIONS.OWNER)).toBe(ALL_PERMISSIONS);
    expect(bigintToEnforcementMask(SYSTEM_ROLE_PERMISSIONS.OWNER)).toBe(ROLE_BASELINE.OWNER);
  });

  it('ADMIN catalog maps exactly to ROLE_BASELINE.ADMIN', () => {
    expect(bigintToEnforcementMask(SYSTEM_ROLE_PERMISSIONS.ADMIN)).toBe(ROLE_BASELINE.ADMIN);
  });

  it('MODERATOR catalog maps exactly to ROLE_BASELINE.MODERATOR', () => {
    expect(bigintToEnforcementMask(SYSTEM_ROLE_PERMISSIONS.MODERATOR)).toBe(
      ROLE_BASELINE.MODERATOR,
    );
  });

  it('MEMBER catalog maps exactly to ROLE_BASELINE.MEMBER', () => {
    expect(bigintToEnforcementMask(SYSTEM_ROLE_PERMISSIONS.MEMBER)).toBe(ROLE_BASELINE.MEMBER);
  });

  it('GUEST catalog maps exactly to ROLE_BASELINE.GUEST', () => {
    expect(bigintToEnforcementMask(SYSTEM_ROLE_PERMISSIONS.GUEST)).toBe(ROLE_BASELINE.GUEST);
  });
});

describe('S62 bigintToEnforcementMask — individual catalog bits', () => {
  it('VIEW_CHANNEL → READ', () => {
    expect(bigintToEnforcementMask(PERMISSIONS.VIEW_CHANNEL)).toBe(Permission.READ);
  });

  it('SEND_MESSAGES → WRITE_MESSAGE', () => {
    expect(bigintToEnforcementMask(PERMISSIONS.SEND_MESSAGES)).toBe(Permission.WRITE_MESSAGE);
  });

  it('MANAGE_MESSAGES → DELETE_ANY_MESSAGE', () => {
    expect(bigintToEnforcementMask(PERMISSIONS.MANAGE_MESSAGES)).toBe(
      Permission.DELETE_ANY_MESSAGE,
    );
  });

  it('ATTACH_FILES → UPLOAD_ATTACHMENT | DELETE_OWN_MESSAGE', () => {
    expect(bigintToEnforcementMask(PERMISSIONS.ATTACH_FILES)).toBe(
      Permission.UPLOAD_ATTACHMENT | Permission.DELETE_OWN_MESSAGE,
    );
  });

  it('MANAGE_CHANNEL → MANAGE_CHANNEL | MANAGE_MEMBERS', () => {
    expect(bigintToEnforcementMask(PERMISSIONS.MANAGE_CHANNEL)).toBe(
      Permission.MANAGE_CHANNEL | Permission.MANAGE_MEMBERS,
    );
  });

  it('BYPASS_SLOWMODE → BYPASS_SLOWMODE', () => {
    expect(bigintToEnforcementMask(PERMISSIONS.BYPASS_SLOWMODE)).toBe(Permission.BYPASS_SLOWMODE);
  });

  it('catalog-only bits (READ_HISTORY/ADD_REACTIONS/USE_SLASH/MENTION_EVERYONE/WEBHOOKS/INVITES/EXT_EMOJI) map to 0', () => {
    for (const bit of [
      PERMISSIONS.READ_HISTORY,
      PERMISSIONS.ADD_REACTIONS,
      PERMISSIONS.USE_SLASH_COMMANDS,
      PERMISSIONS.MENTION_EVERYONE,
      PERMISSIONS.MANAGE_WEBHOOKS,
      PERMISSIONS.CREATE_INVITES,
      PERMISSIONS.USE_EXTERNAL_EMOJI,
    ]) {
      expect(bigintToEnforcementMask(bit)).toBe(0);
    }
  });

  it('empty mask maps to 0', () => {
    expect(bigintToEnforcementMask(0n)).toBe(0);
  });
});

/**
 * S104 (carryover · 사용자 결정 = Fork A 브리지 수용 + drift-guard 강화).
 *
 * ── Fork A 2-레이아웃 불변식(이 블록이 단일 정본·CI 가 drift 차단) ─────────────────
 * 권한 비트는 **의도적으로** 두 레이아웃으로 분리돼 있다(S62 Fork A — 한 번에 통일 시
 * prod 권한 붕괴 위험). 이는 drift 버그가 아니라 테스트된 분리다:
 *   1) 카탈로그(shared-types `PERMISSIONS`·BigInt): 역할권한(Role.permissions)의 단일
 *      출처(ADR-4). 역할 편집 UI 가 이 레이아웃을 쓴다.
 *   2) 집행(`auth/permissions.ts` `Permission` enum·number): 채널 ACL 게이트(~16
 *      `(eff&req)===req` 사용처) + ChannelPermissionOverride.allow/deny 컬럼 + web
 *      `channelPermissionCatalog.ts`(override UI)가 쓰는 레이아웃.
 *   3) 브리지(`bigintToEnforcementMask`): 역할 카탈로그 기여분을 집행 number 로 좁힌다
 *      (위 5역할 baseline 일치가 잠금).
 * 두 레이아웃은 비트 위치가 다르나(예: 0x4 = 카탈로그 READ_HISTORY vs 집행
 * DELETE_OWN), **멘션 비트 2개(MENTION_EVERYONE 0x80 · MENTION_CHANNEL 0x2000)만**
 * 의도적으로 정렬돼 있다 — override 컬럼에서 멘션 게이트(resolveMentionScopes)가 이
 * 두 비트를 카탈로그 의미로 읽고, 집행 enum 은 이 비트를 비워둬(0x80 예약·0x2000
 * 범위 밖) 충돌이 없다. 아래 가드가 이 정합을 잠가, 향후 누군가 카탈로그/집행 비트를
 * 옮기면 CI 가 실패한다.
 *
 * ★ web `channelPermissionCatalog.ts` 는 같은 집행 레이아웃의 *수동 미러* 다(패키지
 *   경계상 enum 을 import 할 수 없음). 집행 enum 변경 시 web 미러도 함께 갱신해야 하며,
 *   web 측 값은 `channelPermissionCatalog.spec.ts` 가 독립적으로 잠근다.
 */
describe('S104 drift-guard — Fork A 카탈로그↔집행 비트 정합 잠금', () => {
  it('★보안: 카탈로그 멘션 비트는 집행 ACL 비트(ALL_PERMISSIONS)와 겹치지 않는다', () => {
    // 겹치면 멘션 override 설정이 조용히 ACL 권한을 부여하는 권한상승이 된다.
    expect(PERMISSIONS.MENTION_EVERYONE & BigInt(ALL_PERMISSIONS)).toBe(0n);
    expect(PERMISSIONS.MENTION_CHANNEL & BigInt(ALL_PERMISSIONS)).toBe(0n);
  });

  it('멘션 비트 위치 고정(MENTION_EVERYONE=0x80 예약 · MENTION_CHANNEL=0x2000)', () => {
    // 집행 enum 이 0x80 을 비워두고 CHANNEL_OVERRIDE_BITS 가 0x2000 을 하드코딩한 전제.
    expect(PERMISSIONS.MENTION_EVERYONE).toBe(0x80n);
    expect(PERMISSIONS.MENTION_CHANNEL).toBe(0x2000n);
  });

  it('CHANNEL_OVERRIDE_BITS = 집행 ALL_PERMISSIONS | 카탈로그 멘션 2비트(0x21FF)', () => {
    // override 검증이 허용하는 비트 집합 = 집행 ACL 전체 + 멘션 2비트. 어긋나면
    // override 가 정당 비트를 거부하거나 garbage 를 영속한다.
    expect(CHANNEL_OVERRIDE_BITS).toBe(
      BigInt(ALL_PERMISSIONS) | PERMISSIONS.MENTION_EVERYONE | PERMISSIONS.MENTION_CHANNEL,
    );
    expect(CHANNEL_OVERRIDE_BITS).toBe(0x21ffn);
  });

  it('카탈로그 채널-overwrite 플래그(14)는 모두 브리지가 결정적으로 처리(throw 없음)', () => {
    // 새 overwrite 비트가 추가됐는데 CATALOG_TO_ENFORCEMENT 갱신을 잊으면 silently-0
    // 매핑으로 권한이 조용히 누락될 수 있다. 수(14)를 고정해 추가 시 재확인을 강제한다.
    expect(CHANNEL_OVERWRITE_FLAGS.length).toBe(14);
    for (const flag of CHANNEL_OVERWRITE_FLAGS) {
      expect(() => bigintToEnforcementMask(PERMISSIONS[flag])).not.toThrow();
    }
  });

  it('PERMISSIONS 카탈로그 키 수 고정(18 — 새 권한 추가 시 cross-layer 정합 재확인 강제)', () => {
    // 채널 overwrite 14 + 워크스페이스 모더레이션 3(KICK/BAN/TIMEOUT) + ADMINISTRATOR 1.
    // 이 canary 가 깨지면: bridge(CATALOG_TO_ENFORCEMENT) · CHANNEL_OVERRIDE_BITS ·
    // web channelPermissionCatalog 정합을 모두 재확인할 것.
    expect(Object.keys(PERMISSIONS).length).toBe(18);
  });
});
