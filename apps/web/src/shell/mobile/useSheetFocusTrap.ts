import { useEffect, useRef, type RefObject } from 'react';

/**
 * 071-M5 H3 (감사 A-30/B-108 계열) — 모바일 시트/드로어 공용 포커스 트랩.
 *
 * MobileMessageSheet(071-M1 D9)의 트랩 블록을 정본 추출했다:
 *   - 열릴 때 첫 포커서블(또는 opts.initialFocus)로 포커스 이동.
 *   - Tab/Shift+Tab 은 패널 안에서 순환(WAI-ARIA dialog 패턴).
 *   - Escape 로 닫기(onClose).
 *   - 닫힐 때(언마운트) 열기 직전 활성 요소로 포커스 복귀.
 *
 * M1 리뷰 M-1: 이 효과는 **마운트 1회**여야 한다. deps 에 onClose 를 두면 부모가
 * 인라인 콜백을 넘길 때 재렌더마다 cleanup(포커스 복귀)+재설치(복귀 대상
 * 덮어쓰기·첫 포커서블 포커스 강탈)가 반복된다 — 최신 onClose/initialFocus 는
 * ref 로 읽는다. 따라서 이 훅은 시트가 **조건부 마운트되는 컴포넌트** 안에서
 * 호출해야 한다(열림/닫힘을 prop 으로 받는 상시 마운트 컴포넌트엔 부적합).
 *
 * useSheetHistoryMarker(하드웨어 back)와는 합치지 않는다 — marker 는 상시 마운트
 * 컴포넌트에서 open prop 으로도 쓰여 수명주기가 다르다. 시트 컴포넌트에서 두 훅을
 * 나란히 호출한다.
 */
export interface SheetFocusTrapOptions {
  /**
   * 열릴 때 첫 포커스 대상(미지정 시 패널 내 첫 포커서블). 로그아웃/삭제 confirm
   * 의 '취소 첫 포커스'(A-30 alertdialog 요건), 편집 시트의 textarea 캐럿 등.
   */
  initialFocus?: () => HTMLElement | null;
}

/**
 * 시트 안에서 Tab 순환 대상으로 삼는 포커서블 셀렉터(disabled 제외).
 * 071-M5 H6: MobilePanels(비모달 드로어 — 트랩 없이 자동 포커스/복귀만)도
 * 동일 기준을 쓰도록 export 한다.
 */
export const SHEET_FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]';

export function useSheetFocusTrap(
  panelRef: RefObject<HTMLElement>,
  onClose: () => void,
  opts?: SheetFocusTrapOptions,
): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const initialFocusRef = useRef(opts?.initialFocus);
  initialFocusRef.current = opts?.initialFocus;

  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const focusables = (): HTMLElement[] =>
      Array.from(panel?.querySelectorAll<HTMLElement>(SHEET_FOCUSABLE_SELECTOR) ?? []);
    const initial = initialFocusRef.current?.() ?? focusables()[0] ?? null;
    if (initial) {
      initial.focus();
    } else if (panel) {
      // focusable 0개 폴백 — 패널 자체를 포커스해 트랩 앵커를 확보한다
      // (스크린리더가 dialog 진입을 인지, Tab 누설 방지).
      panel.tabIndex = -1;
      panel.focus();
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const list = focusables();
      if (list.length === 0) {
        // 포커서블이 없으면 Tab 이 배경으로 새지 않게 막는다(패널 폴백 포커스 유지).
        e.preventDefault();
        return;
      }
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panel?.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel?.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      restore?.focus?.();
    };
    // 마운트 1회 — 최신 onClose/initialFocus 는 ref 경유(M1 리뷰 M-1 패턴).
  }, []);
}
