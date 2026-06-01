import type { Notification } from '../../stores/notification-store';

/**
 * S24 fix-forward (a11y BLOCKER #6): 토스트 컨테이너 종류 결정의 단일 출처(테스트
 * 대상 순수 로직). Toast.tsx 렌더가 이 판정을 따른다.
 *
 *  - 'interactive-button': onActivate 만 있고 action 이 없는 토스트 → 전체가
 *    클릭 가능한 <button>(role status/alert 유지).
 *  - 'plain-action': action(Undo 버튼)이 있는 토스트 → 인터랙티브 button 을 라이브
 *    리전(role=status/alert)에 중첩하지 않도록 role 없는 컨테이너로 렌더한다.
 *  - 'live-region': 텍스트 전용 토스트 → role status(또는 danger=alert) 라이브 리전.
 *
 * 외부 ToastViewport 컨테이너는 role="region" + aria-label 만 두고 aria-live 를
 * 두지 않는다(이중 안내 제거) — 그 판정은 이 함수가 아니라 컴포넌트 상수다.
 */
export type ToastContainerKind = 'interactive-button' | 'plain-action' | 'live-region';

export function toastContainerKind(
  t: Pick<Notification, 'action' | 'onActivate'>,
): ToastContainerKind {
  const hasAction = typeof t.action?.onClick === 'function';
  if (hasAction) return 'plain-action';
  if (typeof t.onActivate === 'function') return 'interactive-button';
  return 'live-region';
}

/**
 * live-region / interactive-button 토스트의 ARIA role. danger 는 assertive alert,
 * 그 외는 polite status. plain-action 컨테이너는 role 을 두지 않으므로(인터랙티브
 * 버튼 중첩 방지) 이 함수를 거치지 않는다.
 */
export function toastLiveRole(variant: Notification['variant']): 'alert' | 'status' {
  return variant === 'danger' ? 'alert' : 'status';
}

export function toastLiveAriaLive(variant: Notification['variant']): 'assertive' | 'polite' {
  return variant === 'danger' ? 'assertive' : 'polite';
}
