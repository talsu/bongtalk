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

  // S78 reviewer FF5 (a11y MAJOR): each section is labelled by its heading so
  // SR users get the category context for the grouped shortcut rows.
  // Note: Dialog renders into a portal, so the content lives under document.body
  // (not the render container) — matching the existing tests above.
  it('labels every section by its heading (aria-labelledby → heading id)', () => {
    render(<ShortcutHelp />);
    const sections = document.querySelectorAll('section[aria-labelledby]');
    expect(sections.length).toBeGreaterThanOrEqual(3);
    sections.forEach((section) => {
      const id = section.getAttribute('aria-labelledby');
      expect(id).toBeTruthy();
      const heading = document.getElementById(id ?? '');
      expect(heading?.tagName.toLowerCase()).toBe('h3');
    });
  });

  // FF5: the visual "(준비 중)" badge is aria-hidden; the SR context is carried
  // by a separate sr-only string so the meaning still reaches assistive tech.
  it('hides the visual (준비 중) badge from SR and conveys it via sr-only text', () => {
    render(<ShortcutHelp />);
    const hiddenBadge = Array.from(document.querySelectorAll('[aria-hidden="true"]')).find((el) =>
      (el.textContent ?? '').includes('준비 중'),
    );
    expect(hiddenBadge).toBeTruthy();
    const srContext = Array.from(document.querySelectorAll('.sr-only')).find((el) =>
      (el.textContent ?? '').includes('준비 중'),
    );
    expect(srContext).toBeTruthy();
  });

  // MEDIUM: keycaps delegate styling to the DS `.qf-kbd` class (no raw inline
  // px borders / padding / background).
  it('renders keycaps with the DS .qf-kbd class (no inline px styling)', () => {
    render(<ShortcutHelp />);
    const kbds = document.querySelectorAll('kbd.qf-kbd');
    expect(kbds.length).toBeGreaterThan(0);
    kbds.forEach((kbd) => {
      expect((kbd as HTMLElement).style.padding).toBe('');
      expect((kbd as HTMLElement).style.background).toBe('');
    });
  });
});
