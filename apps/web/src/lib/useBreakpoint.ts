import { useSyncExternalStore } from 'react';

/**
 * Mobile vs desktop split at 768px — matches the DS tokens' primary
 * layout breakpoint (see `/design-system/tokens.css` / Tailwind's
 * default `md:` gate). Exposed as a hook so the Shell can choose
 * between `MobileShell` and the desktop shell once per mount; crossing
 * the breakpoint remounts, per task-024 contract (no live reflow).
 *
 * Implementation: useSyncExternalStore subscribed to a MediaQueryList
 * change listener. That pattern avoids the "useState-based resize
 * listener" double-render trap; the store is a boolean so React can
 * dedupe renders against the previous value.
 *
 * 071-M5 H22 — 가로 모드 정책 = A안(현행 유지, 의도된 동작):
 * 폰을 landscape 로 돌려 뷰포트 너비가 768px 이상이 되면 데스크톱 셸이
 * 렌더된다. 이는 버그가 아니라 정책이다 — 분기 기준은 포인터 종류가 아닌
 * 뷰포트 너비 단일 축이며, coarse-pointer 강제(B안)는 채택하지 않았다.
 * 회전 반응 스팟체크(2026-06-11): subscribe 가 MediaQueryList 'change'
 * 리스너를 등록하는 구독형이므로 회전으로 768px 경계를 넘으면 즉시
 * re-render 된다(감사 H-11 의 "matchMedia 1회 평가라 회전 비반응" 관찰은
 * stale — useSyncExternalStore 구독 확인). 경계 횡단 시 셸은 task-024
 * 계약대로 리마운트된다(라이브 리플로 없음).
 */
const MOBILE_BREAKPOINT_PX = 768;

function getIsMobile(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`).matches;
}

function subscribe(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX - 1}px)`);
  mql.addEventListener('change', callback);
  return () => mql.removeEventListener('change', callback);
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getIsMobile, () => false);
}
