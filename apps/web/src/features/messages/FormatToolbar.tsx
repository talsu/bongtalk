import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from '../../design-system/primitives';
import type { ToolbarFormat } from './formatWrap';

/**
 * S83c (FR-KS-10): MessageComposer textarea 의 인라인 포맷 툴바.
 *
 * textarea 에서 텍스트를 선택하면(selectionStart !== selectionEnd) 선택 영역 위에
 * 플로팅 툴바를 띄운다. 버튼: 볼드·이탤릭·취소선·코드·코드블록·인용·링크. 각 버튼은
 * 상위(composer)의 applyToolbarFormat 으로 ToolbarFormat 키를 위임하고, composer 가
 * 기존 formatWrap 헬퍼(wrapSelectionPerLine / prefixQuote / wrapLink)로 적용한다.
 *
 * 위치: textarea.getBoundingClientRect() 기준으로 textarea 상단 바로 위에 고정 배치한다.
 * textarea 는 내부 선택 영역의 정확한 픽셀 좌표를 노출하지 않으므로(getClientRects 미지원),
 * 단어 단위 좌표 대신 textarea 상단 고정으로 결정론적으로 띄운다(UNDERSTAND 권고·뷰포트
 * 경계 보정 포함). position:fixed + 뷰포트 클램프라 스크롤 컨테이너 안에서도 안정적이다.
 *
 * S83c round-2(a11y BLOCKER 1.3.2): SR 가상 커서의 DOM 순서/스태킹을 깨지 않도록
 * createPortal 로 document.body 에 마운트한다. position:fixed 라 좌표 계산엔 영향이 없고,
 * blur 판정을 위한 toolbarRef.current?.contains(relatedTarget) 는 포털이어도 그대로 동작한다.
 * 상위(composer)가 toolbarRef 를 소유해 onBlur 에서 직접 비교하므로 DOM testid 쿼리가 불필요하다.
 *
 * 닫힘은 상위가 제어한다(선택 해제·blur). 이 컴포넌트는 Esc 를 받아 onClose 를 호출하고
 * textarea 포커스를 되돌린다. 마우스 클릭으로 선택이 풀리지 않도록 버튼은 onMouseDown 에서
 * preventDefault 한다. 상위는 toolbarRef 의 focusFirst() 로 키보드 진입(Tab)을 구현한다.
 *
 * S83c round-3(a11y BLOCKER B-1a + HIGH B-1b): WAI-ARIA toolbar 패턴 + 트랜지언트 팝업으로
 * 키보드 동작을 완성한다.
 *   - roving tabindex: 활성(현재 포커스/초기 0번) 버튼만 tabIndex=0, 나머지 -1 — 툴바 전체가
 *     단일 탭스톱이 된다. ←/→(및 ↑/↓ 동일 매핑)로 활성 인덱스를 옮기며 wrap-around 한다.
 *     Home/End 는 처음/끝으로 점프한다.
 *   - Tab/Shift+Tab 경계: 툴바는 트랜지언트 팝업이므로 Tab 은 내부 순회가 아니라 툴바를 닫고
 *     컴포저(anchor textarea)로 복귀한다(화살표가 내부 이동 담당). focusout 으로 고아 잔류하지
 *     않게 한다.
 *   - focusout 안전망: 포커스가 어떤 경로로든 툴바 밖으로 나가면(클릭아웃·프로그램적 이탈) 닫는다.
 *     단, 버튼→버튼 이동(relatedTarget 이 툴바 내부)에는 닫지 않도록 contains 가드를 둔다.
 */

interface ToolbarButton {
  format: ToolbarFormat;
  icon: IconName;
  label: string;
}

// 버튼 순서 = 방향키 이동 순서. 아이콘은 DS Icon 세트에서 가져온다(코드블록은 인라인 코드와
// 구분되도록 file-text 를 쓰고 라벨로 명확히 한다).
const BUTTONS: ToolbarButton[] = [
  { format: 'bold', icon: 'bold', label: '굵게' },
  { format: 'italic', icon: 'italic', label: '기울임' },
  { format: 'strike', icon: 'strike', label: '취소선' },
  { format: 'code', icon: 'code', label: '인라인 코드' },
  { format: 'codeBlock', icon: 'file-text', label: '코드 블록' },
  { format: 'quote', icon: 'quote', label: '인용' },
  { format: 'link', icon: 'link', label: '링크' },
];

/**
 * 상위(composer)가 toolbarRef 로 잡는 명령형 핸들. contains 는 onBlur 의 relatedTarget 비교에,
 * focusFirst 는 키보드 Tab 진입(첫 버튼 포커스)에 쓴다.
 */
