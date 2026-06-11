import { useEffect, useRef } from 'react';
import { Icon } from '../../design-system/primitives';
import { useSheetFocusTrap } from './useSheetFocusTrap';
import { useSheetHistoryMarker } from './useSheetHistoryMarker';
import { useSheetDragDismiss } from './useSheetDragDismiss';

/**
 * 071-M5 H5 (감사 A-30 / FR-IA-A11Y-01) — 파괴적 액션 공용 confirm 바텀시트.
 *
 * MobileYouTab 로그아웃 confirm 패턴의 일반화: role=alertdialog + aria-modal +
 * aria-labelledby/describedby, 취소 첫 포커스(A-30 alertdialog 요건 — DOM 은
 * 파괴 액션 먼저인 시트 레이아웃 유지), 공용 트랩(H3) + back 마커(M3 F1 규약).
 * 확인 시에만 onConfirm 을 호출하고 닫기는 호출측 onClose 단일 경로다.
 *
 * 주의: 시트 안 인라인 2-step armed(메시지 삭제·워크스페이스 나가기)는 PRD 대체
 * 패턴으로 현행 유지 — 이 컴포넌트로 교체하지 않는다(회귀 면적 최소화).
 */
export function MobileConfirmSheet({
  testId,
  title,
  body,
  confirmLabel,
  confirmIcon = 'trash',
  onConfirm,
  onClose,
}: {
  /** 루트 data-testid (예: mobile-friend-remove-confirm). */
  testId: string;
  /** alertdialog 제목(aria-labelledby 연결). */
  title: string;
  /** 결과 설명 카피(aria-describedby 연결). */
  body: string;
  /** 파괴 확정 버튼 카피(예: 삭제 / 차단). */
  confirmLabel: string;
  confirmIcon?: Parameters<typeof Icon>[0]['name'];
  onConfirm: () => void;
  onClose: () => void;
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useSheetFocusTrap(panelRef, onClose, { initialFocus: () => cancelRef.current });
  useSheetHistoryMarker(true, onClose);
  // 071-M5 H8 (정찰 ②): grab 드래그 닫기 — 임계 통과 시 기존 onClose 경로만 재사용.
  const grabRef = useSheetDragDismiss(panelRef, onClose);
  // M5 리뷰 M-11: 등장 모션(220ms) 중에는 파괴 확정 입력을 무시한다 — 트리거
  // 버튼과 같은 화면 띠로 시트가 올라와 더블탭/손가락 바운스가 submit 에
  // 착지하는 무확인 확정 사고 봉인(armed 시간은 모션+여유).
  const armedAtRef = useRef(0);
  useEffect(() => {
    armedAtRef.current = Date.now() + 300;
  }, []);
  const titleId = `${testId}-title`;
  const bodyId = `${testId}-body`;
  return (
    <div
      data-testid={testId}
      className="fixed inset-0 z-[var(--z-modal,60)]"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
    >
      {/* 071-M5 H7 (정찰 ①): 등장 모션 — 백드롭 fade + 시트 slide-up(enter-only). */}
      <div className="qf-m-sheet-backdrop qfa-backdrop-in absolute inset-0" onClick={onClose} />
      <div
        ref={panelRef}
        className="qf-m-sheet qfa-sheet-in qf-m-safe-bottom absolute bottom-0 left-0 right-0 z-[var(--z-modal)]"
      >
        <div ref={grabRef} className="qf-m-sheet__grab" aria-hidden />
        <div className="qf-m-section">
          <div id={titleId}>{title}</div>
        </div>
        <p
          id={bodyId}
          className="px-[var(--s-4)] pb-[var(--s-2)] text-[length:var(--fs-13)] text-text-muted"
        >
          {body}
        </p>
        <button
          type="button"
          data-testid={`${testId}-submit`}
          className="qf-m-sheet__item qf-m-sheet__item--danger"
          onClick={() => {
            if (Date.now() < armedAtRef.current) return;
            onConfirm();
          }}
        >
          <span className="qf-m-sheet__icon">
            <Icon name={confirmIcon} size="sm" />
          </span>
          <span>{confirmLabel}</span>
        </button>
        <button
          type="button"
          ref={cancelRef}
          data-testid={`${testId}-cancel`}
          className="qf-m-sheet__item"
          onClick={onClose}
        >
          <span className="qf-m-sheet__icon">
            <Icon name="x" size="sm" />
          </span>
          <span>취소</span>
        </button>
      </div>
    </div>
  );
}
