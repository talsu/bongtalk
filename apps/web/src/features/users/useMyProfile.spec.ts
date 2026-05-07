import { describe, it, expect } from 'vitest';
import type { MyProfile, ProfileLink } from './useMyProfile';

/**
 * task-047 iter4 (M3): MyProfile 의 contract 검증 (type / shape).
 *
 * Hook 자체의 React Query 통합은 backend integration 테스트가 cover.
 * 본 spec 은 type-level shape 만 단위 검증.
 */

describe('MyProfile contract (task-047 M3)', () => {
  it('MyProfile 타입은 id/username/email/customStatus/bio/links 모두 보유', () => {
    const sample: MyProfile = {
      id: 'u1',
      username: 'me',
      email: 'me@e.com',
      customStatus: null,
      bio: null,
      links: null,
    };
    expect(sample.id).toBe('u1');
    expect(sample.bio).toBeNull();
    expect(sample.links).toBeNull();
  });

  it('ProfileLink 는 url 필수 + label 옵션', () => {
    const a: ProfileLink = { url: 'https://example.com' };
    const b: ProfileLink = { url: 'https://example.com', label: 'home' };
    expect(a.url).toBe('https://example.com');
    expect(b.label).toBe('home');
  });

  it('links 는 array 또는 null', () => {
    const empty: MyProfile = {
      id: 'u',
      username: 'x',
      email: 'x@x',
      customStatus: null,
      bio: null,
      links: null,
    };
    const filled: MyProfile = {
      id: 'u',
      username: 'x',
      email: 'x@x',
      customStatus: null,
      bio: null,
      links: [{ url: 'https://a.com' }, { url: 'https://b.com', label: 'B' }],
    };
    expect(empty.links).toBeNull();
    expect(filled.links).toHaveLength(2);
  });
});
