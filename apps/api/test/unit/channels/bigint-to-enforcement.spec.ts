import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PERMISSIONS, SYSTEM_ROLE_PERMISSIONS } from '@qufox/shared-types';
import { bigintToEnforcementMask } from '../../../src/channels/permission/bigint-to-enforcement';
import { Permission, ROLE_BASELINE, ALL_PERMISSIONS } from '../../../src/auth/permissions';

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
