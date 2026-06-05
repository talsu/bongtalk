import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * Theme switching is attribute-only. Setting `<html data-theme="...">`
 * causes the design-system tokens (in /design-system/tokens.css) to flip
 * automatically — no per-token JS writes, no React re-render needed.
 * Keep this provider lean: it only owns user preference + resolved name.
 *
 * S76 (D14 / FR-PS-09 · Fork C1): localStorage('qufox:theme') 가 부팅 fast-path 의
 * 단일 출처다(index.html 즉시-적용 스크립트 + 이 provider).
 *
 * F-M2 (perf MODERATE · reviewer M-2): 테마의 **단일 소유자**는 이 ThemeProvider 다.
 * 외관 설정(useAppearanceSettings/useUpdateAppearanceSettings)은 GET/PATCH 로 받은
 * 서버값을 `setPreference(themeToPreference(theme))` 로 라우팅한다 — applyAppearanceToDOM
 * 이 data-theme/localStorage 를 직접 쓰던 이중 소유를 제거했다. SYSTEM 을 고르면
 * preference='system' 이 되어 아래 prefers-color-scheme 리스너가 라이브로 추종한다
 * (종전엔 applyAppearanceToDOM 이 한 번 해석한 값을 박아 OS 테마 변경을 못 따라갔다).
 */

export type ThemeName = 'light' | 'dark';
export type ThemePreference = ThemeName | 'system';

type ThemeContextValue = {
  /** What the app is currently showing. */
  resolved: ThemeName;
  /** What the user chose (incl. 'system'). */
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
  toggle: () => void;
};

const STORAGE_KEY = 'qufox:theme';
const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredPreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system';
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    /* SSR/quota — ignore */
  }
  return 'system';
}

function systemPrefers(): ThemeName {
  // qufox is dark-first: when there's no explicit system preference or SSR,
  // default to dark to match the canvas baked into index.html.
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function resolveTheme(pref: ThemePreference): ThemeName {
  return pref === 'system' ? systemPrefers() : pref;
}

function applyTheme(theme: ThemeName): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

export function ThemeProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readStoredPreference());
  const [resolved, setResolved] = useState<ThemeName>(() => resolveTheme(readStoredPreference()));

  useEffect(() => {
    const next = resolveTheme(preference);
    setResolved(next);
    applyTheme(next);
  }, [preference]);

  useEffect(() => {
    if (preference !== 'system') return;
    const mql = window.matchMedia('(prefers-color-scheme: light)');
    const handler = (): void => {
      const next = systemPrefers();
      setResolved(next);
      applyTheme(next);
    };
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [preference]);

  const setPreference = useCallback((p: ThemePreference) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, p);
    } catch {
      /* ignore */
    }
    setPreferenceState(p);
  }, []);

  const toggle = useCallback(() => {
    setPreference(resolved === 'dark' ? 'light' : 'dark');
  }, [resolved, setPreference]);

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, resolved, setPreference, toggle }),
    [preference, resolved, setPreference, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
