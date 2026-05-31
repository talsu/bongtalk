import { describe, it, expect, beforeEach, vi } from 'vitest';
import { detectTrigger } from './detectTrigger';
import { insertToken } from './insertToken';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

/**
 * S18 리뷰 BLOCKER 회귀: applyAutocompleteRow 가 debounce 스냅샷 기준 offset
 * (acState.trigger)으로 live draft 를 치환하면, 빠르게 타이핑한 뒤 debounce 가
 * 끝나기 전에 삽입하면 stale offset 으로 텍스트가 깨진다. 컴포저는 삽입 직전에
 * live draft/caret 으로 detectTrigger 를 동기 재실행해 범위를 다시 구한다.
 *
 * 컴포넌트 전체를 렌더하지 않고, 그 합성(재계산 → 치환)을 순수 함수 레벨에서
 * 검증한다 — 동일한 detectTrigger + insertToken 을 컴포저가 호출하기 때문이다.
 */
describe('applyAutocompleteRow live-trigger 재계산 (S18 BLOCKER)', () => {
  it('stale debounced offset 으로 치환하면 텍스트가 깨진다(회귀 재현)', () => {
    // 사용자가 "@al" 까지 친 시점의 debounced 스냅샷.
    const staleTrigger = detectTrigger('@al', 3);
    expect(staleTrigger).not.toBeNull();
    // debounce 전에 "@alic" 까지 더 쳤다(live draft).
    const liveDraft = '@alic';
    // stale offset(end=3)으로 치환하면 "ic" 가 남아 깨진다.
    const broken = insertToken({
      text: liveDraft,
      start: staleTrigger!.start,
      end: staleTrigger!.end,
      token: '@alice',
    });
    expect(broken.text).toBe('@alice ic');
  });

  it('live draft/caret 으로 detectTrigger 재실행하면 범위가 정확하다', () => {
    const liveDraft = '@alic';
    const liveCaret = 5;
    const liveTrigger = detectTrigger(liveDraft, liveCaret);
    expect(liveTrigger).toEqual({ kind: 'mention', query: 'alic', start: 0, end: 5 });
    const fixed = insertToken({
      text: liveDraft,
      start: liveTrigger!.start,
      end: liveTrigger!.end,
      token: '@alice',
    });
    expect(fixed.text).toBe('@alice ');
    expect(fixed.caret).toBe('@alice '.length);
  });

  it('live draft 에서 더 이상 트리거가 매치하지 않으면 null → bail', () => {
    // 사용자가 토큰 뒤에 공백을 쳐 토큰이 닫혔다 → 트리거 없음.
    const liveTrigger = detectTrigger('@alice ', 7);
    expect(liveTrigger).toBeNull();
  });

  it('preserves leading text and recomputes mid-string trigger ranges', () => {
    const liveDraft = 'hey @bo';
    const liveCaret = 7;
    const liveTrigger = detectTrigger(liveDraft, liveCaret);
    expect(liveTrigger).toEqual({ kind: 'mention', query: 'bo', start: 4, end: 7 });
    const fixed = insertToken({
      text: liveDraft,
      start: liveTrigger!.start,
      end: liveTrigger!.end,
      token: '@bob',
    });
    expect(fixed.text).toBe('hey @bob ');
  });
});
