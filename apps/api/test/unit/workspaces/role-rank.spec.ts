import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ROLE_RANK, RESERVED_SLUGS, SlugSchema } from '@qufox/shared-types';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('workspace role rank', () => {
  it('ranks OWNER > ADMIN > MEMBER', () => {
    expect(ROLE_RANK.OWNER).toBeGreaterThan(ROLE_RANK.ADMIN);
    expect(ROLE_RANK.ADMIN).toBeGreaterThan(ROLE_RANK.MEMBER);
  });
});

describe('slug validation', () => {
  it('accepts kebab-case with alphanumerics', () => {
    expect(SlugSchema.parse('acme')).toBe('acme');
    expect(SlugSchema.parse('acme-2')).toBe('acme-2');
    expect(SlugSchema.parse('ac-me-42')).toBe('ac-me-42');
  });

  it('rejects uppercase / symbols / edges', () => {
    expect(() => SlugSchema.parse('AB')).toThrow();
    expect(() => SlugSchema.parse('-bad')).toThrow();
    expect(() => SlugSchema.parse('bad-')).toThrow();
    expect(() => SlugSchema.parse('bad_slug')).toThrow();
    expect(() => SlugSchema.parse('ab')).toThrow(); // < 3
  });

  it('has reserved list overlapping common system paths', () => {
    for (const needed of ['api', 'auth', 'admin', 'workspaces', 'invites']) {
      expect(RESERVED_SLUGS.has(needed)).toBe(true);
    }
  });
});
