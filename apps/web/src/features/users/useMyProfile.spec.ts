import { describe, it, expect } from 'vitest';
import type { MyProfile, ProfileLink } from './useMyProfile';

/**
 * S73 (D14 / FR-PS-01·02·03): MyProfile contract 검증(type / shape).
 *
 * Hook 의 React Query 통합은 backend int 테스트가 cover. 본 spec 은 type-level shape
 * 만 단위 검증한다(D14 전역 신원 필드 + 아바타 + task-047 links carryover 포함).
 */

const FULL: MyProfile = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'me@e.com',
  username: 'me',
  handle: 'me',
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
};

describe('MyProfile contract (S73 D14)', () => {
  it('holds the global identity fields (handle/displayName/...) + avatarUrl + carryover', () => {
    expect(FULL.handle).toBe('me');
    expect(FULL.avatarUrl).toBeNull();
    expect(FULL.bio).toBeNull();
    expect(FULL.links).toBeNull();
    expect(FULL.handleChangedAt).toBeNull();
  });

  it('ProfileLink has a required url + optional label', () => {
    const a: ProfileLink = { url: 'https://example.com' };
    const b: ProfileLink = { url: 'https://example.com', label: 'home' };
    expect(a.url).toBe('https://example.com');
    expect(b.label).toBe('home');
  });

  it('links is an array or null', () => {
    const filled: MyProfile = {
      ...FULL,
      links: [{ url: 'https://a.com' }, { url: 'https://b.com', label: 'B' }],
    };
    expect(FULL.links).toBeNull();
    expect(filled.links).toHaveLength(2);
  });
});
