// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { announce } from './a11y-announce';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  // 싱글턴 라이브 영역이 테스트 간 누수되지 않도록 body 를 비웁니다.
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function region(): HTMLElement | null {
  return document.querySelector('[data-testid="a11y-live-region"]');
}

describe('a11y-announce — shared live region (FR-A11Y-01)', () => {
  it('lazily mounts a single polite live region with the shared id', () => {
    announce('멤버 3개');
    const el = region();
    expect(el).not.toBeNull();
    // PRD D15: 모든 자동완성이 공유하는 고정 id.
    expect(el?.id).toBe('qf-a11y-announcer');
    expect(el?.getAttribute('aria-live')).toBe('polite');
    // 기존 testid 는 유지(테스트 영향 최소).
    expect(el?.getAttribute('data-testid')).toBe('a11y-live-region');
  });

  it('reuses the same singleton node across calls', () => {
    announce('멤버 3개');
    announce('채널 1개');
    expect(document.querySelectorAll('[data-testid="a11y-live-region"]').length).toBe(1);
  });

  it('writes the message after the reset tick', () => {
    announce('멤버 3개');
    // reset → 빈 문자열 우선.
    expect(region()?.textContent).toBe('');
    vi.advanceTimersByTime(100);
    expect(region()?.textContent).toBe('멤버 3개');
  });

  it('clears the region ~200ms after a close (reset: true) — no re-announce', () => {
    announce('멤버 3개');
    vi.advanceTimersByTime(100);
    expect(region()?.textContent).toBe('멤버 3개');

    // 팝업 닫힘: 빈 문자열로 초기화 예약.
    announce('', { resetDelayMs: 200 });
    // 즉시 비워지지 않고 200ms 후 비워진다.
    vi.advanceTimersByTime(199);
    expect(region()?.textContent).toBe('멤버 3개');
    vi.advanceTimersByTime(1);
    expect(region()?.textContent).toBe('');
  });

  it('race-safe: a new announce cancels a pending reset timer (no clobber)', () => {
    announce('멤버 3개');
    vi.advanceTimersByTime(100);
    expect(region()?.textContent).toBe('멤버 3개');

    // 닫힘으로 200ms 초기화 예약.
    announce('', { resetDelayMs: 200 });
    // 초기화가 끝나기 전(연속 팝업)에 새 공지를 주입.
    vi.advanceTimersByTime(100);
    announce('이모지 5개');
    // 새 공지의 reset(100ms) 후 텍스트가 채워진다.
    vi.advanceTimersByTime(100);
    expect(region()?.textContent).toBe('이모지 5개');

    // 취소된 초기화 타이머가 뒤늦게 발동해 새 공지를 지우면 안 된다.
    vi.advanceTimersByTime(200);
    expect(region()?.textContent).toBe('이모지 5개');
  });
});
