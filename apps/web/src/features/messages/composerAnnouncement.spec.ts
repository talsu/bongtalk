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

  it('announces slash command count for an open slash popup', () => {
    expect(composerAnnouncement('slash', 2)).toBe('슬래시 커맨드 2개');
  });

  // S78 reviewer FF3: the 0-row branch is reachable — MessageComposer wires
  // useAutocomplete's `emptyTriggerKind` (trigger active, popup closed because
  // rows=0) to composerAnnouncement(kind, 0) so SR users hear "결과 없음".
  //
  // S79 fix-forward (a11y N-01): the empty-result message is now kind-scoped so
  // SR users know which trigger had no matches.
  it('announces a kind-scoped empty-result message when there are 0 rows', () => {
    expect(composerAnnouncement('mention', 0)).toBe('멤버 검색 결과가 없습니다');
    expect(composerAnnouncement('channel', 0)).toBe('채널 검색 결과가 없습니다');
    expect(composerAnnouncement('emoji', 0)).toBe('이모지 검색 결과가 없습니다');
    expect(composerAnnouncement('slash', 0)).toBe('슬래시 커맨드 검색 결과가 없습니다');
  });
});
