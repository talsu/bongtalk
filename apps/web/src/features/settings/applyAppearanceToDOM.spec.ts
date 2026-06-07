// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppearanceSettings } from '@qufox/shared-types';
import { applyAppearanceToDOM, resolveTheme, themeToPreference } from './applyAppearanceToDOM';

function base(overrides: Partial<AppearanceSettings> = {}): AppearanceSettings {
  return {
    theme: 'DARK',
    density: 'COZY',
    chatFontSize: 15,
    clock24h: true,
    linkPreviewsEnabled: true,
    ...overrides,
  };
}

describe('S76 applyAppearanceToDOM (FR-PS-09 · Fork C1 · F-M1/F-M2)', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-density');
    document.documentElement.style.removeProperty('--fs-chat');
    window.localStorage.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  // F-M2: theme 의 단일 소유자는 ThemeProvider 다 — applyAppearanceToDOM 은 density 만 쓴다.
  it('only applies density to the DOM (theme/localStorage are ThemeProvider-owned)', () => {
    applyAppearanceToDOM(base({ theme: 'DARK', density: 'COZY' }));
    expect(document.documentElement.dataset.density).toBe('cozy');
    // F-M2: data-theme 을 직접 쓰지 않는다(ThemeProvider 가 소유).
    expect(document.documentElement.dataset.theme).toBeUndefined();
    // F-M2: localStorage 도 건드리지 않는다(이중 소유 제거).
    expect(window.localStorage.getItem('qufox:theme')).toBeNull();
  });

  it('maps COMPACT density to compact', () => {
    applyAppearanceToDOM(base({ density: 'COMPACT' }));
    expect(document.documentElement.dataset.density).toBe('compact');
  });

  // F-M1: raw px `--fs-chat` 주입을 제거했다(1.4.4 회피 · DS 미지원). 변수가 설정되지 않아야 한다.
  it('does NOT inject the raw px --fs-chat variable (F-M1 · 1.4.4)', () => {
    applyAppearanceToDOM(base({ chatFontSize: 18 }));
    expect(document.documentElement.style.getPropertyValue('--fs-chat')).toBe('');
  });

  it('resolveTheme: DARK/LIGHT are literal, SYSTEM resolves via prefers-color-scheme', () => {
    expect(resolveTheme('DARK')).toBe('dark');
    expect(resolveTheme('LIGHT')).toBe('light');
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true, // prefers light
    } as MediaQueryList);
    expect(resolveTheme('SYSTEM')).toBe('light');
  });

  // F-M2: appearance Theme enum → ThemeProvider preference 변환(SYSTEM 은 라이브 추종 'system').
  it('themeToPreference maps appearance enum to ThemeProvider preference', () => {
    expect(themeToPreference('LIGHT')).toBe('light');
    expect(themeToPreference('DARK')).toBe('dark');
    expect(themeToPreference('SYSTEM')).toBe('system');
  });
});
