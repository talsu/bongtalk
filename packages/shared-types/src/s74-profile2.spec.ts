import { describe, expect, it } from 'vitest';
import {
  BANNER_MAX_BYTES,
  BANNER_KEY_RE,
  BannerPresignInputSchema,
  BannerFinalizeInputSchema,
  WS_NICKNAME_MAX,
  WS_BIO_MAX,
  WS_AVATAR_KEY_RE,
  UpdateWorkspaceMemberProfileInputSchema,
  WsAvatarPresignInputSchema,
  WsAvatarFinalizeInputSchema,
  WorkspaceMemberProfileViewSchema,
} from './profile';
import {
  resolveMemberDisplayName,
  resolveMemberAvatarUrl,
  MemberWithPresenceSchema,
} from './workspace';
import { SetCustomStatusInputSchema, CustomStatusViewSchema } from './presence';

describe('S74 (D14 / FR-PS-04·05·06) contracts', () => {
  // ── FR-PS-04 배너 ──────────────────────────────────────────────────────────
  describe('Banner presign/finalize', () => {
    it('accepts allowed mime + size within 8MB', () => {
      const r = BannerPresignInputSchema.safeParse({
        contentType: 'image/png',
        sizeBytes: 1024,
      });
      expect(r.success).toBe(true);
    });
    it('rejects size over BANNER_MAX_BYTES', () => {
      expect(
        BannerPresignInputSchema.safeParse({
          contentType: 'image/png',
          sizeBytes: BANNER_MAX_BYTES + 1,
        }).success,
      ).toBe(false);
    });
    it('rejects disallowed mime (gif)', () => {
      expect(
        BannerPresignInputSchema.safeParse({ contentType: 'image/gif', sizeBytes: 10 }).success,
      ).toBe(false);
    });
    it('BANNER_KEY_RE accepts banners/<userId>/<file> and rejects traversal', () => {
      expect(BANNER_KEY_RE.test('banners/u1/abc.png')).toBe(true);
      expect(BANNER_KEY_RE.test('banners/u1/../etc.png')).toBe(false);
      expect(BANNER_KEY_RE.test('avatars/u1/abc.png')).toBe(false);
      expect(BANNER_KEY_RE.test('banners/u1/sub/abc.png')).toBe(false);
    });
    it('BannerFinalizeInputSchema enforces key regex', () => {
      expect(BannerFinalizeInputSchema.safeParse({ key: 'banners/u1/x.webp' }).success).toBe(true);
      expect(BannerFinalizeInputSchema.safeParse({ key: '../escape' }).success).toBe(false);
    });
  });

  // ── FR-PS-05 dndDuringStatus ─────────────────────────────────────────────────
  describe('SetCustomStatusInput dndDuringStatus', () => {
    it('accepts dndDuringStatus boolean', () => {
      expect(
        SetCustomStatusInputSchema.safeParse({ text: 'busy', dndDuringStatus: true }).success,
      ).toBe(true);
    });
    it('rejects non-boolean dndDuringStatus', () => {
      expect(SetCustomStatusInputSchema.safeParse({ dndDuringStatus: 'yes' }).success).toBe(false);
    });
    it('CustomStatusView accepts optional dndDuringStatus', () => {
      expect(
        CustomStatusViewSchema.safeParse({
          text: null,
          emoji: null,
          expiresAt: null,
          dndDuringStatus: true,
        }).success,
      ).toBe(true);
      // 미포함도 허용(optional).
      expect(
        CustomStatusViewSchema.safeParse({ text: null, emoji: null, expiresAt: null }).success,
      ).toBe(true);
    });
  });

  // ── FR-PS-06 워크스페이스별 프로필 ───────────────────────────────────────────
  describe('Workspace member profile', () => {
    it('accepts partial nickname/workspaceBio + nullable', () => {
      expect(UpdateWorkspaceMemberProfileInputSchema.safeParse({ nickname: 'Ace' }).success).toBe(
        true,
      );
      expect(
        UpdateWorkspaceMemberProfileInputSchema.safeParse({ nickname: null, workspaceBio: null })
          .success,
      ).toBe(true);
      expect(UpdateWorkspaceMemberProfileInputSchema.safeParse({}).success).toBe(true);
    });
    it('rejects nickname over WS_NICKNAME_MAX', () => {
      expect(
        UpdateWorkspaceMemberProfileInputSchema.safeParse({
          nickname: 'a'.repeat(WS_NICKNAME_MAX + 1),
        }).success,
      ).toBe(false);
    });
    it('rejects empty-string nickname (min 1; use null to clear)', () => {
      expect(UpdateWorkspaceMemberProfileInputSchema.safeParse({ nickname: '' }).success).toBe(
        false,
      );
    });
    it('rejects workspaceBio over WS_BIO_MAX', () => {
      expect(
        UpdateWorkspaceMemberProfileInputSchema.safeParse({
          workspaceBio: 'a'.repeat(WS_BIO_MAX + 1),
        }).success,
      ).toBe(false);
    });
    it('rejects non-whitelisted keys (strict)', () => {
      expect(UpdateWorkspaceMemberProfileInputSchema.safeParse({ avatarKey: 'x' }).success).toBe(
        false,
      );
    });
    it('WS_AVATAR_KEY_RE accepts ws-avatars/<wsId>/<userId>/<file> and rejects traversal', () => {
      expect(WS_AVATAR_KEY_RE.test('ws-avatars/w1/u1/a.png')).toBe(true);
      expect(WS_AVATAR_KEY_RE.test('ws-avatars/w1/u1/../x.png')).toBe(false);
      expect(WS_AVATAR_KEY_RE.test('ws-avatars/w1/a.png')).toBe(false);
      expect(WS_AVATAR_KEY_RE.test('avatars/u1/a.png')).toBe(false);
    });
    it('WsAvatarPresign/Finalize input schemas validate', () => {
      expect(
        WsAvatarPresignInputSchema.safeParse({ contentType: 'image/jpeg', sizeBytes: 100 }).success,
      ).toBe(true);
      expect(WsAvatarFinalizeInputSchema.safeParse({ key: 'ws-avatars/w1/u1/x.jpg' }).success).toBe(
        true,
      );
      expect(WsAvatarFinalizeInputSchema.safeParse({ key: 'avatars/u1/x.jpg' }).success).toBe(
        false,
      );
    });
    it('WorkspaceMemberProfileViewSchema parses an all-null (no-override) view', () => {
      expect(
        WorkspaceMemberProfileViewSchema.safeParse({
          workspaceId: '00000000-0000-0000-0000-000000000001',
          userId: '00000000-0000-0000-0000-000000000002',
          nickname: null,
          avatarUrl: null,
          workspaceBio: null,
        }).success,
      ).toBe(true);
    });
  });

  // ── 표시 우선순위 해석(멤버목록 전파 · S73 carryover) ─────────────────────────
  describe('resolveMemberDisplayName / resolveMemberAvatarUrl priority', () => {
    it('display: wsNickname > displayName > username', () => {
      expect(
        resolveMemberDisplayName({ username: 'u', displayName: 'Disp', wsNickname: 'Nick' }),
      ).toBe('Nick');
      expect(
        resolveMemberDisplayName({ username: 'u', displayName: 'Disp', wsNickname: null }),
      ).toBe('Disp');
      expect(resolveMemberDisplayName({ username: 'u' })).toBe('u');
    });
    it('avatar: wsAvatarUrl > avatarUrl > null', () => {
      expect(resolveMemberAvatarUrl({ avatarUrl: 'g', wsAvatarUrl: 'w' })).toBe('w');
      expect(resolveMemberAvatarUrl({ avatarUrl: 'g', wsAvatarUrl: null })).toBe('g');
      expect(resolveMemberAvatarUrl({})).toBeNull();
    });
    it('MemberWithPresenceSchema accepts the new ws override fields', () => {
      const r = MemberWithPresenceSchema.safeParse({
        userId: '00000000-0000-0000-0000-000000000001',
        workspaceId: '00000000-0000-0000-0000-000000000002',
        role: 'MEMBER',
        joinedAt: '2025-01-01T00:00:00.000Z',
        user: {
          id: '00000000-0000-0000-0000-000000000001',
          username: 'alice',
          email: 'a@b.com',
          displayName: 'Alice',
          avatarUrl: null,
          wsNickname: 'Ace',
          wsAvatarUrl: 'https://x/avatar.png',
        },
        status: 'online',
        lastSeenAt: null,
      });
      expect(r.success).toBe(true);
    });
  });
});
