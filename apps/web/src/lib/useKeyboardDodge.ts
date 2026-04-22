import { useEffect } from 'react';

/**
 * visualViewport-driven keyboard dodge. When the software keyboard
 * opens, iOS/Android shrink the visual viewport below the layout
 * viewport. We mirror that delta into `--m-kb-inset` on the root so
 * qf-m-composer and qf-m-safe-bottom rules can subtract it, keeping
 * the composer above the keyboard instead of being covered.
 *
 * On desktop / browsers without visualViewport (SSR, jsdom) this
 * is a no-op and the inset stays at its default 0.
 */
export function useKeyboardDodge(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const vv = window.visualViewport;
    if (!vv) return;

    const root = document.documentElement;

    const apply = (): void => {
      // Positive delta means the visual viewport is shorter than the
      // layout viewport — typically the keyboard.
      const delta = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      root.style.setProperty('--m-kb-inset', `${Math.round(delta)}px`);
      root.dataset.mKbOpen = delta > 40 ? 'true' : 'false';
    };

    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      root.style.removeProperty('--m-kb-inset');
      delete root.dataset.mKbOpen;
    };
  }, []);
}
