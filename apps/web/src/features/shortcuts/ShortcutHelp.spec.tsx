// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';

let openModal: string | null = 'shortcut-help';
const setOpenModal = vi.fn();
vi.mock('../../stores/ui-store', () => ({
  useUI: (sel: (s: { openModal: string | null; setOpenModal: typeof setOpenModal }) => unknown) =>
    sel({ openModal, setOpenModal }),
}));

import { ShortcutHelp } from './ShortcutHelp';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  openModal = 'shortcut-help';
  setOpenModal.mockReset();
});
afterEach(() => cleanup());

describe('ShortcutHelp categories (S78 PRD parity)', () => {
  it('renders the PRD 3-category structure (내비게이션 / 포맷 / 메시지 액션)', () => {
    render(<ShortcutHelp />);
    const text = document.body.textContent ?? '';
    expect(text).toContain('내비게이션');
    expect(text).toContain('포맷');
    expect(text).toContain('메시지 액션');
  });

  it('lists formatting shortcuts (Ctrl/Cmd + B / I) under 포맷', () => {
    render(<ShortcutHelp />);
    const text = document.body.textContent ?? '';
    expect(text).toContain('Ctrl/Cmd + B');
    expect(text).toContain('Ctrl/Cmd + I');
  });

  it('lists message action shortcuts (편집 / 삭제 / 반응 / 스레드)', () => {
    render(<ShortcutHelp />);
    const text = document.body.textContent ?? '';
    expect(text).toContain('편집');
    expect(text).toContain('반응');
    expect(text).toContain('스레드');
  });

  it('marks not-yet-wired shortcuts as 준비 중 (display-only this slice)', () => {
    render(<ShortcutHelp />);
    const text = document.body.textContent ?? '';
    expect(text).toContain('준비 중');
  });

  it('renders nothing when the modal is closed', () => {
    openModal = null;
    const { container } = render(<ShortcutHelp />);
    expect(container.firstChild).toBeNull();
  });
});
