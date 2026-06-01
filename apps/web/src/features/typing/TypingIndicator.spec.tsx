// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { TypingIndicator } from './TypingIndicator';
import { useTypingStore } from './useTypingStore';

/**
 * S32 (a11y A-01/A-02 · WCAG 4.1.3): TypingIndicator 가 스크린리더용 라이브
 * 리전(role=status, aria-live=polite, aria-atomic=true)을 노출하는지, 그리고
 * 타이퍼가 없으면 렌더 자체가 없는지(null)를 jsdom 으로 검증한다. 점 장식은
 * aria-hidden 으로 SR 에서 숨겨져야 한다.
 */

const CH = 'channel-1';
const VIEWER = 'viewer-1';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  // 매 테스트마다 store 를 비워 채널 상태가 새지 않게 한다.
  act(() => {
    useTypingStore.getState().clearAll();
  });
});

afterEach(() => {
  cleanup();
  act(() => {
    useTypingStore.getState().clearAll();
  });
});

function names(...pairs: Array<[string, string]>): Map<string, string> {
  return new Map(pairs);
}

describe('TypingIndicator 라이브 리전 (a11y A-01/A-02)', () => {
  it('타이핑 중인 다른 사용자가 있으면 polite 라이브 리전을 노출', () => {
    act(() => {
      useTypingStore.getState().set(CH, ['u1']);
    });
    render(
      <TypingIndicator channelId={CH} viewerId={VIEWER} nameByUserId={names(['u1', '앨리스'])} />,
    );
    const region = screen.getByTestId(`typing-indicator-${CH}`);
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('aria-atomic')).toBe('true');
    // 라벨에 입력 중 문구가 포함된다.
    expect(region.textContent).toContain('앨리스 님이 입력 중…');
  });

  it('장식용 점은 aria-hidden 으로 SR 에서 숨겨진다', () => {
    act(() => {
      useTypingStore.getState().set(CH, ['u1']);
    });
    const { container } = render(
      <TypingIndicator channelId={CH} viewerId={VIEWER} nameByUserId={names(['u1', '앨리스'])} />,
    );
    const dots = container.querySelector('.qf-typing__dots');
    expect(dots).not.toBeNull();
    // React 의 aria-hidden(boolean) 은 DOM 에 빈 문자열 또는 "true" 로 직렬화된다.
    expect(dots?.hasAttribute('aria-hidden')).toBe(true);
  });

  it('타이퍼가 viewer 본인뿐이면 아무것도 렌더하지 않는다(null)', () => {
    act(() => {
      useTypingStore.getState().set(CH, [VIEWER]);
    });
    render(
      <TypingIndicator channelId={CH} viewerId={VIEWER} nameByUserId={names([VIEWER, '나'])} />,
    );
    expect(screen.queryByTestId(`typing-indicator-${CH}`)).toBeNull();
  });

  it('DS 클래스(qf-typing)는 유지된다(속성만 추가, 클래스 무변경)', () => {
    act(() => {
      useTypingStore.getState().set(CH, ['u1']);
    });
    render(
      <TypingIndicator channelId={CH} viewerId={VIEWER} nameByUserId={names(['u1', '앨리스'])} />,
    );
    expect(screen.getByTestId(`typing-indicator-${CH}`).classList.contains('qf-typing')).toBe(true);
  });
});
