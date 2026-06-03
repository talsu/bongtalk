import { useCallback, useState } from 'react';

/**
 * S59 (D11 / FR-AM-10/11) — 라이트박스 인덱스 + zoom/pan 상태 훅.
 *
 * 한 라이트박스 세션의 가변 상태(현재 이미지 index, 휠 zoom 배율, 드래그 패닝
 * translate)를 한 곳에 모아 ImageLightbox 가 표현(렌더)만 담당하도록 분리합니다.
 * 테스트는 이 훅의 순수 로직(클램프·경계·리셋)을 컴포넌트 없이 검증할 수 있습니다.
 *
 * 규칙(PRD FR-AM-11):
 *   - zoom 은 ZOOM_MIN(0.5) ~ ZOOM_MAX(3.0) 으로 클램프, 휠 step 은 ZOOM_STEP(0.15).
 *   - 이미지 교체(setIndex/next/prev)는 zoom=1.0, translate=0 으로 리셋합니다.
 *   - index 는 [0, count-1] 로 클램프 — 순환 없음(첫/마지막서 next/prev 무변화).
 */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3.0;
export const ZOOM_STEP = 0.15;

export interface LightboxState {
  /** 현재 보여지는 이미지 index(0-based). */
  index: number;
  /** 휠 zoom 배율(ZOOM_MIN~ZOOM_MAX). */
  zoom: number;
  /** 드래그 패닝 가로 오프셋(px). */
  translateX: number;
  /** 드래그 패닝 세로 오프셋(px). */
  translateY: number;
}

export interface LightboxControls extends LightboxState {
  /** 첫 이미지인가(ArrowLeft 비활성 판단). */
  isFirst: boolean;
  /** 마지막 이미지인가(ArrowRight 비활성 판단). */
  isLast: boolean;
  /** index 를 [0,count-1] 로 클램프해 설정(zoom/translate 리셋). */
  setIndex: (next: number) => void;
  /** 다음 이미지(마지막이면 무변화). */
  next: () => void;
  /** 이전 이미지(첫 장이면 무변화). */
  prev: () => void;
  /** 휠 delta(음수=확대, 양수=축소)만큼 zoom 조정(클램프). */
  zoomBy: (deltaY: number) => void;
  /** 드래그 패닝 오프셋을 절대값으로 설정. */
  setTranslate: (x: number, y: number) => void;
  /** zoom=1, translate=0 으로 리셋(이미지 교체/더블탭 등). */
  resetTransform: () => void;
}

function clampZoom(z: number): number {
  if (z < ZOOM_MIN) return ZOOM_MIN;
  if (z > ZOOM_MAX) return ZOOM_MAX;
  return z;
}

export function useImageLightbox(count: number, initialIndex: number): LightboxControls {
  // 마운트 시점 initialIndex 를 [0,count-1] 로 클램프해 보관합니다.
  const clampIndex = useCallback(
    (i: number): number => {
      if (count <= 0) return 0;
      if (i < 0) return 0;
      if (i > count - 1) return count - 1;
      return i;
    },
    [count],
  );

  const [state, setState] = useState<LightboxState>(() => ({
    index: clampIndex(initialIndex),
    zoom: 1,
    translateX: 0,
    translateY: 0,
  }));

  const setIndex = useCallback(
    (nextIndex: number): void => {
      // 이미지 교체 시 zoom/translate 를 리셋합니다(FR-AM-11) — 이전 state 불필요.
      setState({ index: clampIndex(nextIndex), zoom: 1, translateX: 0, translateY: 0 });
    },
    [clampIndex],
  );

  const next = useCallback(() => setIndex(state.index + 1), [setIndex, state.index]);
  const prev = useCallback(() => setIndex(state.index - 1), [setIndex, state.index]);

  const zoomBy = useCallback((deltaY: number): void => {
    setState((prev) => {
      // deltaY<0(휠 업) = 확대, deltaY>0(휠 다운) = 축소.
      const dir = deltaY < 0 ? 1 : -1;
      return { ...prev, zoom: clampZoom(prev.zoom + dir * ZOOM_STEP) };
    });
  }, []);

  const setTranslate = useCallback((x: number, y: number): void => {
    setState((prev) => ({ ...prev, translateX: x, translateY: y }));
  }, []);

  const resetTransform = useCallback((): void => {
    setState((prev) => ({ ...prev, zoom: 1, translateX: 0, translateY: 0 }));
  }, []);

  return {
    ...state,
    isFirst: state.index <= 0,
    isLast: state.index >= count - 1,
    setIndex,
    next,
    prev,
    zoomBy,
    setTranslate,
    resetTransform,
  };
}
