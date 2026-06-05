import type { AppearanceSettings, Theme } from '@qufox/shared-types';

/**
 * S76 (D14 / FR-PS-09 + Fork C1): 외관 설정을 DOM 에 즉시 반영하는 순수 부수효과 함수.
 *
 *   - theme   → <html data-theme="dark|light">. SYSTEM 은 prefers-color-scheme 로 해석한다
 *               (DS data-theme 토큰은 dark/light 2값 — SYSTEM 은 클라 런타임 해석).
 *   - density → <html data-density="cozy|compact">. DS [data-density="compact"] 셀렉터가
 *               메시지/타일 밀도를 줄인다(COZY 는 기본 비-compact — 속성도 cozy 로 명시).
 *   - chatFontSize → <html style --fs-chat: Npx>. DS qf-message__body 등이 이 변수를 참조하면
 *               즉시 반영된다(현재 DS 4파일 미참조 항목은 DS-owner carryover — 아래 NOTE).
 *   - clock24h → DOM 속성이 아니라 appearance 스토어가 보유한다(MessageItem 시각 포맷이 구독).
 *
 * 서버 단일 출처(Fork C1): index.html 의 즉시-적용 스크립트(localStorage theme)가 첫 페인트의
 * 깜빡임을 막고, 로그인 후 GET /me/settings/appearance 가 이 함수로 서버값을 덮어 보정한다.
 */
export function resolveTheme(theme: Theme): 'dark' | 'light' {
  if (theme === 'DARK') return 'dark';
  if (theme === 'LIGHT') return 'light';
  // SYSTEM — prefers-color-scheme 로 해석. SSR/미지원 환경은 dark(qufox dark-first).
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** ThemeProvider 의 localStorage 키 — 서버값 보정 시 다음 부팅 fast-path 도 동기화한다. */
const THEME_STORAGE_KEY = 'qufox:theme';

export function applyAppearanceToDOM(settings: AppearanceSettings): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const resolved = resolveTheme(settings.theme);
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  // Fork C1: ThemeProvider(localStorage 우선)의 부팅 fast-path 가 다음 새로고침에
  // 서버값과 일치하도록 preference 를 동기화한다. SYSTEM 은 'system' 으로 보존해
  // prefers-color-scheme 추종을 유지한다.
  try {
    const pref =
      settings.theme === 'LIGHT' ? 'light' : settings.theme === 'DARK' ? 'dark' : 'system';
    window.localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    /* SSR/quota — 무시(DOM 적용은 이미 끝남). */
  }
  // COZY 는 명시적으로 cozy 로 둔다(DS 의 [data-density="compact"] 만 override, cozy=기본).
  root.dataset.density = settings.density === 'COMPACT' ? 'compact' : 'cozy';
  // NOTE(DS carryover): qf-message__body 가 --fs-chat 를 참조해야 폰트 크기가 시각적으로
  // 반영된다. DS 4파일이 미참조면 변수만 설정되고(영속 + 컨트롤 동작) 완전 시각효과는
  // DS-owner 가 qf-message__body { font-size: var(--fs-chat) } 를 더하는 carryover 다.
  root.style.setProperty('--fs-chat', `${settings.chatFontSize}px`);
}
