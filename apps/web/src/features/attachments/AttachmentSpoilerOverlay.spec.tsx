// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AttachmentSpoilerOverlay } from './AttachmentSpoilerOverlay';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});
afterEach(() => cleanup());

describe('AttachmentSpoilerOverlay (S56 D11 FR-AM-22)', () => {
  it('초기에는 블러 + SPOILER 배지 + reveal 버튼(aria-pressed 없음)', () => {
    render(
      <AttachmentSpoilerOverlay label="고양이.png">
        <img src="blob:x" alt="고양이" />
      </AttachmentSpoilerOverlay>,
    );
    const reveal = screen.getByTestId('spoiler-reveal');
    // B-05: 단방향 액션 — aria-pressed 미사용, 공개 라벨만.
    expect(reveal.getAttribute('aria-pressed')).toBeNull();
    expect(reveal.getAttribute('aria-label')).toBe('스포일러 공개: 고양이.png');
    expect(screen.getByText('SPOILER')).toBeTruthy();
  });

  it('미공개 시 자식 래퍼는 aria-hidden(N-02 — 공개 전 alt 노출 차단)', () => {
    render(
      <AttachmentSpoilerOverlay label="고양이.png">
        <img src="blob:x" alt="고양이" data-testid="spoiler-child" />
      </AttachmentSpoilerOverlay>,
    );
    const wrapper = screen.getByTestId('spoiler-child').parentElement as HTMLElement;
    expect(wrapper.getAttribute('aria-hidden')).toBe('true');
    expect(wrapper.getAttribute('tabindex')).toBe('-1');
  });

  it('클릭하면 reveal(버튼 사라짐 + 자식 aria-hidden 해제)', () => {
    render(
      <AttachmentSpoilerOverlay>
        <img src="blob:x" alt="x" data-testid="spoiler-child" />
      </AttachmentSpoilerOverlay>,
    );
    fireEvent.click(screen.getByTestId('spoiler-reveal'));
    expect(screen.queryByTestId('spoiler-reveal')).toBeNull();
    const wrapper = screen.getByTestId('spoiler-child').parentElement as HTMLElement;
    expect(wrapper.getAttribute('aria-hidden')).toBe('false');
  });
});
