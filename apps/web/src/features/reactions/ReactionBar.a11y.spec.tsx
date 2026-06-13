// @vitest-environment jsdom
/**
 * S39 (SHOULD 4) — ReactionBar 접근성 회귀고정.
 *
 * 검증 항목:
 *   - 반응 칩 aria-label 이 완결문(`{emoji} 반응, {N}명, {내가 반응함|반응 안 함}`)이고
 *     aria-pressed 가 byMe 와 일치한다.
 *   - 칩 내부의 시각용 emoji/카운트 <span> 은 aria-hidden 으로 가려 이중 읽기를 막는다.
 *   - "+" 추가 버튼은 aria-haspopup="dialog" 를 갖는다.
 *   - 카운트 변경 SR 영역(aria-live="polite" aria-atomic)이 현재 집계를 한 줄로 싣는다.
 *
 * ReactionBar 는 useState/useCallback 만 쓰고(닫힌 picker 는 렌더 안 됨) provider
 * 의존이 없으므로 renderToStaticMarkup 으로 정적 검증한다.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { render as rtlRender, screen, cleanup } from '@testing-library/react';
import type { ReactionSummary } from '@qufox/shared-types';
import { ReactionBar } from './ReactionBar';
import { TooltipProvider } from '../../design-system/primitives';

// 072-N0: ReactionBar 칩이 DS Tooltip(Radix) 을 쓰므로 TooltipProvider 가 필요하다.
// 실앱은 App.tsx 루트에 Provider 가 있어 정상이며, 이 단위 스펙만 bare 렌더라
// 래퍼를 주입한다(런타임 동작 무변경 — 테스트 하니스 정합).
const render = (ui: Parameters<typeof rtlRender>[0]): ReturnType<typeof rtlRender> =>
  rtlRender(ui, { wrapper: TooltipProvider });

const reactions: ReactionSummary[] = [
  { emoji: '👍', count: 3, byMe: true },
  { emoji: '🎉', count: 1, byMe: false },
];

afterEach(() => cleanup());

describe('ReactionBar a11y (S39 SHOULD 4)', () => {
  it('칩 aria-label 은 완결문이고 aria-pressed 가 byMe 와 일치한다', () => {
    render(<ReactionBar reactions={reactions} onToggle={() => {}} />);
    const mine = screen.getByRole('button', { name: '👍 반응, 3명, 내가 반응함' });
    expect(mine.getAttribute('aria-pressed')).toBe('true');
    const notMine = screen.getByRole('button', { name: '🎉 반응, 1명, 반응 안 함' });
    expect(notMine.getAttribute('aria-pressed')).toBe('false');
  });

  it('칩 내부 emoji/카운트 span 은 aria-hidden 으로 이중 읽기를 막는다', () => {
    const { container } = render(<ReactionBar reactions={reactions} onToggle={() => {}} />);
    const chip = container.querySelector('[data-testid="reaction-👍"]');
    expect(chip).not.toBeNull();
    const hiddenSpans = chip?.querySelectorAll('span[aria-hidden="true"]');
    // 이모지 + 카운트 두 span 모두 aria-hidden.
    expect(hiddenSpans?.length).toBe(2);
  });

  it('"+" 추가 버튼은 aria-haspopup="dialog" 를 갖는다', () => {
    render(<ReactionBar reactions={reactions} onToggle={() => {}} />);
    const add = screen.getByTestId('reaction-add-btn');
    expect(add.getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('카운트 SR 영역은 polite+atomic live region 으로 현재 집계를 싣는다', () => {
    render(<ReactionBar reactions={reactions} onToggle={() => {}} />);
    const live = screen.getByTestId('reaction-live');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.getAttribute('aria-atomic')).toBe('true');
    expect(live.textContent).toBe('👍 3명, 🎉 1명');
  });
});

describe('ReactionBar 커스텀 이모지 url 해석 (S41 fix-forward)', () => {
  const customEmojis = [{ id: 'e1', name: 'partyblob', url: 'https://cdn/partyblob.gif' }];

  it('낙관 업데이트(payload url 부재)라도 워크스페이스 팩에 살아있으면 img 로 렌더한다', () => {
    // 자기 토글 직후: reaction 에 url 이 아직 없지만(:partyblob:) 팩에는 존재 →
    // [삭제된 이모지] placeholder 가 아니라 <img> 칩이어야 한다(깜빡임 회귀 방지).
    const { container } = render(
      <ReactionBar
        reactions={[{ emoji: ':partyblob:', count: 1, byMe: true }]}
        onToggle={() => {}}
        customEmojis={customEmojis}
      />,
    );
    const chip = container.querySelector('[data-testid="reaction-:partyblob:"]');
    expect(chip?.querySelector('img')?.getAttribute('src')).toBe('https://cdn/partyblob.gif');
    expect(chip?.getAttribute('data-deleted')).toBeNull();
    expect(container.querySelector('[data-testid="reaction-deleted-:partyblob:"]')).toBeNull();
  });

  it('payload url 도 없고 팩에도 없으면(진짜 삭제) placeholder + "삭제된 이모지" 라벨', () => {
    const { container } = render(
      <ReactionBar
        reactions={[{ emoji: ':gone:', count: 2, byMe: false }]}
        onToggle={() => {}}
        customEmojis={customEmojis}
      />,
    );
    const chip = container.querySelector('[data-testid="reaction-:gone:"]');
    expect(chip?.getAttribute('data-deleted')).toBe('true');
    expect(chip?.getAttribute('aria-label')).toContain('삭제된 이모지');
    expect(container.querySelector('[data-testid="reaction-deleted-:gone:"]')).not.toBeNull();
  });
});
