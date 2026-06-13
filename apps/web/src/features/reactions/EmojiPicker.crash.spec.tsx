// @vitest-environment jsdom
/**
 * S42 fix-forward (HIGH + a11y A-4/A-5) — EmojiPicker 회귀고정.
 *
 * 검증 항목:
 *   - (HIGH) 피커가 열린 채 specialTabs(recent/custom) 개수가 변동해도
 *     curatedIndex 범위초과로 크래시하지 않는다. 마지막 큐레이션 탭을 활성화한
 *     상태에서 custom 탭이 사라져 탭 베이스 인덱스가 밀려도 throw 없이 0(첫 탭)으로
 *     리셋돼 재렌더된다.
 *   - (A-4) 퀵 반응 행 컨테이너가 role="group" aria-label="퀵 반응" 이고 각 버튼이
 *     글리프 aria-label 을 갖는다.
 *   - (A-5) 최근 이모지 그리드가 aria-label="최근 사용한 이모지" 를 갖는다.
 *
 * EmojiPicker 는 useState/useEffect/useRef + cn 만 쓰고 provider 의존이 없어
 * @testing-library/react 로 직접 렌더해 검증한다.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { EmojiPicker, EMOJI_CATEGORIES, type CustomEmojiOption } from './EmojiPicker';

afterEach(() => cleanup());

// 072-N0: EmojiPicker 가 usePutUserEmojiPreference(스킨톤 영속화)를 쓰므로 React Query
// provider 가 필요하다. 본 스펙은 picker 의 탭/그리드/a11y 만 검증하므로 PUT 은 실발화하지
// 않지만(스킨톤 스와치 미클릭), 훅 마운트를 위해 가벼운 QueryClient 래퍼로 감싼다. render 의
// wrapper 옵션을 쓰면 rerender 도 같은 provider 로 재래핑되므로 크래시 회귀 테스트가 유지된다.
function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }): JSX.Element => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const customEmojis: CustomEmojiOption[] = [
  { id: 'e1', name: 'partyblob', url: 'https://cdn/p.gif' },
];

describe('EmojiPicker curatedIndex 크래시 회귀 (S42 HIGH)', () => {
  it('custom 탭이 사라져 specialTabs 가 축소돼도 throw 없이 0 으로 리셋된다', () => {
    // 마지막 큐레이션 탭을 활성화한 상태에서, custom 탭이 있다가 사라지는 리렌더를
    // 흉내낸다. specialTabs.length 변동 → useEffect 로 tab 0 리셋 + 인덱싱 전 clamp.
    const { rerender } = render(
      <EmojiPicker onSelect={() => {}} onDismiss={() => {}} customEmojis={customEmojis} />,
      { wrapper: makeWrapper() },
    );
    // custom(0) + 큐레이션 0..N. 마지막 큐레이션 탭을 클릭한다(가장 큰 인덱스).
    const tabs = screen.getAllByRole('button').filter((b) => {
      const labels = EMOJI_CATEGORIES.map((c) => c.label);
      return labels.includes(b.textContent ?? '');
    });
    const lastCurated = tabs[tabs.length - 1];
    lastCurated.click();

    // custom 데이터가 빠지는 리렌더 — stale tab 이 범위를 벗어나도 크래시 없어야 한다.
    expect(() =>
      rerender(<EmojiPicker onSelect={() => {}} onDismiss={() => {}} customEmojis={[]} />),
    ).not.toThrow();
    // 첫 탭(자주 쓰는) 글리프가 렌더된다 = tab 0 으로 리셋됐다.
    expect(screen.getByTestId('emoji-pick-👍')).toBeTruthy();
  });

  it('recent 탭만 있다가 사라져도 크래시 없이 큐레이션 첫 탭으로 떨어진다', () => {
    const { rerender } = render(
      <EmojiPicker onSelect={() => {}} onDismiss={() => {}} recentEmojis={['🔥', '🎉']} />,
      { wrapper: makeWrapper() },
    );
    expect(() =>
      rerender(<EmojiPicker onSelect={() => {}} onDismiss={() => {}} recentEmojis={[]} />),
    ).not.toThrow();
    expect(screen.getByTestId('emoji-pick-👍')).toBeTruthy();
  });
});

describe('EmojiPicker a11y (S42 A-4/A-5)', () => {
  it('A-4: 퀵 반응 행은 role=group aria-label="퀵 반응" + 각 버튼 글리프 aria-label', () => {
    render(<EmojiPicker onSelect={() => {}} onDismiss={() => {}} quickReactions={['👍', '🎉']} />, {
      wrapper: makeWrapper(),
    });
    const group = screen.getByRole('group', { name: '퀵 반응' });
    // 큐레이션 탭에도 같은 글리프가 있으므로 그룹 내부로 스코프해 조회한다.
    expect(within(group).getByRole('button', { name: '👍' })).toBeTruthy();
    expect(within(group).getByRole('button', { name: '🎉' })).toBeTruthy();
  });

  it('A-5: 최근 이모지 그리드는 aria-label="최근 사용한 이모지"', () => {
    render(<EmojiPicker onSelect={() => {}} onDismiss={() => {}} recentEmojis={['🔥', '😀']} />, {
      wrapper: makeWrapper(),
    });
    const grid = screen.getByRole('group', { name: '최근 사용한 이모지' });
    expect(grid.getAttribute('data-testid')).toBe('emoji-picker-recent-grid');
  });

  it('onSelect 은 클릭한 글리프 토큰으로 발화한다(퀵 반응)', () => {
    const onSelect = vi.fn();
    render(<EmojiPicker onSelect={onSelect} onDismiss={() => {}} quickReactions={['👍']} />, {
      wrapper: makeWrapper(),
    });
    screen.getByTestId('emoji-quick-👍').click();
    expect(onSelect).toHaveBeenCalledWith('👍');
  });
});
