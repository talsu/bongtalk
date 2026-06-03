// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AttachmentSpoilerOverlay } from './AttachmentSpoilerOverlay';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});
afterEach(() => cleanup());

describe('AttachmentSpoilerOverlay (S56 D11 FR-AM-22)', () => {
  it('초기에는 블러 + SPOILER 배지 + reveal 버튼', () => {
    render(
      <AttachmentSpoilerOverlay label="고양이.png">
        <img src="blob:x" alt="고양이" />
      </AttachmentSpoilerOverlay>,
    );
    const reveal = screen.getByTestId('spoiler-reveal');
    expect(reveal.getAttribute('aria-pressed')).toBe('false');
    expect(reveal.getAttribute('aria-label')).toContain('고양이.png');
    expect(screen.getByText('SPOILER')).toBeTruthy();
  });

  it('클릭하면 reveal(버튼 사라짐)', () => {
    render(
      <AttachmentSpoilerOverlay>
        <img src="blob:x" alt="x" />
      </AttachmentSpoilerOverlay>,
    );
    fireEvent.click(screen.getByTestId('spoiler-reveal'));
    expect(screen.queryByTestId('spoiler-reveal')).toBeNull();
  });
});
