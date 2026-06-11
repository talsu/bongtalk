import { useEffect, useRef, useState, type ReactNode, type TouchEvent } from 'react';
import { cn } from '../../lib/cn';
import { SHEET_FOCUSABLE_SELECTOR } from './useSheetFocusTrap';

/**
 * 071-M2 E2 (A안 / PRD §02) — OverlappingPanels 3패널 셸.
 *
 * DS mobile.css 420~491 의 `.qf-m-panels` 스펙을 그대로 구동한다:
 *   - 상태 수식자 `--show-left` / `--show-right` 가 각 패널 transform 을 제어.
 *   - 드래그 중 `--dragging`(transition:none) + 인라인 transform 으로 손가락 추종.
 *   - 손 뗄 때 `--snapping` 으로 transition 복원 후 목표 상태로 스냅.
 *   - fling: |vx| > 500px/s 이면 거리와 무관하게 진행 방향으로 커밋.
 *   - 커밋 임계: --m-swipe-threshold(60px) 이상 끌면 커밋, 미만이면 원복.
 *   - 스크림은 center 내부(DS 목업 동일) — 탭하면 닫기, 드래그 진행도에 opacity 추종.
 *
 * 상태는 외부 제어형(open/onOpenChange) — 셸이 라우트 전환 시 'center' 로 닫는다.
 * 열림 상태는 history 마커를 push 해 하드웨어 back 이 패널만 닫는다(MobileOverlay
 * 의 popstate 패턴 — M0 C2 계열 UX 유지).
 *
 * 제스처 판정은 전부 ref 로 한다(M0 비결: state 클로저 판정 금지).
 */
export type PanelSide = 'center' | 'left' | 'right';

const FLING_VX = 500; // px/s — DS 스펙
/**
 * 엣지 스와이프 시작 인식 폭. 행 단위 제스처(MobileMessageRow 스와이프 답장)가
 * 이 영역에서 시작한 터치를 양보해 패널 오픈과 이중 커밋되지 않도록 export 한다
 * (M2 리뷰 M-1).
 */
export const PANEL_EDGE_PX = 24;
const DIR_LOCK_PX = 10; // 방향 잠금 판정 최소 이동