export interface FormatToolbarHandle {
  /** relatedTarget 이 툴바 내부인지 — onBlur 가 툴바로의 포커스 이동을 닫힘에서 제외하는 데 쓴다. */
  contains: (_node: Node | null) => boolean;
  /** 키보드 Tab 진입 시 툴바 첫 버튼으로 포커스를 옮긴다(키보드 도달 경로). */
  focusFirst: () => void;
}

interface FormatToolbarProps {
  /** 선택 영역 위치 계산의 기준이 되는 textarea. */
  anchorRef: RefObject<HTMLTextAreaElement>;
  /** 버튼 클릭/Enter 시 호출 — 상위 composer 가 헬퍼로 서식을 적용한다. */
  onApply: (_format: ToolbarFormat) => void;
  /** Esc 또는 상위 닫힘 사유 시 호출 — 상위가 표시 상태를 끈다. */
  onClose: () => void;
}

const GAP = 8; // textarea 상단과 툴바 사이 간격(px) — 위치 계산 상수(레이아웃 토큰 아님).
const FALLBACK_HEIGHT = 40; // offsetHeight 측정 불가(첫 페인트/jsdom) 시 상단 클램프용 추정 높이.

/**
 * 툴바 위치(fixed). textarea 상단 위에 두고 뷰포트 좌/우/상단 경계로 클램프한다.
 * M-3: 우측은 (innerWidth - 툴바폭 - GAP)으로 클램프하고, 상단 높이/폭은 실측(offsetWidth/
 * Height)을 우선 쓰되 측정 불가 시 FALLBACK_HEIGHT 로 폴백한다.
 */
function computePosition(
  rect: DOMRect,
  toolbarWidth: number,
  toolbarHeight: number,
): { top: number; left: number } {
  const height = toolbarHeight > 0 ? toolbarHeight : FALLBACK_HEIGHT;
  const top = Math.max(GAP, rect.top - height - GAP);
  // 좌측은 textarea 좌측에 맞추되 뷰포트 좌/우 경계 안으로 클램프한다.
  const maxLeft = Math.max(GAP, window.innerWidth - toolbarWidth - GAP);
  const left = Math.min(Math.max(GAP, rect.left), maxLeft);
  return { top, left };
}

