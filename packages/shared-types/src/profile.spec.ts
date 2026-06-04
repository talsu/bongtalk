import { describe, expect, it } from 'vitest';
import {
  HANDLE_RE,
  BIO_MAX,
  AVATAR_MAX_BYTES,
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
    it('requires a non-empty key', () => {
      expect(AvatarFinalizeInputSchema.safeParse({ key: 'a/b/c' }).success).toBe(true);
      expect(AvatarFinalizeInputSchema.safeParse({ key: '' }).success).toBe(false);
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
        customStatus: null,
        links: null,
      });
      expect(r.success).toBe(true);
    });
  });
});
