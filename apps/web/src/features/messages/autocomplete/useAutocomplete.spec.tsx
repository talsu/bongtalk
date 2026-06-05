// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  useAutocomplete,
  AUTOCOMPLETE_DEBOUNCE_MS,
  type AutocompleteSources,
} from './useAutocomplete';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

const sources = (overrides: Partial<AutocompleteSources> = {}): AutocompleteSources => ({
  members: [{ userId: 'u1', username: 'alice' }],
  channels: [{ id: 'c1', name: 'general', topic: null }],
  customEmojis: [],
  online: new Set<string>(),
  recentMembers: [],
  recentEmojis: [],
  role: 'MEMBER',
  ...overrides,
});

/** Advance past the debounce so the trigger/rows recompute. */
function settle(): void {
  act(() => {
    vi.advanceTimersByTime(AUTOCOMPLETE_DEBOUNCE_MS + 1);
  });
}

describe('useAutocomplete — emptyTriggerKind (S78 reviewer FF3)', () => {
  it('opens the popup when a trigger matches rows', () => {
    const { result } = renderHook(() =>
      useAutocomplete({ text: '@al', caret: 3, sources: sources() }),
    );
    settle();
    expect(result.current.state.open).toBe(true);
    expect(result.current.emptyTriggerKind).toBeNull();
  });

  it('reports the empty trigger kind when a trigger is active but yields 0 rows', () => {
    const { result } = renderHook(() =>
      // `@zzz` matches no member → popup stays closed, but the trigger is live.
      useAutocomplete({ text: '@zzz', caret: 4, sources: sources() }),
    );
    settle();
    expect(result.current.state.open).toBe(false);
    expect(result.current.emptyTriggerKind).toBe('mention');
  });

  it('reports null when there is no active trigger', () => {
    const { result } = renderHook(() =>
      useAutocomplete({ text: 'hello world', caret: 11, sources: sources() }),
    );
    settle();
    expect(result.current.emptyTriggerKind).toBeNull();
  });

  it('clears the empty trigger kind once the user dismisses (Esc → close)', () => {
    const { result } = renderHook(() =>
      useAutocomplete({ text: '@zzz', caret: 4, sources: sources() }),
    );
    settle();
    expect(result.current.emptyTriggerKind).toBe('mention');
    act(() => {
      result.current.close();
    });
    expect(result.current.emptyTriggerKind).toBeNull();
  });
});
