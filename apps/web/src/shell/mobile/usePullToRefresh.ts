import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/**
 * 071-M5 H21 (정찰 ds-dormant ⑤ — DS qf-m-ptr 채택) — 당겨서 새로고침 공용 훅.
 *
 * 스크롤 컨테이너가 최상단(scrollTop 0)일 때 시작된 하향 당김이 임계
 * (dy > 60px — DS --m-swipe-threshold 정렬, MobilePanels/useSheetDragDismiss 의
 * 상수 주석 방식)를 넘으면 손을 뗄 때 onRefresh 를 발화하고, Promise 정착까지
 * refreshing=true 를 반환한다. 호출부는 refreshing 동안 DS 스피너
 * (.qf-m-ptr > .qf-m-ptr__spin — mobile.css 정의, 앱 채택 0건이던 dormant 클래스)
 * 를 리스트 상단에 렌더한다.
 *
 * 적용 표면은 인박스/활동 계열 한정(1순위 MobileActivity) — 메시지 리스트는
 * useScrollFetch(상단 도달 older 페이지네이션)가 같은 제스처 의미를 이미 소유해
 * 비대상(정찰 판정·excluded 확정).
 *
 * 브라우저 네이티브 당김(새로고침/글리치)과의 충돌은 overscroll-behavior-y:contain
 * 으로 차단한다 — DS .qf-m-body 가 이미 contain 을 주지만 훅 자체 완결을 위해
 * 컨테이너에 직접 보장한다(useSheetDragDismiss 의 touch-action 자기완결 선례).
 */

/** DS --m-swipe-threshold(60px) 정렬 — JS 미러(MobilePanels.tsx 주석 문서화 방식). */
const REFRESH_THRESHOLD_PX = 60;

export function usePullToRefresh(
  scrollRef: RefObject<HTMLElement>,
  onRefresh: () => Promise<unknown>,
): boolean {
  const [refreshing, setRefreshing] = useState(false);
  // 최신 콜백 참조 — 리스너 재부착 없이 항상 최신 refetch 묶음을 부른다
  // (M-1 onCloseRef 패턴과 동일).
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;
  // 진행 중 재진입 가드(state 는 비동기라 ref 로 동기 판정).
  const busyRef = useRef(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.style.overscrollBehaviorY = 'contain';

    let startY: number | null = null;

    const onTouchStart = (e: TouchEvent): void => {
      // 최상단에서 시작한 터치만 PTR 후보 — 중간 스크롤 위치의 당김은 일반 스크롤.
      if (busyRef.current || el.scrollTop > 0) {
        startY = null;
        return;
      }
      startY = e.touches[0].clientY;
    };
    const onTouchMove = (): void => {
      // 후보 상태에서 사용자가 아래로 스크롤해 버리면(내용 이동) 후보 해제 —
      // 임계 계산이 스크롤 거리와 섞이지 않게 한다.
      if (startY !== null && el.scrollTop > 0) startY = null;
    };
    const onTouchEnd = (e: TouchEvent): void => {
      if (startY === null) return;
      const dy = e.changedTouches[0].clientY - startY;
      startY = null;
      if (dy <= REFRESH_THRESHOLD_PX) return;
      busyRef.current = true;
      setRefreshing(true);
      void Promise.resolve(onRefreshRef.current()).finally(() => {
        busyRef.current = false;
        setRefreshing(false);
      });
    };
    const onTouchCancel = (): void => {
      startY = null;
    };

    // preventDefault 미사용 — 전부 passive 로 스크롤 성능 영향 없음.
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchCancel, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchCancel);
    };
  }, [scrollRef]);

  return refreshing;
}
