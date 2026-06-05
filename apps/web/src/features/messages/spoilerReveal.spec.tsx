// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { parseMrkdwn } from '@qufox/shared-types';
import { renderAst } from './renderAst';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});
afterEach(() => cleanup());

function renderSpoiler(raw: string): void {
  const { ast } = parseMrkdwn(raw);
  render(<>{renderAst(ast)}</>);
}

describe('Spoiler reveal toggle (FR-MD-02 regression)', () => {
  it('renders a masked spoiler with role=button / tabIndex / aria-label', () => {
    renderSpoiler('||secret||');
    const el = screen.getByRole('button', { name: '스포일러 보기' });
    expect(el).toBeTruthy();
    expect(el.getAttribute('tabindex')).toBe('0');
    // 클릭 전: 마스킹 상태.
    expect(el.getAttribute('data-revealed')).toBe('false');
    expect(el.className).toContain('qf-spoiler');
  });

  it('reveals on click and re-masks on a second click', () => {
    renderSpoiler('||secret||');
    const el = screen.getByRole('button', { name: '스포일러 보기' });
    fireEvent.click(el);
    expect(el.getAttribute('data-revealed')).toBe('true');
    expect(el.getAttribute('aria-label')).toBe('스포일러 숨기기');
    fireEvent.click(el);
    expect(el.getAttribute('data-revealed')).toBe('false');
    expect(el.getAttribute('aria-label')).toBe('스포일러 보기');
  });

  it('toggles via Enter and Space keys', () => {
    renderSpoiler('||secret||');
    const el = screen.getByRole('button', { name: '스포일러 보기' });
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(el.getAttribute('data-revealed')).toBe('true');
    fireEvent.keyDown(el, { key: ' ' });
    expect(el.getAttribute('data-revealed')).toBe('false');
  });
});
