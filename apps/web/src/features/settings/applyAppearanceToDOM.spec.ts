// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppearanceSettings } from '@qufox/shared-types';
import { applyAppearanceToDOM, resolveTheme } from './applyAppearanceToDOM';

function base(overrides: Partial<AppearanceSettings> = {}): AppearanceSettings {
  return { theme: 'DARK', density: 'COZY', chatFontSize: 15, clock24h: false, ...overrides };
}

describe('S76 applyAppearanceToDOM (FR-PS-09 · Fork C1)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-density');
    document.documentElement.style.removeProperty('--fs-chat');
    window.localStorage.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('sets data-theme=dark and density=cozy and --fs-chat', () => {
    applyAppearanceToDOM(base({ theme: 'DARK', density: 'COZY', chatFontSize: 16 }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.density).toBe('cozy');
    expect(document.documentElement.style.getPropertyValue('--fs-chat')).toBe('16px');
  });

  it('LIGHT theme + COMPACT density map to light / compact', () => {
    applyAppearanceToDOM(base({ theme: 'LIGHT', density: 'COMPACT' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.density).toBe('compact');
  });

  it('SYSTEM resolves via prefers-color-scheme', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true, // prefers light
    } as MediaQueryList);
    expect(resolveTheme('SYSTEM')).toBe('light');
    applyAppearanceToDOM(base({ theme: 'SYSTEM' }));
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('syncs the ThemeProvider localStorage key for the next-boot fast-path', () => {
    applyAppearanceToDOM(base({ theme: 'LIGHT' }));
    expect(window.localStorage.getItem('qufox:theme')).toBe('light');
    applyAppearanceToDOM(base({ theme: 'SYSTEM' }));
    expect(window.localStorage.getItem('qufox:theme')).toBe('system');
  });
});
