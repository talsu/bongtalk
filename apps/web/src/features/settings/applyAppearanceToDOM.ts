import type { AppearanceSettings, Theme } from '@qufox/shared-types';
import type { ThemePreference } from '../../design-system/theme/ThemeProvider';

/**
 * S76 (D14 / FR-PS-09 + Fork C1): 외관 설정을 DOM 에 즉시 반영하는 순수 부수효과 함수.
 *
 *   - theme   → <html data-theme="dark|light">. SYSTEM 은 prefers-color-scheme 로 해석한다
 *               (DS data-theme 토큰은 dark/light 2값 — SYSTEM 은 클라 런타임 해석).
 *   - density → <html data-density="cozy|compact">. DS [data-density="compact"] 셀렉터가
 *               메시지/타일 밀도를 줄인다(COZY 는 기본 비-compact — 속성도 cozy 로 명시).
 *   - chatFontSize → (F-M1) DOM 에 적용하지 않는다. DS 4파일에 `--fs-chat` 를 참조하는
 *               규칙이 0건이고 raw px 변수 주입은 1.4.4(Resize text) 위반이므로, DS-owner 가
 *               qf-message__body 배선(px→rem 토큰화)을 더하기 전까지는 시각 적용을 보류한다.
 *               값 자체는 서버/스토어/캐시에 계속 저장된다(데이터 유지) — 아래 NOTE(carryover).
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
 * chatFontSize 는 DS-owner carryover(아래 NOTE)라 적용하지 않으며, clock24h 는 스토어가 보유한다.
 */
export function applyAppearanceToDOM(settings: AppearanceSettings): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  // COZY 는 명시적으로 cozy 로 둔다(DS 의 [data-density="compact"] 만 override, cozy=기본).
  root.dataset.density = settings.density === 'COMPACT' ? 'compact' : 'cozy';
  // NOTE(F-M1 / DS carryover): chatFontSize 는 시각 적용을 보류한다 — DS 4파일에
  // `--fs-chat` 참조 규칙이 0건이고 raw px 변수 주입은 1.4.4(Resize text) 위반이다.
  // DS-owner 가 `.qf-message__body { font-size: var(--fs-chat, var(--fs-15)) }` 배선 +
  // [data-density=compact] 충돌 해소 + px→rem 토큰화를 추가한 뒤 변수 주입을 되살린다.
}
