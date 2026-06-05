import type { AccessibilitySettings } from '@qufox/shared-types';

/**
 * S77a (D14 / FR-PS-12): 접근성 설정을 DOM 에 즉시 반영하는 순수 부수효과 함수.
 *
 *   - reduceMotion → <html data-reduce-motion="true|false">. app CSS(index.css)의
 *       `html[data-reduce-motion="true"]` 규칙이 애니메이션/트랜지션/smooth scroll 을
 *       무력화한다. `@media (prefers-reduced-motion: reduce)` 와 병행하므로, 사용자가
 *       명시 설정(true)하거나 OS 가 reduce 를 요청하면 둘 중 하나로 모션이 꺼진다.
 *   - highContrast → <html data-high-contrast="true|false">. DS 4파일에 고대비 테마/
 *       `[data-high-contrast]` 셀렉터가 아직 없으므로(carryover) 속성만 토글하고,
 *       app CSS 가 최소한의 고대비 보정(포커스 링/테두리 강조)을 page-scoped 로 더한다.
 *
 * ★ data-reduce-motion 은 "false" 도 명시적으로 적는다 — true→false 토글 시 속성을
 *   지우지 않고 "false" 로 덮어써, OS 미디어쿼리만 단독으로 남게 한다(서버값이 단일 출처).
 */
export function applyAccessibilityToDOM(settings: AccessibilitySettings): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.reduceMotion = settings.reduceMotion ? 'true' : 'false';
  root.dataset.highContrast = settings.highContrast ? 'true' : 'false';
}
