import { describe, it, expect } from 'vitest';
import { searchPrefillQuery } from './searchPrefill';

/**
 * S31 (reviewer NIT5/DM): Ctrl/Cmd+F 검색 패널 프리필 결정. 텍스트성 채널만
 * in:#name 으로 프리필하고, DM/그룹 DM/미해결 채널은 빈 쿼리로 둔다.
 */
describe('searchPrefillQuery (S31 NIT5/DM)', () => {
  it('TEXT 채널은 in:#name 프리필', () => {
    expect(searchPrefillQuery('general', 'TEXT')).toBe('in:#general ');
  });

  it('ANNOUNCEMENT 채널도 in:#name 프리필', () => {
    expect(searchPrefillQuery('notice', 'ANNOUNCEMENT')).toBe('in:#notice ');
  });

  it('VOICE 채널은 빈 쿼리(in: 부적합)', () => {
    expect(searchPrefillQuery('lounge', 'VOICE')).toBe('');
  });

  it('FORUM 채널은 빈 쿼리', () => {
    expect(searchPrefillQuery('q-and-a', 'FORUM')).toBe('');
  });

  it('타입 미상(undefined — 미해결/DM)이면 빈 쿼리', () => {
    expect(searchPrefillQuery('alice', undefined)).toBe('');
  });
});
