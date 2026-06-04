import { describe, expect, it } from 'vitest';
import {
  MemberFullProfileViewSchema,
  MemberFullProfileRoleSchema,
  FullProfilePresenceStatusSchema,
  computeEffectiveProfile,
} from './profile';

/**
 * S75 (D14 / FR-PS-07·08) — 타 멤버 full-profile 컨트랙트 + effective* 표시 우선순위.
 * effective* 는 서버가 계산해 내려보내는 단일 출처(FE 가 재계산하지 않음)이므로,
 * resolveMemberDisplayName/resolveMemberAvatarUrl 와 일관된 우선순위를 고정한다.
 */
describe('S75 full-profile contracts (FR-PS-07/08)', () => {
  const UUID_A = '00000000-0000-0000-0000-000000000001';
  const UUID_B = '00000000-0000-0000-0000-000000000002';

  function fullView(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      userId: UUID_A,
      username: 'alice',
      handle: 'alice',
      displayName: 'Alice',
      fullName: null,
      pronouns: null,
      title: null,
      timezone: 'Asia/Seoul',
      bio: 'global bio',
      avatarUrl: null,
      bannerUrl: null,
      wsNickname: null,
      wsAvatarUrl: null,
      workspaceBio: null,
      presenceStatus: 'online',
      customStatus: null,
      customStatusEmoji: null,
      systemRole: 'MEMBER',
      customRoles: [],
      effectiveDisplayName: 'Alice',
      effectiveAvatarUrl: null,
      effectiveBio: 'global bio',
      ...over,
    };
  }

  it('parses a full view with system + custom roles', () => {
    const r = MemberFullProfileViewSchema.safeParse(
      fullView({
        customRoles: [{ id: UUID_B, name: 'Builder', color: '#5865F2' }],
      }),
    );
    expect(r.success).toBe(true);
  });

  it('rejects an invalid presence status', () => {
    expect(
      MemberFullProfileViewSchema.safeParse(fullView({ presenceStatus: 'busy' })).success,
    ).toBe(false);
  });

  it('FullProfilePresenceStatus is the masked four-state set', () => {
    expect(FullProfilePresenceStatusSchema.options).toEqual(['online', 'idle', 'dnd', 'offline']);
  });

  it('MemberFullProfileRole accepts a null color', () => {
    expect(
      MemberFullProfileRoleSchema.safeParse({ id: UUID_B, name: 'r', color: null }).success,
    ).toBe(true);
  });

  describe('computeEffectiveProfile priority', () => {
    it('displayName: wsNickname > displayName > username', () => {
      expect(
        computeEffectiveProfile({
          username: 'u',
          displayName: 'Disp',
          wsNickname: 'Nick',
          avatarUrl: null,
          wsAvatarUrl: null,
          bio: null,
          workspaceBio: null,
        }).effectiveDisplayName,
      ).toBe('Nick');
      expect(
        computeEffectiveProfile({
          username: 'u',
          displayName: 'Disp',
          wsNickname: null,
          avatarUrl: null,
          wsAvatarUrl: null,
          bio: null,
          workspaceBio: null,
        }).effectiveDisplayName,
      ).toBe('Disp');
      expect(
        computeEffectiveProfile({
          username: 'u',
          displayName: null,
          wsNickname: null,
          avatarUrl: null,
          wsAvatarUrl: null,
          bio: null,
          workspaceBio: null,
        }).effectiveDisplayName,
      ).toBe('u');
    });

    it('avatar: wsAvatarUrl > avatarUrl > null', () => {
      expect(
        computeEffectiveProfile({
          username: 'u',
          displayName: null,
          wsNickname: null,
          avatarUrl: 'g',
          wsAvatarUrl: 'w',
          bio: null,
          workspaceBio: null,
        }).effectiveAvatarUrl,
      ).toBe('w');
      expect(
        computeEffectiveProfile({
          username: 'u',
          displayName: null,
          wsNickname: null,
          avatarUrl: 'g',
          wsAvatarUrl: null,
          bio: null,
          workspaceBio: null,
        }).effectiveAvatarUrl,
      ).toBe('g');
      expect(
        computeEffectiveProfile({
          username: 'u',
          displayName: null,
          wsNickname: null,
          avatarUrl: null,
          wsAvatarUrl: null,
          bio: null,
          workspaceBio: null,
        }).effectiveAvatarUrl,
      ).toBeNull();
    });

    it('bio: workspaceBio > bio > null', () => {
      expect(
        computeEffectiveProfile({
          username: 'u',
          displayName: null,
          wsNickname: null,
          avatarUrl: null,
          wsAvatarUrl: null,
          bio: 'global',
          workspaceBio: 'ws',
        }).effectiveBio,
      ).toBe('ws');
      expect(
        computeEffectiveProfile({
          username: 'u',
          displayName: null,
          wsNickname: null,
          avatarUrl: null,
          wsAvatarUrl: null,
          bio: 'global',
          workspaceBio: null,
        }).effectiveBio,
      ).toBe('global');
      expect(
        computeEffectiveProfile({
          username: 'u',
          displayName: null,
          wsNickname: null,
          avatarUrl: null,
          wsAvatarUrl: null,
          bio: null,
          workspaceBio: null,
        }).effectiveBio,
      ).toBeNull();
    });
  });
});
