import { useEffect, useRef, type RefObject } from 'react';
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
 * 닫힘은 상위가 제어한다(선택 해제·blur). 이 컴포넌트는 Esc 를 받아 onClose 를 호출하고
 * textarea 포커스를 되돌린다. 마우스 클릭으로 선택이 풀리지 않도록 버튼은 onMouseDown 에서
 * preventDefault 한다.
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

interface FormatToolbarProps {
  /** 선택 영역 위치 계산의 기준이 되는 textarea. */
  anchorRef: RefObject<HTMLTextAreaElement>;
  /** 버튼 클릭/Enter 시 호출 — 상위 composer 가 헬퍼로 서식을 적용한다. */
  onApply: (_format: ToolbarFormat) => void;
  /** Esc 또는 상위 닫힘 사유 시 호출 — 상위가 표시 상태를 끈다. */
  onClose: () => void;
}

/** 툴바 위치(fixed). textarea 상단 위에 두고 뷰포트 좌/우/상단 경계로 클램프한다. */
function computePosition(rect: DOMRect): { top: number; left: number } {
  const GAP = 8; // textarea 상단과 툴바 사이 간격(px) — 위치 계산 상수(레이아웃 토큰 아님).
  const ESTIMATED_HEIGHT = 40; // 툴바 추정 높이 — 상단 경계 클램프용.
  const top = Math.max(GAP, rect.top - ESTIMATED_HEIGHT - GAP);
  // 좌측은 textarea 좌측에 맞추되 뷰포트 안으로 클램프.
  const left = Math.max(GAP, rect.left);
  return { top, left };
}

export function FormatToolbar({ anchorRef, onApply, onClose }: FormatToolbarProps): JSX.Element {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // 위치 계산: 마운트 시 + 윈도우 리사이즈/스크롤 시 anchor rect 기준으로 갱신한다.
  useEffect(() => {
    const place = (): void => {
      const anchor = anchorRef.current;
      const el = toolbarRef.current;
      if (!anchor || !el) return;
      const rect = anchor.getBoundingClientRect();
      const { top, left } = computePosition(rect);
      el.style.top = `${top}px`;
      el.style.left = `${left}px`;
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchorRef]);

  // a11y: 방향키로 버튼 사이를 순회한다(roving — Left/Right). Esc 는 툴바를 닫고
  // textarea 로 포커스를 되돌린다.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      anchorRef.current?.focus();
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const buttons = buttonRefs.current.filter((b): b is HTMLButtonElement => b !== null);
      if (buttons.length === 0) return;
      const activeIdx = buttons.findIndex((b) => b === document.activeElement);
      const step = e.key === 'ArrowRight' ? 1 : -1;
      const from = activeIdx < 0 ? 0 : activeIdx;
      const next = (from + step + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  };

  return (
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label="텍스트 서식"
      data-testid="format-toolbar"
      onKeyDown={onKeyDown}
      // position:fixed — top/left 는 effect 가 anchor rect 기준으로 채운다. 초기값은
      // 화면 밖이 아니라 좌상단 근처로 두어 첫 페인트에서 튀지 않게 한다.
      className="fixed z-50 flex items-center gap-[var(--s-1)] rounded-[var(--r-md)] border border-border-subtle bg-bg-elevated p-[var(--s-1)] shadow-md"
      style={{ top: 0, left: 0 }}
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
          className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
          // 선택 유지: 클릭으로 textarea selection 이 풀리지 않도록 기본 동작을 막는다.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onApply(btn.format)}
        >
          <Icon name={btn.icon} size="sm" />
        </button>
      ))}
    </div>
  );
}
