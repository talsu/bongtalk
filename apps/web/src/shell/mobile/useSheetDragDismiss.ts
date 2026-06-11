import { useCallback, useRef } from 'react';
import type { RefCallback, RefObject } from 'react';

/**
 * 071-M5 H8 (정찰 ds-dormant ②) — 바텀시트 grab 드래그 닫기 공용 훅.
 *
 * grab 핸들(qf-m-sheet__grab / qf-m-emoji-drawer__grab)에 터치 드래그를 붙여
 * 시트를 손가락에 추종(translateY 직추종 — DS qf-m-panels --dragging 패턴
 * 차용)시키고, 손을 뗄 때
 *   - dy >= 60px(--m-swipe-threshold, MobilePanels 와 동일한 상수 정렬) 또는
 *   - 빠른 하향 fling
 * 이면 닫기를 커밋한다. 닫기는 반드시 기존 onClose 경로만 재사용한다 —
 * useSheetHistoryMarker 가 hardware-back 마커를 소거하는 단일 출처이므로
 * 독자 close 경로를 만들지 않는다(M3 F1 규약). 임계 미달이면 모션 토큰
 * (--m-sheet-dur/--m-sheet-ease)으로 스냅백.
 *
 * 반환값은 grab 요소에 붙일 callback ref. 시트 본문이 아닌 grab 한정인 이유:
 * 본문 세로 스크롤(DM 후보 목록·편집 이력·이모지 그리드)과의 제스처 충돌
 * 회피(정찰 ② 주의 — 이모지 드로어 본문 드래그는 스크롤과 충돌). grab 에는
 * touch-action: none 을 부여해 드래그가 브라우저 팬으로 새지 않게 한다.
 */

/** DS --m-swipe-threshold(60px) 정렬 — MobilePanels.tsx 의 상수 주석 방식. */
const DISMISS_THRESHOLD_PX = 60;
/** 하향 fling 판정 속도(px/ms) — 임계 미달이어도 빠르게 튕기면 닫기 의도. */
const FLING_VELOCITY_PX_PER_MS = 0.5;
/** fling 커밋 최소 이동량 — 탭 떨림이 fling 으로 오인되는 것을 막는다. */
const FLING_MIN_DY_PX = 24;

export function useSheetDragDismiss(
  panelRef: RefObject<HTMLElement>,
  onClose: () => void,
): RefCallback<HTMLElement> {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const cleanupRef = useRef<(() => void) | null>(null);

  return useCallback(
    (el: HTMLElement | null): void => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      if (!el) return;

      // 브라우저 팬/스크롤 차단 — 훅 자체 완결(외부 CSS 의존 없음).
      el.style.touchAction = 'none';

      let dragging = false;
      let startY = 0;
      let lastY = 0;
      let lastT = 0;
      let prevY = 0;
      let prevT = 0;

      const snapBack = (p: HTMLElement): void => {
        // 임계 미달 — 모션 토큰으로 원위치 후 인라인 스타일을 비운다.
        p.style.transition = 'transform var(--m-sheet-dur) var(--m-sheet-ease)';
        p.style.transform = '';
        const clear = (): void => {
          p.style.transition = '';
          p.removeEventListener('transitionend', clear);
        };
        p.addEventListener('transitionend', clear);
      };

      const onTouchStart = (e: TouchEvent): void => {
        if (e.touches.length !== 1) return;
        const p = panelRef.current;
        const touch = e.touches[0];
        if (!p || !touch) return;
        dragging = true;
        startY = lastY = prevY = touch.clientY;
        lastT = prevT = e.timeStamp;
        p.style.transition = 'none'; // dy 직추종(전환 없음)
      };

      const onTouchMove = (e: TouchEvent): void => {
        if (!dragging) return;
        const p = panelRef.current;
        const touch = e.touches[0];
        if (!p || !touch) return;
        prevY = lastY;
        prevT = lastT;
        lastY = touch.clientY;
        lastT = e.timeStamp;
        const dy = Math.max(0, lastY - startY); // 위로는 끌리지 않음
        p.style.transform = dy > 0 ? `translateY(${dy}px)` : '';
      };

      const onTouchEnd = (e: TouchEvent): void => {
        if (!dragging) return;
        dragging = false;
        const p = panelRef.current;
        if (!p) return;
        const dy = Math.max(0, lastY - startY);
        const dt = Math.max(1, lastT - prevT);
        // M5 리뷰 M-6 (MobilePanels M2 L-2 동형): 손가락 정지 중엔 touchmove 가
        // 안 와 속도 샘플이 과거 빠른 구간 값으로 동결된다 — 마지막 move 후
        // 100ms 이상 지났으면 fling 무효(끌다 멈춘 채 떼면 스냅백이 정답).
        const stale = e.timeStamp - lastT > 100;
        const velocity = stale ? 0 : (lastY - prevY) / dt;
        const fling = velocity >= FLING_VELOCITY_PX_PER_MS && dy >= FLING_MIN_DY_PX;
        if (dy >= DISMISS_THRESHOLD_PX || fling) {
          // 커밋 — 기존 onClose 경로(back 마커 소거 포함)로만 닫는다. 시트는
          // 호출측 상태 해제로 언마운트되므로 인라인 transform 잔류는 무해.
          p.style.transition = '';
          onCloseRef.current();
          return;
        }
        snapBack(p);
      };

      const onTouchCancel = (): void => {
        if (!dragging) return;
        dragging = false;
        const p = panelRef.current;
        if (p) snapBack(p);
      };

      // touch-action: none 이 팬을 차단하므로 preventDefault 불요 — passive 등록.
      el.addEventListener('touchstart', onTouchStart, { passive: true });
      el.addEventListener('touchmove', onTouchMove, { passive: true });
      el.addEventListener('touchend', onTouchEnd);
      el.addEventListener('touchcancel', onTouchCancel);
      cleanupRef.current = () => {
        el.removeEventListener('touchstart', onTouchStart);
        el.removeEventListener('touchmove', onTouchMove);
        el.removeEventListener('touchend', onTouchEnd);
        el.removeEventListener('touchcancel', onTouchCancel);
      };
    },
    [panelRef],
  );
}
