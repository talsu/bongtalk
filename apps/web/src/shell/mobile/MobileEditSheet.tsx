import { useRef, useState } from 'react';
import type { MessageDto } from '@qufox/shared-types';
import { useSheetFocusTrap } from './useSheetFocusTrap';
import { useSheetHistoryMarker } from './useSheetHistoryMarker';
import { useSheetDragDismiss } from './useSheetDragDismiss';

/**
 * S103 (FR-MSG-06 모바일): 메시지 편집 바텀시트. 데스크톱 MessageItem 인라인
 * 편집(useUpdateMessage)의 모바일 대응 — 모바일은 hover 툴바가 없어 long-press
 * 시트의 '메시지 편집' 액션이 이 시트를 띄운다. textarea 에 현재 본문을 채우고
 * 저장 시 부모가 `updMut.mutateAsync({ msgId, content, expectedVersion })` 로
 * 낙관적 잠금 PATCH 를 보낸다(충돌/대규모-멘션 토스트는 훅이 처리).
 *
 * DS qf-m-sheet / qf-m-composer__input 클래스를 재사용한다(raw hex/px 금지).
 * 저장 버튼은 빈 본문·변경 없음·전송 중이면 비활성. Escape 로 취소(시트 패턴).
 */
export function MobileEditSheet({
  msg,
  onCancel,
  onSave,
}: {
  msg: MessageDto;
  onCancel: () => void;
  // 저장 본문(trim 됨)을 부모에 넘긴다. 부모가 mutateAsync 를 await 하고 성공 시
  // 시트를 닫는다. reject(충돌/검증 실패) 시 시트를 유지해 사용자가 재시도/취소할 수
  // 있게 한다(훅이 토스트로 사유를 안내).
  onSave: (content: string) => Promise<void>;
}): JSX.Element {
  const original = msg.content ?? '';
  const [draft, setDraft] = useState(original);
  const [saving, setSaving] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // 071-M5 H4 (감사 A-30): 종전 Esc 단독 effect 를 공용 트랩으로 교체 — Tab 이
  // 배경으로 새던 누설 + 닫힘 시 트리거 복귀 부재를 함께 해소한다. 진입 포커스는
  // initialFocus 콜백으로 이전(캐럿을 끝에 두고 textarea 포커스 — 편집 즉시 가능).
  useSheetFocusTrap(panelRef, onCancel, {
    initialFocus: () => {
      const ta = taRef.current;
      if (ta) {
        const end = ta.value.length;
        ta.setSelectionRange(end, end);
      }
      return ta;
    },
  });
  // 071-M5 H4 (M3 F1 규약): 하드웨어 back 이 화면 이탈 대신 편집 시트만 닫는다.
  useSheetHistoryMarker(true, onCancel);
  // 071-M5 H8 (정찰 ②): grab 드래그 닫기 — 임계 통과 시 기존 onCancel 경로만 재사용.
  const grabRef = useSheetDragDismiss(panelRef, onCancel);

  const trimmed = draft.trim();
  const unchanged = trimmed === original.trim();
  const canSave = trimmed.length > 0 && !unchanged && !saving;

  const handleSave = async (): Promise<void> => {
    if (!canSave) return;
    setSaving(true);
    try {
      await onSave(trimmed);
      // 성공 시 부모가 editingMsg 를 null 로 풀어 이 시트가 언마운트된다.
    } catch {
      // 실패(충돌/검증) — 훅이 토스트를 띄웠다. 시트를 유지해 재시도/취소 가능.
      setSaving(false);
    }
  };

  return (
    <div
      data-testid={`mobile-edit-sheet-${msg.id}`}
      className="fixed inset-0 z-[var(--z-modal,60)]"
      role="dialog"
      aria-modal="true"
      // a11y M-2: dialog 이름을 시각 헤딩과 묶어 중복 낭독(aria-label + 헤딩) 제거.
      aria-labelledby={`mobile-edit-title-${msg.id}`}
    >
      {/* 071-M5 H7 (정찰 ①): 등장 모션 — 백드롭 fade + 시트 slide-up(enter-only). */}
      <div className="qf-m-sheet-backdrop qfa-backdrop-in absolute inset-0" onClick={onCancel} />
      {/* H-1(071-M0 C2): 백드롭(z=60) 아래 깔리던 시트를 --z-modal(61)로 올린다. */}
      <div
        ref={panelRef}
        className="qf-m-sheet qfa-sheet-in qf-m-safe-bottom absolute bottom-0 left-0 right-0 z-[var(--z-modal)]"
      >
        <div ref={grabRef} className="qf-m-sheet__grab" aria-hidden />
        <div className="px-[var(--s-4)] py-[var(--s-2)]">
          <p
            id={`mobile-edit-title-${msg.id}`}
            className="text-[length:var(--fs-13)] font-semibold text-text-muted"
          >
            메시지 편집
          </p>
        </div>
        <div className="px-[var(--s-3)] pb-[var(--s-2)]">
          <textarea
            ref={taRef}
            data-testid="mobile-edit-input"
            aria-label="메시지 편집 입력"
            className="qf-m-composer__input w-full"
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        </div>
        <div className="flex items-center justify-end gap-[var(--s-2)] px-[var(--s-3)] pb-[var(--s-3)]">
          {/* ui-designer HIGH/MED 리뷰: DS qf-m-composer__send(원형 전송)·qf-m-sheet__item
              (좌정렬 메뉴행) 재활용 대신, 가변폭 텍스트 버튼을 page-scoped Tailwind +
              DS 토큰으로 구성한다(raw hex/px 없음·터치타깃 min-h=var(--m-touch)=44px).
              071-M5 H11: 저장 버튼은 src 유일의 n-5 토큰 직참조(disabled 배경)였다 —
              DS qf-btn qf-btn--primary 채택(disabled 시각은 DS 기본 opacity 0.5),
              44px 터치 플로어만 min-h 유틸로 보강. */}
          <button
            type="button"
            data-testid="mobile-edit-cancel"
            onClick={onCancel}
            className="flex min-h-[var(--m-touch)] items-center justify-center rounded-[var(--r-md)] px-[var(--s-4)] text-[length:var(--fs-15)] text-[var(--text)] active:bg-bg-muted"
          >
            취소
          </button>
          <button
            type="button"
            data-testid="mobile-edit-save"
            onClick={() => void handleSave()}
            disabled={!canSave}
            // a11y M-1: native disabled 가 비활성+포커스제거를 모두 처리하므로 중복
            // aria-disabled 는 제거. a11y M-3: 전송 중 상태를 aria-busy + 텍스트로 알림.
            aria-busy={saving}
            className="qf-btn qf-btn--primary min-h-[var(--m-touch)]"
          >
            {saving ? '저장 중…' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}
