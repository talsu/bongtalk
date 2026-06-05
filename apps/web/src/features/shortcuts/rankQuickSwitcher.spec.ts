import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rankQuickSwitcher, type RankableQsItem } from './rankQuickSwitcher';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const ch = (label: string, extra: Partial<RankableQsItem> = {}): RankableQsItem => ({
  id: `ch:${label}`,
  kind: 'channel',
  label,
  ...extra,
});

const mem = (label: string, extra: Partial<RankableQsItem> = {}): RankableQsItem => ({
  id: `mem:${label}`,
  kind: 'member',
  label,
  ...extra,
});

describe('rankQuickSwitcher (FR-KS-01) — 퍼지 랭킹', () => {
  it('keeps prefix matches above pure substring matches', () => {
    const out = rankQuickSwitcher({
      items: [ch('random'), ch('announcements'), ch('an-team')],
      query: 'an',
      recent: [],
      limit: 10,
    });
    // prefix: announcements, an-team (둘 다 'an' 으로 시작) → 알파벳; random 은 substring.
    expect(out.map((x) => x.label)).toEqual(['an-team', 'announcements', 'random']);
  });

  it('excludes items with no match', () => {
    const out = rankQuickSwitcher({
      items: [ch('general'), ch('random'), ch('design')],
      query: 'zzz',
      recent: [],
      limit: 10,
    });
    expect(out).toHaveLength(0);
  });

  it('ranks recent items highest at equal prefix quality', () => {
    const out = rankQuickSwitcher({
      items: [ch('alpha'), ch('amber'), ch('apex')],
      query: 'a',
      recent: ['ch:apex'],
      limit: 10,
    });
    expect(out[0].label).toBe('apex');
  });

  it('boosts unread/online items at equal recency', () => {
    const out = rankQuickSwitcher({
      items: [ch('alpha'), ch('amber', { boost: 1 })],
      query: 'a',
      recent: [],
      limit: 10,
    });
    expect(out[0].label).toBe('amber');
  });

  it('prefers earlier substring match position', () => {
    const out = rankQuickSwitcher({
      items: [ch('xxbeta'), ch('xbeta')],
      query: 'beta',
      recent: [],
      limit: 10,
    });
    expect(out.map((x) => x.label)).toEqual(['xbeta', 'xxbeta']);
  });

  it('matches against keywords as well as the label (member handle)', () => {
    const out = rankQuickSwitcher({
      items: [mem('김철수', { keywords: ['chulsoo'] }), mem('이영희', { keywords: ['younghee'] })],
      query: 'chul',
      recent: [],
      limit: 10,
    });
    expect(out.map((x) => x.label)).toEqual(['김철수']);
  });

  it('returns everything (capped) for an empty query, recent first', () => {
    const out = rankQuickSwitcher({
      items: [ch('a'), ch('b'), ch('c')],
      query: '',
      recent: ['ch:c'],
      limit: 2,
    });
    expect(out).toHaveLength(2);
    expect(out[0].label).toBe('c');
  });

  it('is case-insensitive', () => {
    const out = rankQuickSwitcher({
      items: [ch('General')],
      query: 'gen',
      recent: [],
      limit: 10,
    });
    expect(out.map((x) => x.label)).toEqual(['General']);
  });
});
