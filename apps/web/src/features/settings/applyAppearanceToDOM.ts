import type { AppearanceSettings, Theme } from '@qufox/shared-types';
import type { ThemePreference } from '../../design-system/theme/ThemeProvider';

/**
 * S76 (D14 / FR-PS-09 + Fork C1): 외관 설정을 DOM 에 즉시 반영하는 순수 부수효과 함수.
 *
 *   - theme   → <html data-theme="dark|light">. SYSTEM 은 prefers-color-scheme 로 해석한다
 *               (DS data-theme 토큰은 dark/light 2값 — SYSTEM 은 클라 런타임 해석).
 *   - density → <html data-density="cozy|compact">. DS [data-density="compact"] 셀렉터가
 *               메시지/타일 밀도를 줄인다(COZY 는 기본 비-compact — 속성도 cozy 로 명시).
 *   - chatFontSize → (072-N6-5 D2 승인) <html> style 의 `--fs-chat = var(--fs-N)` 로 적용한다.
 *               raw px 가 아닌 DS rem 토큰 참조라 1.4.4(Resize text) 준수. 메시지 본문
 *               클래스(qf-message__body·thread·mobile·compact)가 var(--fs-chat) 를 소비한다.
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

/**
 * F-M2: 외관 Theme(서버 enum) → ThemeProvider 의 preference(소문자/'system')로 변환한다.
 * 테마의 단일 소유자는 ThemeProvider 이며(setPreference), appearance 경로는 이 변환을 거쳐
 * setPreference 로 라우팅한다 — applyAppearanceToDOM 은 더 이상 data-theme/localStorage 를
 * 직접 쓰지 않는다(이중 소유 제거). SYSTEM 은 'system' 으로 매핑되어 ThemeProvider 의
 * prefers-color-scheme 리스너가 라이브 추종한다.
 */
export function themeToPreference(theme: Theme): ThemePreference {
  if (theme === 'LIGHT') return 'light';
  if (theme === 'DARK') return 'dark';
  return 'system';
}

/**
 * F-M2: density 만 DOM 에 반영한다. theme 은 ThemeProvider 가 단일 소유(setPreference 경유),
 * 072-N6-5(D2 승인): chatFontSize 도 --fs-chat 으로 반영한다(아래 NOTE), clock24h 는 스토어가 보유.
 */
export function applyAppearanceToDOM(settings: AppearanceSettings): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  // COZY 는 명시적으로 cozy 로 둔다(DS 의 [data-density="compact"] 만 override, cozy=기본).
  root.dataset.density = settings.density === 'COMPACT' ? 'compact' : 'cozy';
  // 072-N6-5(D2 · FR-PS-09, 사용자 승인 후 재개): chatFontSize(12/13/14/15/16/18)를 DS 의
  // 동급 rem 토큰(--fs-12..--fs-18)을 참조하는 --fs-chat 으로 주입한다. raw px 가 아닌 rem
  // 토큰 참조라 WCAG 1.4.4(Resize text) 준수. .qf-message__body 가 var(--fs-chat) 를 소비한다.
  root.style.setProperty('--fs-chat', `var(--fs-${settings.chatFontSize})`);
}
