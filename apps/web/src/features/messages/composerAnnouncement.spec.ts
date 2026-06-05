import { describe, it, expect, beforeEach, vi } from 'vitest';
import { composerAnnouncement } from './composerAnnouncement';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

describe('composerAnnouncement (FR-A11Y-01)', () => {
  it('announces "<명사> N개" for an open mention popup with rows', () => {
    expect(composerAnnouncement('mention', 3)).toBe('멤버 3개');
  });

  it('announces channel count for an open channel popup', () => {
    expect(composerAnnouncement('channel', 1)).toBe('채널 1개');
  });

  it('announces emoji count for an open emoji popup', () => {
    expect(composerAnnouncement('emoji', 5)).toBe('이모지 5개');
  });

  // S78 reviewer FF3: the 0-row branch is reachable — MessageComposer wires
  // useAutocomplete's `emptyTriggerKind` (trigger active, popup closed because
  // rows=0) to composerAnnouncement(kind, 0) so SR users hear "결과 없음".
  it('announces the empty-result message when there are 0 rows', () => {
    expect(composerAnnouncement('mention', 0)).toBe('검색 결과가 없습니다');
    expect(composerAnnouncement('channel', 0)).toBe('검색 결과가 없습니다');
    expect(composerAnnouncement('emoji', 0)).toBe('검색 결과가 없습니다');
  });
});
