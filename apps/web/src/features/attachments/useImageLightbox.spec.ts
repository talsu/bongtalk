// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useImageLightbox, ZOOM_MIN, ZOOM_MAX, ZOOM_STEP } from './useImageLightbox';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});
afterEach(() => cleanup());

describe('useImageLightbox (S59 D11 FR-AM-10/11)', () => {
  it('initialIndex 를 [0,count-1] 로 클램프하고 zoom=1, translate=0 으로 시작', () => {
    const { result } = renderHook(() => useImageLightbox(3, 5));
    expect(result.current.index).toBe(2); // 5 → count-1=2 클램프.
    expect(result.current.zoom).toBe(1);
    expect(result.current.translateX).toBe(0);
    expect(result.current.translateY).toBe(0);
  });

  it('isFirst/isLast 경계 플래그', () => {
    const { result } = renderHook(() => useImageLightbox(3, 0));
    expect(result.current.isFirst).toBe(true);
    expect(result.current.isLast).toBe(false);
    act(() => result.current.setIndex(2));
    expect(result.current.isFirst).toBe(false);
    expect(result.current.isLast).toBe(true);
  });

  it('next/prev 가 index 를 이동(순환 없음 — 경계서 무변화)', () => {
    const { result } = renderHook(() => useImageLightbox(3, 0));
    // 첫 장에서 prev → 무변화(0 유지).
    act(() => result.current.prev());
    expect(result.current.index).toBe(0);
    // next → 1, 2.
    act(() => result.current.next());
    expect(result.current.index).toBe(1);
    act(() => result.current.next());
    expect(result.current.index).toBe(2);
    // 마지막 장에서 next → 무변화(2 유지).
    act(() => result.current.next());
    expect(result.current.index).toBe(2);
  });

  it('이미지 교체(next/prev/setIndex)는 zoom/translate 를 리셋', () => {
    const { result } = renderHook(() => useImageLightbox(3, 0));
    act(() => {
      result.current.zoomBy(-100); // 확대.
      result.current.setTranslate(50, 60);
    });
    expect(result.current.zoom).toBeGreaterThan(1);
    expect(result.current.translateX).toBe(50);
    // 이미지 교체.
    act(() => result.current.next());
    expect(result.current.zoom).toBe(1);
    expect(result.current.translateX).toBe(0);
    expect(result.current.translateY).toBe(0);
  });

  it('zoomBy 가 ZOOM_MIN~ZOOM_MAX 로 클램프(휠 업=확대, 다운=축소)', () => {
    const { result } = renderHook(() => useImageLightbox(1, 0));
    // 휠 업(deltaY<0) 1회 → 1+step.
    act(() => result.current.zoomBy(-1));
    expect(result.current.zoom).toBeCloseTo(1 + ZOOM_STEP, 5);
    // 강하게 확대 → 상한 클램프.
    act(() => {
      for (let i = 0; i < 50; i += 1) result.current.zoomBy(-1);
    });
    expect(result.current.zoom).toBe(ZOOM_MAX);
    // 강하게 축소 → 하한 클램프.
    act(() => {
      for (let i = 0; i < 50; i += 1) result.current.zoomBy(1);
    });
    expect(result.current.zoom).toBe(ZOOM_MIN);
  });

  it('setTranslate 가 절대 오프셋을 설정', () => {
    const { result } = renderHook(() => useImageLightbox(1, 0));
    act(() => result.current.setTranslate(12, -34));
    expect(result.current.translateX).toBe(12);
    expect(result.current.translateY).toBe(-34);
  });

  it('resetTransform 가 zoom=1, translate=0 으로 되돌림', () => {
    const { result } = renderHook(() => useImageLightbox(1, 0));
    act(() => {
      result.current.zoomBy(-1);
      result.current.setTranslate(10, 10);
      result.current.resetTransform();
    });
    expect(result.current.zoom).toBe(1);
    expect(result.current.translateX).toBe(0);
    expect(result.current.translateY).toBe(0);
  });
});
