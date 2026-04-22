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
