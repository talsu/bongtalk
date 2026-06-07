import { describe, it, expect, beforeEach, vi } from 'vitest';
import { scanRoleMentions } from './role-mention-scanner';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

/**
 * S88a review F3 (data integrity) — scanRoleMentions 단일 패스 소비 기반
 * longest-match 스캐너. 추출(extractRoleMentions)과 정규화(replaceRoleTokens)가
 * 공유하는 매칭 엔진이므로, 여기서 longest-match 소비·경계·코드영역 시맨틱을
 * 직접 회귀 가드한다.
 */
describe('scanRoleMentions (S88a F3)', () => {
  it('returns [] for no candidates', () => {
    expect(scanRoleMentions('@PM Leads', [])).toEqual([]);
  });

  it('matches a single-word role', () => {
    const matches = scanRoleMentions('hi @PM there', [{ name: 'PM', value: 'r-pm' }]);
    expect(matches.map((m) => m.value)).toEqual(['r-pm']);
  });

  it('consumes the longest match — short prefix is NOT re-matched in the same span', () => {
    // 핵심 회귀: "@PM Leads" 에서 "PM Leads"(긴 이름)만 매칭하고 "PM"(prefix)은
    // 제외해야 한다(짧은 prefix 역할 과다 fanout 방지).
    const matches = scanRoleMentions('@PM Leads ship it', [
      { name: 'PM', value: 'r-pm' },
      { name: 'PM Leads', value: 'r-pmleads' },
    ]);
    expect(matches.map((m) => m.value)).toEqual(['r-pmleads']);
  });

  it('still matches the short role when it appears standalone', () => {
    // "@PM" 단독(뒤에 " Leads" 가 없음)은 짧은 역할로 매칭돼야 한다.
    const matches = scanRoleMentions('@PM ships', [
      { name: 'PM', value: 'r-pm' },
      { name: 'PM Leads', value: 'r-pmleads' },
    ]);
    expect(matches.map((m) => m.value)).toEqual(['r-pm']);
  });

  it('matches multiple distinct roles left-to-right (non-overlapping)', () => {
    const matches = scanRoleMentions('@Devs and @PM Leads now', [
      { name: 'PM Leads', value: 'r-pmleads' },
      { name: 'Devs', value: 'r-devs' },
      { name: 'PM', value: 'r-pm' },
    ]);
    expect(matches.map((m) => m.value)).toEqual(['r-devs', 'r-pmleads']);
  });

  it('respects the leading boundary (no match when @ is preceded by a word char)', () => {
    const matches = scanRoleMentions('mail foo@PM', [{ name: 'PM', value: 'r-pm' }]);
    expect(matches).toEqual([]);
  });

  it('respects the trailing boundary (no partial match into a longer word)', () => {
    const matches = scanRoleMentions('@PMx', [{ name: 'PM', value: 'r-pm' }]);
    expect(matches).toEqual([]);
  });

  it('is case-insensitive', () => {
    const matches = scanRoleMentions('@pm leads go', [{ name: 'PM Leads', value: 'r-pmleads' }]);
    expect(matches.map((m) => m.value)).toEqual(['r-pmleads']);
  });

  it('skips matches inside fenced code blocks', () => {
    const matches = scanRoleMentions('```\n@PM\n```', [{ name: 'PM', value: 'r-pm' }]);
    expect(matches).toEqual([]);
  });

  it('skips matches inside inline code', () => {
    const matches = scanRoleMentions('run `@PM` now', [{ name: 'PM', value: 'r-pm' }]);
    expect(matches).toEqual([]);
  });

  it('returns correct [start,end) spans for replacement', () => {
    const text = 'x @PM Leads y';
    const matches = scanRoleMentions(text, [{ name: 'PM Leads', value: 'r' }]);
    expect(matches).toHaveLength(1);
    expect(text.slice(matches[0].start, matches[0].end)).toBe('@PM Leads');
  });
});
