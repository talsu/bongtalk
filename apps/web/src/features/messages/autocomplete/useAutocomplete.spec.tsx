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
  slashCommands: [],
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

describe('useAutocomplete — slash 커맨드 (S79 / FR-SC-01·02)', () => {
  const slashSources = () =>
    sources({
      slashCommands: [
        {
          id: 'builtin:shrug',
          name: 'shrug',
          description: '으쓱',
          usageHint: '/shrug [메시지]',
          responseType: 'IN_CHANNEL',
          handlerType: 'BUILTIN',
          isBuiltin: true,
        },
        {
          id: 'builtin:status',
          name: 'status',
          description: '상태',
          usageHint: '/status :이모지: [텍스트]',
          responseType: 'EPHEMERAL',
          handlerType: 'INTERNAL_ACTION',
          isBuiltin: true,
        },
      ],
    });

  it('줄 맨앞 / 입력 시 슬래시 커맨드 listbox 가 열린다', () => {
    const { result } = renderHook(() =>
      useAutocomplete({ text: '/', caret: 1, sources: slashSources() }),
    );
    settle();
    expect(result.current.state.open).toBe(true);
    if (result.current.state.open) {
      expect(result.current.state.kind).toBe('slash');
      expect(result.current.state.rows).toHaveLength(2);
      expect(result.current.state.rows[0]).toMatchObject({ type: 'slash' });
    }
  });

  it('타이핑 시 슬래시 커맨드를 퍼지 필터한다(/sh → shrug)', () => {
    const { result } = renderHook(() =>
      useAutocomplete({ text: '/sh', caret: 3, sources: slashSources() }),
    );
    settle();
    expect(result.current.state.open).toBe(true);
    if (result.current.state.open) {
      expect(result.current.state.rows).toHaveLength(1);
      const row = result.current.state.rows[0];
      expect(row.type === 'slash' && row.command.name).toBe('shrug');
    }
  });

  it('매칭 0건이면 emptyTriggerKind=slash 로 결과 없음을 알린다', () => {
    const { result } = renderHook(() =>
      useAutocomplete({ text: '/zzz', caret: 4, sources: slashSources() }),
    );
    settle();
    expect(result.current.state.open).toBe(false);
    expect(result.current.emptyTriggerKind).toBe('slash');
  });
});
