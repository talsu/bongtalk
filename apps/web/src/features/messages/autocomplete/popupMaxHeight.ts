import { useEffect, useState } from 'react';

/**
 * S18 (모바일 FR-RC06) — 자동완성 팝업 maxHeight 계산 (순수 함수).
 *
 * 데스크톱 DS `.qf-autocomplete` 는 max-height 280px 고정이지만, 모바일에서
 * 가상키보드가 올라오면 visualViewport 높이가 줄어 팝업이 키보드/컴포저에
 * 가립니다. visualViewport.height 에서 컴포저+safe-area 여유(reserve)를 뺀
 * 값을 하드캡(280px)과 비교해 더 작은 쪽을, 단 최소 96px(한 행 이상) 이상으로
 * 보장합니다.
 */
const MIN_POPUP_PX = 96;

export function computePopupMaxHeight({
  viewportHeight,
  reserve,
  hardCap,
}: {
  viewportHeight: number;
  reserve: number;
  hardCap: number;
}): number {
  const available = viewportHeight - reserve;
  return Math.max(MIN_POPUP_PX, Math.min(hardCap, available));
}

/**
 * visualViewport 를 구독해 팝업 maxHeight(px)를 반환하는 훅. iOS Safari 의
 * `offsetTop` 보정은 useKeyboardDodge 와 동일한 패턴으로, 가시 영역을 정확히
 * 반영합니다. visualViewport 미지원(SSR/jsdom/데스크톱)에서는 하드캡을
 * 그대로 씁니다.
 */
const COMPOSER_RESERVE_PX = 140;
const HARD_CAP_PX = 280;

export function useAutocompleteMaxHeight(enabled: boolean): number {
  const [maxHeight, setMaxHeight] = useState<number>(HARD_CAP_PX);

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === 'undefined') return;
    const vv = window.visualViewport;
    if (!vv) {
      setMaxHeight(HARD_CAP_PX);
      return;
    }
    const apply = (): void => {
      // iOS Safari: offsetTop 만큼 가시 영역이 위로 밀리므로 그만큼 더 뺀다.
      const usable = vv.height - vv.offsetTop;
      setMaxHeight(
        computePopupMaxHeight({
          viewportHeight: usable,
          reserve: COMPOSER_RESERVE_PX,
          hardCap: HARD_CAP_PX,
        }),
      );
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
    };
  }, [enabled]);

  return maxHeight;
}
