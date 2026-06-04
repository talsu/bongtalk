import { describe, expect, it } from 'vitest';
import {
  HANDLE_RE,
  BIO_MAX,
  AVATAR_MAX_BYTES,
  AVATAR_KEY_RE,
  TIMEZONE_RE,
  ProfileViewSchema,
  UpdateProfileInputSchema,
  AvatarPresignInputSchema,
  AvatarFinalizeInputSchema,
} from './profile';

describe('S73 profile contract', () => {
  describe('HANDLE_RE', () => {
    it('accepts lowercase/digit/underscore/dot 3-32', () => {
      expect(HANDLE_RE.test('abc')).toBe(true);
      expect(HANDLE_RE.test('a_b.c123')).toBe(true);
      expect(HANDLE_RE.test('a'.repeat(32))).toBe(true);
    });
    it('rejects too short / too long / uppercase / invalid chars', () => {
      expect(HANDLE_RE.test('ab')).toBe(false);
      expect(HANDLE_RE.test('a'.repeat(33))).toBe(false);
      expect(HANDLE_RE.test('ABC')).toBe(false);
      expect(HANDLE_RE.test('with space')).toBe(false);
      expect(HANDLE_RE.test('emoji😀x')).toBe(false);
      expect(HANDLE_RE.test('dash-not-allowed')).toBe(false);
    });
  });

  describe('UpdateProfileInputSchema', () => {
    it('accepts empty object (no-op partial)', () => {
      expect(UpdateProfileInputSchema.safeParse({}).success).toBe(true);
    });
    it('accepts a valid handle + nullable fields', () => {
      const r = UpdateProfileInputSchema.safeParse({
        handle: 'good.handle_1',
        displayName: 'Alice',
        fullName: null,
        bio: 'hi',
        pronouns: null,
        title: null,
        timezone: 'Asia/Seoul',
      });
      expect(r.success).toBe(true);
    });
    it('rejects an invalid handle', () => {
      expect(UpdateProfileInputSchema.safeParse({ handle: 'Bad Handle' }).success).toBe(false);
    });
    it('rejects displayName over 80 and bio over BIO_MAX', () => {
      expect(UpdateProfileInputSchema.safeParse({ displayName: 'x'.repeat(81) }).success).toBe(
        false,
      );
      expect(UpdateProfileInputSchema.safeParse({ bio: 'x'.repeat(BIO_MAX + 1) }).success).toBe(
        false,
      );
    });
    it('rejects an empty displayName (min 1)', () => {
      expect(UpdateProfileInputSchema.safeParse({ displayName: '' }).success).toBe(false);
    });
    it('rejects unknown keys (strict)', () => {
      expect(UpdateProfileInputSchema.safeParse({ avatarUrl: 'x' }).success).toBe(false);
    });
    it('accepts a valid IANA timezone + empty string + null, rejects garbage', () => {
      expect(UpdateProfileInputSchema.safeParse({ timezone: 'Asia/Seoul' }).success).toBe(true);
      expect(
        UpdateProfileInputSchema.safeParse({ timezone: 'America/Argentina/Buenos_Aires' }).success,
      ).toBe(true);
      expect(UpdateProfileInputSchema.safeParse({ timezone: '' }).success).toBe(true);
      expect(UpdateProfileInputSchema.safeParse({ timezone: null }).success).toBe(true);
      expect(UpdateProfileInputSchema.safeParse({ timezone: 'not a tz' }).success).toBe(false);
      expect(UpdateProfileInputSchema.safeParse({ timezone: 'Seoul' }).success).toBe(false);
    });
  });

  describe('TIMEZONE_RE', () => {
    it('accepts Area/Location forms, rejects bare or injected strings', () => {
      expect(TIMEZONE_RE.test('Asia/Seoul')).toBe(true);
      expect(TIMEZONE_RE.test('Etc/GMT+9')).toBe(true);
      expect(TIMEZONE_RE.test('America/Argentina/Buenos_Aires')).toBe(true);
      expect(TIMEZONE_RE.test('UTC')).toBe(false);
      expect(TIMEZONE_RE.test('Asia/Seoul; DROP TABLE')).toBe(false);
    });
  });

  describe('AVATAR_KEY_RE (security HIGH#1 — traversal)', () => {
    it('accepts a well-formed 3-segment avatar key', () => {
      expect(AVATAR_KEY_RE.test('avatars/u1/abc.png')).toBe(true);
      expect(AVATAR_KEY_RE.test('avatars/u1/a-b_c.1.webp')).toBe(true);
    });
    it('rejects traversal / wrong-prefix / extra-segment keys', () => {
      expect(AVATAR_KEY_RE.test('avatars/u1/../u2/evil.png')).toBe(false);
      expect(AVATAR_KEY_RE.test('avatars/../etc/passwd')).toBe(false);
      expect(AVATAR_KEY_RE.test('other/u1/x.png')).toBe(false);
      expect(AVATAR_KEY_RE.test('avatars/u1/sub/x.png')).toBe(false);
    });
  });

  describe('AvatarPresignInputSchema', () => {
    it('accepts an allowed mime under the size cap', () => {
      expect(
        AvatarPresignInputSchema.safeParse({ contentType: 'image/png', sizeBytes: 1024 }).success,
      ).toBe(true);
    });
    it('rejects a disallowed mime', () => {
      expect(
        AvatarPresignInputSchema.safeParse({ contentType: 'image/gif', sizeBytes: 1024 }).success,
      ).toBe(false);
    });
    it('rejects oversize', () => {
      expect(
        AvatarPresignInputSchema.safeParse({
          contentType: 'image/webp',
          sizeBytes: AVATAR_MAX_BYTES + 1,
        }).success,
      ).toBe(false);
    });
  });

  describe('AvatarFinalizeInputSchema', () => {
    it('accepts a well-formed avatar key, rejects empty / traversal keys', () => {
      expect(AvatarFinalizeInputSchema.safeParse({ key: 'avatars/u1/x.png' }).success).toBe(true);
      expect(AvatarFinalizeInputSchema.safeParse({ key: '' }).success).toBe(false);
      expect(AvatarFinalizeInputSchema.safeParse({ key: 'a/b/c' }).success).toBe(false);
      expect(
        AvatarFinalizeInputSchema.safeParse({ key: 'avatars/u1/../u2/evil.png' }).success,
      ).toBe(false);
    });
  });

  describe('ProfileViewSchema', () => {
    it('parses a full view with nullable handle/avatar', () => {
      const r = ProfileViewSchema.safeParse({
        id: '00000000-0000-0000-0000-000000000001',
        email: 'a@b.com',
        username: 'alice',
        handle: 'alice',
        displayName: null,
        fullName: null,
        pronouns: null,
        title: null,
        timezone: null,
        bio: null,
        handleChangedAt: null,
        avatarUrl: null,
        // S74 (FR-PS-04/05): 배너 URL + DND 옵션 필드 추가.
        bannerUrl: null,
        dndDuringStatus: false,
        customStatus: null,
        links: null,
      });
      expect(r.success).toBe(true);
    });
    it('rejects a view missing the S74 bannerUrl/dndDuringStatus fields', () => {
      const r = ProfileViewSchema.safeParse({
        id: '00000000-0000-0000-0000-000000000001',
        email: 'a@b.com',
        username: 'alice',
        handle: 'alice',
        displayName: null,
        fullName: null,
        pronouns: null,
        title: null,
        timezone: null,
        bio: null,
        handleChangedAt: null,
        avatarUrl: null,
        customStatus: null,
        links: null,
      });
      expect(r.success).toBe(false);
    });
  });
});