export const FormatToolbar = forwardRef<FormatToolbarHandle, FormatToolbarProps>(
  function FormatToolbar({ anchorRef, onApply, onClose }, ref): JSX.Element {
    const toolbarRef = useRef<HTMLDivElement>(null);
    const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

    // S83c round-3(B-1a): roving tabindex 활성 인덱스. 활성 버튼만 tabIndex=0(툴바 단일 탭스톱),
    // 나머지 -1. ←/→/↑/↓/Home/End 가 이 값을 옮기며 해당 버튼에 .focus() 한다.
    const [activeIndex, setActiveIndex] = useState(0);

    // 활성 인덱스를 옮기고 해당 버튼으로 포커스를 이동한다(roving 의 단일 진입점).
    const moveActive = useCallback((index: number): void => {
      setActiveIndex(index);
      buttonRefs.current[index]?.focus();
    }, []);

    // 상위(composer)가 onBlur 비교/키보드 진입에 쓰는 명령형 핸들. testid DOM 쿼리(brittle·
    // prod attr strip 위험)를 제거하고 ref 로 toolbar 노드를 직접 소유하게 한다(HIGH 4.1.3).
    useImperativeHandle(
      ref,
      () => ({
        contains: (node: Node | null) =>
          node ? (toolbarRef.current?.contains(node) ?? false) : false,
        // 키보드 Tab 진입 시 roving 활성 인덱스를 첫 버튼으로 재설정하고 포커스를 옮긴다.
        focusFirst: () => moveActive(0),
      }),
      [moveActive],
    );

    // 위치 계산: 마운트 시 + 윈도우 리사이즈/스크롤 시 anchor rect 기준으로 갱신한다.
    // perf(SERIOUS/MODERATE): scroll/resize 핸들러는 rAF 로 프레임당 1회만 place 하도록
    // throttle 하고(단일 rAF guard), scroll 리스너는 capture+passive 로 등록한다.
    useEffect(() => {
      let rafId: number | null = null;
      const place = (): void => {
        const anchor = anchorRef.current;
        const el = toolbarRef.current;
        if (!anchor || !el) return;
        const rect = anchor.getBoundingClientRect();
        const { top, left } = computePosition(rect, el.offsetWidth, el.offsetHeight);
        el.style.top = `${top}px`;
        el.style.left = `${left}px`;
        // N-3: 위치 확정 후 보이게 해 첫 페인트에서 좌상단(0,0)으로 튀지 않게 한다.
        el.style.visibility = 'visible';
      };
      const schedule = (): void => {
        if (rafId !== null) return; // 단일 rAF guard — 프레임당 1회.
        rafId = window.requestAnimationFrame(() => {
          rafId = null;
          place();
        });
      };
      place();
      window.addEventListener('resize', schedule, { passive: true });
      window.addEventListener('scroll', schedule, { capture: true, passive: true });
      return () => {
        if (rafId !== null) window.cancelAnimationFrame(rafId);
        window.removeEventListener('resize', schedule);
        window.removeEventListener('scroll', schedule, { capture: true });
      };
    }, [anchorRef]);

    // a11y: 방향키로 버튼 사이를 roving 순회한다(←/→ 및 일관성 위해 ↑/↓ 동일 매핑·wrap-around).
    // Home/End 는 처음/끝으로 점프한다. Esc 는 툴바를 닫고 textarea 로 포커스를 되돌린다.
    // S83c round-3(B-1b): Tab/Shift+Tab 경계 — 툴바는 트랜지언트 팝업이므로 내부 순회가 아니라
    // 툴바를 닫고 컴포저(anchor)로 복귀한다(화살표가 내부 이동 담당). 고아 잔류 방지.
    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
      if (e.key === 'Escape' || e.key === 'Tab') {
        // Esc·Tab(shift 무관) 모두 닫고 textarea 로 복귀한다.
        e.preventDefault();
        e.stopPropagation();
        onClose();
        anchorRef.current?.focus();
        return;
      }
      const count = BUTTONS.length;
      if (count === 0) return;
      const from = activeIndex;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        moveActive((from + 1) % count);
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveActive((from - 1 + count) % count);
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        moveActive(0);
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        moveActive(count - 1);
      }
    };

    // S83c round-3(B-1b focusout 안전망): 포커스가 어떤 경로로든 툴바 밖으로 나가면 닫는다
    // (클릭아웃·프로그램적 포커스 이탈로 인한 고아 잔류 방지). onClose 는 상위에서 selectionRange
    // 초기화로 이어져 showFormatToolbar=false 가 된다. 두 가드:
    //   1. 버튼→버튼 이동(relatedTarget 이 툴바 내부)에는 닫지 않는다(roving).
    //   2. anchor textarea 로의 복귀(Esc/Tab 핸들러가 이미 onClose 후 .focus() 한 의도된 이탈)는
    //      이미 닫혔으므로 중복 onClose 를 막는다(닫힘 자체는 동일하게 보장된다).
    const onBlur = (e: React.FocusEvent<HTMLDivElement>): void => {
      const next = e.relatedTarget as Node | null;
      if (toolbarRef.current?.contains(next)) return;
      if (next && next === anchorRef.current) return;
      onClose();
    };

    // S83c round-2(a11y 1.3.2): SR 가상 커서 순서/스태킹을 위해 document.body 포털로 마운트.
    // position:fixed 라 좌표는 effect 가 anchor rect 기준으로 채운다. 초기 visibility:hidden 으로
    // 첫 페인트에서 좌상단으로 튀는 것을 막고(N-3), place() 가 'visible' 로 전환한다.
    return createPortal(
      <div
        ref={toolbarRef}
        role="toolbar"
        aria-label="텍스트 서식 (방향키로 이동, Esc로 닫기)"
        data-testid="format-toolbar"
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        className="fixed z-[var(--z-dropdown)] flex items-center gap-[var(--s-1)] rounded-[var(--r-md)] border border-border-subtle bg-bg-surface p-[var(--s-1)] shadow-elev-2"
        style={{ top: 0, left: 0, visibility: 'hidden' }}
      >
        {BUTTONS.map((btn, i) => (
          <button
            key={btn.format}
            ref={(node) => {
              buttonRefs.current[i] = node;
            }}
            type="button"
            aria-label={btn.label}
            data-testid={`format-toolbar-${btn.format}`}
            // S83c round-3(B-1a roving tabindex): 활성 버튼만 0, 나머지 -1 — 툴바 전체가 단일
            // 탭스톱이 되고 내부 이동은 화살표가 담당한다(WAI-ARIA toolbar 패턴).
            tabIndex={i === activeIndex ? 0 : -1}
            className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
            // 선택 유지: 클릭으로 textarea selection 이 풀리지 않도록 기본 동작을 막는다.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onApply(btn.format)}
          >
            <Icon name={btn.icon} size="sm" />
          </button>
        ))}
      </div>,
      document.body,
    );
  },
);

FormatToolbar.displayName = 'FormatToolbar';
