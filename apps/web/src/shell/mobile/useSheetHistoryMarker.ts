import { useEffect, useRef } from 'react';

/**
 * 071-M3 F1 — 모바일 시트/오버레이 공용 하드웨어 back 마커.
 *
 * MobilePanels 의 popstate 패턴을 일반화한다: 시트가 열릴 때 history 마커를
 * push 해 하드웨어 back 이 화면 이탈 대신 시트만 닫고, back 이외 경로(백드롭
 * 탭/닫기 버튼)로 닫힐 땐 **마커가 스택 최상단일 때만** 소거(back)한다 —
 * 시트 안에서 라우터 네비게이션이 일어난 직후 무조건 back() 하면 방금의
 * 이동을 되감는 함정(M2 E2 채널 픽 회귀)과 동일 계열을 봉인한다.
 *
 * 신규 모바일 시트(서버 메뉴/채널 롱프레스/프로필 등)는 독자 popstate 구현
 * 대신 반드시 이 훅을 사용한다(MobilePanels 마커와의 꼬임 방지 단일 출처).
 */
export function useSheetHistoryMarker(open: boolean, onClose: () => void): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const markerRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    window.history.pushState({ qfSheet: true }, '');
    markerRef.current = true;
    const onPop = (): void => {
      markerRef.current = false;
      onCloseRef.current();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (markerRef.current) {
        markerRef.current = false;
        const st = window.history.state as { qfSheet?: boolean } | null;
        if (st?.qfSheet) window.history.back();
      }
    };
  }, [open]);
}
