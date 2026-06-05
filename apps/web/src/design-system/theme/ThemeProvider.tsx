import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * Theme switching is attribute-only. Setting `<html data-theme="...">`
 * causes the design-system tokens (in /design-system/tokens.css) to flip
 * automatically — no per-token JS writes, no React re-render needed.
 * Keep this provider lean: it only owns user preference + resolved name.
 *
 * S76 (D14 / FR-PS-09 · Fork C1): localStorage('qufox:theme') 가 부팅 fast-path 의
 * 단일 출처다(index.html 즉시-적용 스크립트 + 이 provider). 로그인 후 GET
 * /me/settings/appearance 가 `applyAppearanceToDOM` 으로 서버값을 DOM 에 덮고
 * 같은 localStorage 키도 동기화하므로(서버 단일 출처), 다음 부팅에서 이 provider 가
 * 읽는 preference 도 서버값과 정합한다. 즉 이 provider 는 변경하지 않고 그대로 두되,
 * 서버 보정이 localStorage 를 갱신하는 방식으로 두 경로를 합류시킨다(무-충돌).
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