export function MobilePanels({
  open,
  onOpenChange,
  left,
  right,
  children,
}: {
  open: PanelSide;
  onOpenChange: (next: PanelSide) => void;
  /** 좌 패널(서버레일+채널 목록). */
  left: ReactNode;
  /** 우 패널(멤버 목록). null 이면 우 패널 비활성(엣지 제스처도 무시). */
  right: ReactNode | null;
  /** 중앙 패널(topbar+본문+탭바). */
  children: ReactNode;
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const centerRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);

  // --dragging / --snapping 은 렌더 경로 밖(직접 classList)에서 토글하면 React 와
  // 충돌하므로 state 로 둔다. 단 제스처 판정 자체는 전부 ref.
  const [dragging, setDragging] = useState(false);
  const [snapping, setSnapping] = useState(false);

  const openRef = useRef(open);
  openRef.current = open;
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const hasRight = right !== null;
  const hasRightRef = useRef(hasRight);
  hasRightRef.current = hasRight;

  // 제스처 상태(전부 ref — 이벤트 핸들러는 리렌더와 무관하게 최신값을 본다).
  const gestureRef = useRef<{
    startX: number;
    startY: number;
    lastX: number;
    lastT: number;
    vx: number;
    locked: 'h' | 'v' | null;
    /** 이 드래그가 조작 중인 패널. */
    target: 'left' | 'right' | null;
    /** 드래그 시작 시점의 open 상태. */
    from: PanelSide;
  } | null>(null);

  const panelWidth = (side: 'left' | 'right'): number => {
    const el = side === 'left' ? leftRef.current : rightRef.current;
    return el?.offsetWidth ?? 0;
  };

  /** 진행도 p(0=닫힘, 1=열림)를 인라인 transform 으로 반영. */
  const applyProgress = (side: 'left' | 'right', p: number): void => {
    const clamped = Math.max(0, Math.min(1, p));
    const w = panelWidth(side);
    const panel = side === 'left' ? leftRef.current : rightRef.current;
    const center = centerRef.current;
    const scrim = scrimRef.current;
    if (!panel || !center) return;
    if (side === 'left') {
      panel.style.transform = `translateX(${-(1 - clamped) * 100}%)`;
      center.style.transform = `translateX(${clamped * w}px)`;
    } else {
      panel.style.transform = `translateX(${(1 - clamped) * 100}%)`;
      center.style.transform = `translateX(${-clamped * w}px)`;
    }
    if (scrim) {
      scrim.style.opacity = String(clamped);
      scrim.style.pointerEvents = clamped > 0 ? 'auto' : 'none';
    }
  };

  /** 인라인 스타일 제거 — CSS 상태 수식자(--show-*)가 다시 권위를 갖는다. */
  const clearInline = (): void => {
    for (const el of [leftRef.current, rightRef.current, centerRef.current]) {
      if (el) el.style.transform = '';
    }
    const scrim = scrimRef.current;
    if (scrim) {
      scrim.style.opacity = '';
      scrim.style.pointerEvents = '';
    }
  };

  const endDrag = (commitTo: PanelSide): void => {
    setDragging(false);
    setSnapping(true);
    clearInline();
    if (commitTo !== openRef.current) onOpenChangeRef.current(commitTo);
    // transition(--m-panel-dur) 종료 후 --snapping 해제. transitionend 는 패널
    // 3개에서 중복 발화하므로 타이머가 단순·결정적이다(dur-slow ≈ 300ms + 여유).
    window.setTimeout(() => setSnapping(false), 400);
  };

  const onTouchStart = (e: TouchEvent): void => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const w = rootRef.current?.clientWidth ?? window.innerWidth;
    const cur = openRef.current;
    let target: 'left' | 'right' | null = null;
    if (cur === 'left') target = 'left';
    else if (cur === 'right') target = 'right';
    else if (t.clientX <= PANEL_EDGE_PX) target = 'left';
    else if (t.clientX >= w - PANEL_EDGE_PX && hasRightRef.current) target = 'right';
    if (target === 'right' && !hasRightRef.current) target = null;
    if (!target) return;
    gestureRef.current = {
      startX: t.clientX,
      startY: t.clientY,
      lastX: t.clientX,
      lastT: performance.now(),
      vx: 0,
      locked: null,
      target,
      from: cur,
    };
  };

  const onTouchMove = (e: TouchEvent): void => {
    const g = gestureRef.current;
    if (!g) return;
    const t = e.touches[0];
    const dx = t.clientX - g.startX;
    const dy = t.clientY - g.startY;
    if (g.locked === null) {
      if (Math.abs(dx) < DIR_LOCK_PX && Math.abs(dy) < DIR_LOCK_PX) return;
      // 세로 우세면 패널 드래그 포기(touch-action: pan-y — 스크롤에 양보).
      g.locked = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
      if (g.locked === 'h') setDragging(true);
    }
    if (g.locked !== 'h') return;
    // 속도 추적(fling 판정용) — 직전 샘플 대비.
    const now = performance.now();
    const dt = now - g.lastT;
    if (dt > 0) g.vx = ((t.clientX - g.lastX) / dt) * 1000;
    g.lastX = t.clientX;
    g.lastT = now;
    // 진행도: 열림 기준 0→1. (from 상태에 따라 드래그 방향이 진행/후퇴를 결정)
    const w = panelWidth(g.target!);
    if (w === 0) return;
    if (g.target === 'left') {
      const p = g.from === 'left' ? 1 + dx / w : dx / w;
      applyProgress('left', p);
    } else {
      const p = g.from === 'right' ? 1 - dx / w : -dx / w;
      applyProgress('right', p);
    }
  };

  const onTouchEnd = (): void => {
    const g = gestureRef.current;
    gestureRef.current = null;
    if (!g || g.locked !== 'h' || !g.target) {
      if (g?.locked === 'h') setDragging(false);
      return;
    }
    const dx = g.lastX - g.startX;
    const threshold = 60; // --m-swipe-threshold
    // M2 리뷰 L-2: 빠르게 끌다 멈춘 채(이벤트 미발생) 손을 떼면 마지막 샘플의
    // 과거 속도로 fling 이 오판된다 — 100ms 이상 정지했으면 fling 무효.
    const vx = performance.now() - g.lastT > 100 ? 0 : g.vx;
    let commit: PanelSide;
    if (Math.abs(vx) > FLING_VX) {
      // fling — 진행 방향이 곧 결론.
      if (g.target === 'left') commit = vx > 0 ? 'left' : 'center';
      else commit = vx < 0 ? 'right' : 'center';
    } else if (g.from === 'center') {
      // 열기 제스처: 임계 이상 끌었으면 열기.
      const opened = g.target === 'left' ? dx : -dx;
      commit = opened >= threshold ? g.target : 'center';
    } else {
      // 닫기 제스처: 임계 이상 반대로 끌었으면 닫기.
      const closed = g.from === 'left' ? -dx : dx;
      commit = closed >= threshold ? 'center' : g.from;
    }
    endDrag(commit);
  };

  // 071-M3 F1 (M2 리뷰 L-7④): aria-hidden 패널은 inert 로 포커스/클릭까지 차단한다.
  // @types/react 18 에 inert prop 타입이 없어 ref 로 DOM 속성을 직접 설정한다.
  useEffect(() => {
    const setInert = (el: HTMLDivElement | null, hidden: boolean): void => {
      if (el) (el as HTMLDivElement & { inert: boolean }).inert = hidden;
    };
    setInert(leftRef.current, open !== 'left' && !dragging);
    setInert(rightRef.current, open !== 'right' && !dragging);
  }, [open, dragging]);

  // 071-M5 H6 (감사 B-107 잔여): 패널 열림 시 열린 패널의 첫 포커서블로 자동
  // 포커스 + 닫힘 시 열기 직전 activeElement(topbar 트리거 등)로 복귀. center 는
  // inert 로 만들 수 없으므로(닫기 스크림/topbar 가 center 내부 — 정찰 함정 명시)
  // 포커스 이동만 보장한다. left↔right 직접 전환에도 최초 트리거를 유지하도록
  // 복귀 대상은 비어 있을 때만 캡처한다. ★위 inert 해제 effect 뒤에 선언해야
  // 같은 커밋에서 inert 가 먼저 풀려 포커스가 들어간다(effect 선언 순서 의존).
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // ★M6 T5 (세션 장기 미스터리 규명): focus() 기본 동작은 조상 스크롤 —
    // transform 전환과 경합하면 overflow:hidden 루트에 scrollLeft(+240)가
    // 잔류해 center 가 화면 밖으로 밀린다(겉보기 '우패널 열림' + 행 좌표
    // 음수 → 메시지 롱프레스의 엣지 양보가 시트 오픈을 스킵). preventScroll
    // 필수 + 아래 보정 effect 가 이중 방어.
    if (open === 'center') {
      const restore = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (restore && document.contains(restore)) restore.focus({ preventScroll: true });
      return;
    }
    if (!restoreFocusRef.current) {
      restoreFocusRef.current = document.activeElement as HTMLElement | null;
    }
    const panel = open === 'left' ? leftRef.current : rightRef.current;
    panel?.querySelector<HTMLElement>(SHEET_FOCUSABLE_SELECTOR)?.focus({ preventScroll: true });
  }, [open]);

  // M6 T5: scrollLeft 잔류 보정 — 어떤 경로(포커스/브라우저 자동 스크롤)로든
  // overflow:hidden 루트가 스크롤되면 패널 좌표계 전체가 틀어진다. 전환 정착
  // 시점마다 0 으로 강제.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (root.scrollLeft !== 0) root.scrollLeft = 0;
    const onScroll = (): void => {
      if (root.scrollLeft !== 0) root.scrollLeft = 0;
    };
    root.addEventListener('scroll', onScroll);
    return () => root.removeEventListener('scroll', onScroll);
  }, [open]);

  // 하드웨어 back: 패널 열림 시 마커 push — back 은 패널만 닫는다(MobileOverlay 패턴).
  const markerRef = useRef(false);
  useEffect(() => {
    if (open === 'center') return;
    window.history.pushState({ qfPanel: open }, '');
    markerRef.current = true;
    const onPop = (): void => {
      // 071-M3 F5: 패널 위에 시트(useSheetHistoryMarker)가 떠 있을 때 시트 마커가
      // pop 되면(도착 state 가 여전히 qfPanel) 패널은 유지한다 — 계층 구분 없이
      // 닫으면 시트 닫기 back 이 패널까지 끌어내린다.
      const st = window.history.state as { qfPanel?: string } | null;
      if (st?.qfPanel) return;
      markerRef.current = false;
      onOpenChangeRef.current('center');
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      // 패널이 back 이 아닌 경로(스크림 탭/스와이프)로 닫히면 마커를 소거해 다음
      // back 이 화면을 이탈하지 않게 한다. 단 **마커가 스택 최상단일 때만**
      // (history.state 에 qfPanel 이 남아 있을 때) — 채널 픽처럼 라우터가 이미 새
      // 엔트리를 push 한 뒤 무조건 back() 하면 방금 일어난 네비게이션을 되돌려
      // 채널 전환이 무효가 된다(E2 프로브에서 실측된 회귀).
      if (markerRef.current) {
        markerRef.current = false;
        const st = window.history.state as { qfPanel?: string } | null;
        if (st?.qfPanel) window.history.back();
      }
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      data-testid="mobile-panels"
      data-open={open}
      className={cn(
        'qf-m-panels',
        open === 'left' && 'qf-m-panels--show-left',
        open === 'right' && 'qf-m-panels--show-right',
        dragging && 'qf-m-panels--dragging',
        snapping && 'qf-m-panels--snapping',
      )}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <div
        ref={leftRef}
        data-testid="mobile-panel-left"
        className="qf-m-panel-left overflow-y-auto"
        aria-hidden={open !== 'left' && !dragging ? true : undefined}
      >
        {left}
      </div>
      <div ref={centerRef} data-testid="mobile-panel-center" className="qf-m-panel-center">
        {children}
        <div
          ref={scrimRef}
          data-testid="mobile-panel-scrim"
          className="qf-m-drawer-scrim"
          onClick={() => onOpenChangeRef.current('center')}
        />
      </div>
      <div
        ref={rightRef}
        data-testid="mobile-panel-right"
        className="qf-m-panel-right overflow-y-auto"
        aria-hidden={open !== 'right' && !dragging ? true : undefined}
      >
        {right}
      </div>
    </div>
  );
}
