// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { AttachmentSpoilerOverlay } from './AttachmentSpoilerOverlay';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});
afterEach(() => cleanup());

describe('AttachmentSpoilerOverlay (S56 D11 FR-AM-22 + S59 FR-AM-19 toggle)', () => {
  it('초기에는 블러 + SPOILER 배지 + reveal 버튼(aria-pressed=false — toggle 의미)', () => {
    render(
      <AttachmentSpoilerOverlay label="고양이.png">
        <img src="blob:x" alt="고양이" />
      </AttachmentSpoilerOverlay>,
    );
    const reveal = screen.getByTestId('spoiler-reveal');
    // FR-AM-19: toggle 의미라 aria-pressed 로 공개/숨김 상태를 통지(미공개 → false).
    expect(reveal.getAttribute('aria-pressed')).toBe('false');
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

  it('클릭하면 reveal(reveal 버튼 사라짐 + 자식 aria-hidden 해제 + 다시 가리기 토글 노출)', () => {
    render(
      <AttachmentSpoilerOverlay>
        <img src="blob:x" alt="x" data-testid="spoiler-child" />
      </AttachmentSpoilerOverlay>,
    );
    fireEvent.click(screen.getByTestId('spoiler-reveal'));
    expect(screen.queryByTestId('spoiler-reveal')).toBeNull();
    const wrapper = screen.getByTestId('spoiler-child').parentElement as HTMLElement;
    expect(wrapper.getAttribute('aria-hidden')).toBe('false');
    // FR-AM-19: 공개 후 "다시 가리기" 토글(aria-pressed=true) 이 노출.
    const hide = screen.getByTestId('spoiler-hide');
    expect(hide.getAttribute('aria-pressed')).toBe('true');
  });

  it('FR-AM-19: 공개 후 재클릭하면 다시 가림(toggle — 자식 다시 aria-hidden)', () => {
    render(
      <AttachmentSpoilerOverlay label="고양이.png">
        <img src="blob:x" alt="고양이" data-testid="spoiler-child" />
      </AttachmentSpoilerOverlay>,
    );
    // 공개.
    fireEvent.click(screen.getByTestId('spoiler-reveal'));
    expect(screen.getByTestId('spoiler-hide')).toBeTruthy();
    // 재클릭 → 다시 가림.
    fireEvent.click(screen.getByTestId('spoiler-hide'));
    expect(screen.queryByTestId('spoiler-hide')).toBeNull();
    const reveal = screen.getByTestId('spoiler-reveal');
    expect(reveal.getAttribute('aria-pressed')).toBe('false');
    const wrapper = screen.getByTestId('spoiler-child').parentElement as HTMLElement;
    expect(wrapper.getAttribute('aria-hidden')).toBe('true');
  });

  it('FR-AM-19: 다시 가리기 토글 aria-label 에 label 포함', () => {
    render(
      <AttachmentSpoilerOverlay label="고양이.png">
        <img src="blob:x" alt="고양이" />
      </AttachmentSpoilerOverlay>,
    );
    fireEvent.click(screen.getByTestId('spoiler-reveal'));
    expect(screen.getByTestId('spoiler-hide').getAttribute('aria-label')).toBe(
      '스포일러 다시 가리기: 고양이.png',
    );
  });

  it('FR-AM-19: 키보드(Enter/Space)로도 공개 토글 동작(button 기본)', async () => {
    render(
      <AttachmentSpoilerOverlay>
        <img src="blob:x" alt="x" data-testid="spoiler-child" />
      </AttachmentSpoilerOverlay>,
    );
    const reveal = screen.getByTestId('spoiler-reveal') as HTMLButtonElement;
    // button 은 click 으로 Enter/Space 키 활성화가 매핑됩니다 — click 으로 동등 검증.
    reveal.focus();
    fireEvent.click(reveal);
    // 공개 직후 콘텐츠 래퍼로 포커스 이동(queueMicrotask).
    const wrapper = screen.getByTestId('spoiler-child').parentElement as HTMLElement;
    await waitFor(() => expect(document.activeElement).toBe(wrapper));
  });

  it('S59 M-1 (SC 2.4.3): 다시 가림 시 포커스를 reveal 공개 버튼으로 이동', async () => {
    render(
      <AttachmentSpoilerOverlay label="고양이.png">
        <img src="blob:x" alt="고양이" />
      </AttachmentSpoilerOverlay>,
    );
    // 공개.
    fireEvent.click(screen.getByTestId('spoiler-reveal'));
    const hide = await screen.findByTestId('spoiler-hide');
    hide.focus();
    // 다시 가림 → 포커스가 reveal 공개 버튼으로 복원.
    fireEvent.click(hide);
    const reveal = await screen.findByTestId('spoiler-reveal');
    await waitFor(() => expect(document.activeElement).toBe(reveal));
  });

  it('S59 통합: onRevealChange 콜백으로 공개/숨김 상태를 통지', async () => {
    const onRevealChange = vi.fn();
    render(
      <AttachmentSpoilerOverlay label="x" onRevealChange={onRevealChange}>
        <img src="blob:x" alt="x" />
      </AttachmentSpoilerOverlay>,
    );
    // 마운트 시 초기 false 통지.
    await waitFor(() => expect(onRevealChange).toHaveBeenLastCalledWith(false));
    // 공개 → true.
    fireEvent.click(screen.getByTestId('spoiler-reveal'));
    await waitFor(() => expect(onRevealChange).toHaveBeenLastCalledWith(true));
    // 다시 가림 → false.
    fireEvent.click(screen.getByTestId('spoiler-hide'));
    await waitFor(() => expect(onRevealChange).toHaveBeenLastCalledWith(false));
  });
});
