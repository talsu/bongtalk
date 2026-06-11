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
    const onPop = (e: PopStateEvent): void => {
      // M6 T5 (★풀스위트 flake 근본 원인): 패널 마커 소거 back()은 비동기
      // 트래버설 — 부하로 지연 도착하면 그 사이 push 된 이 시트 마커를 대신
      // 소비한다(도착 state 가 stale qfPanel 엔트리). 이때 시트를 닫지 않고
      // stale 엔트리를 qfSheet 마커로 재전환해 스택 깊이·시트를 모두 보존한다
      // (MobilePanels onPop 의 qfPanel 계층 가드와 대칭).
      const st = e.state as { qfPanel?: string } | null;
      if (st?.qfPanel) {
        window.history.replaceState({ qfSheet: true }, '');
        return;
      }
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

/**
 * 071-M5 S6 회귀 수리 — 시트→시트 전환 핸드셰이크.
 *
 * 닫히는 시트의 마커 소거(history.back — 비동기 트래버설)가 곧바로 push 된
 * 다음 시트의 qfSheet 마커를 pop 해 즉시 닫아버리는 레이스(M3 F2 패널판과
 * 동일 계열 — MobileMessageSheet 가 M5 에서 마커를 갖게 되며 표면화).
 * close 직후 popstate 소화를 기다렸다가 open 한다(마커가 없었으면 즉시,
 * 소거가 스킵된 경우는 200ms 안전망 — MobileShell.afterMarkerSettles 동형).
 */
export function transitionSheetMarker(close: () => void, open: () => void): void {
  const had = (window.history.state as { qfSheet?: boolean } | null)?.qfSheet === true;
  close();
  if (!had) {
    open();
    return;
  }
  let fired = false;
  const fire = (): void => {
    if (fired) return;
    fired = true;
    window.removeEventListener('popstate', fire);
    open();
  };
  window.addEventListener('popstate', fire);
  window.setTimeout(fire, 200);
}
