import { useRef } from 'react';
import type { MessageDto } from '@qufox/shared-types';
import { useEditHistory } from '../../features/messages/useMessages';
import { Icon } from '../../design-system/primitives';
import { useSheetFocusTrap } from './useSheetFocusTrap';
import { useSheetHistoryMarker } from './useSheetHistoryMarker';
import { useSheetDragDismiss } from './useSheetDragDismiss';

/**
 * 071-M3 F6 (FR-MSG-08 모바일 / 감사 B-18) — 편집 이력 바텀시트.
 *
 * 데스크톱 EditHistoryPopover 와 동일한 useEditHistory(워크스페이스 스코프)를
 * 쓰고, 표시는 contentPlain(평문 정본) + 편집 시각으로 단순화한다. 본인 외
 * 메시지도 열람 가능(모더레이터 등 — 권한은 서버가 403 판정).
 */
export function MobileEditHistorySheet({
  workspaceId,
  channelId,
  msg,
  onClose,
}: {
  workspaceId: string;
  channelId: string;
  msg: MessageDto;
  onClose: () => void;
}): JSX.Element {
  const { data, isLoading, isError } = useEditHistory(workspaceId, channelId, msg.id, true);
  const panelRef = useRef<HTMLDivElement>(null);
  useSheetHistoryMarker(true, onClose);
  // 071-M5 H4 (감사 A-30): 종전 Esc 단독 effect 를 공용 트랩으로 교체 — 열림
  // 자동 포커스/Tab 순환/닫힘 복귀를 함께 확보한다(Esc 동작은 훅이 흡수).
  useSheetFocusTrap(panelRef, onClose);
  // 071-M5 H8 (정찰 ②): grab 드래그 닫기 — 임계 통과 시 기존 onClose 경로만 재사용.
  const grabRef = useSheetDragDismiss(panelRef, onClose);

  const items = data?.items ?? [];

  return (
    <div
      data-testid="mobile-edit-history-sheet"
      className="fixed inset-0 z-[var(--z-modal,60)]"
      role="dialog"
      aria-modal="true"
      aria-label="편집 이력"
    >
      {/* 071-M5 H7 (정찰 ①): 등장 모션 — 백드롭 fade + 시트 slide-up(enter-only). */}
      <div className="qf-m-sheet-backdrop qfa-backdrop-in absolute inset-0" onClick={onClose} />
      {/* 071-M5 H11: raw 70vh 상한 제거 — 시트는 fixed inset-0 래퍼의 absolute
          bottom-0 직배치라 DS .qf-m-sheet(max-height:80%, flex column)가 그대로
          상한을 잡는다. 스크롤은 컨테이너 대신 이력 목록(ul)으로 이동해 grab/
          헤더를 고정한다(DM 새 시트와 동일 패턴). */}
      <div
        ref={panelRef}
        className="qf-m-sheet qfa-sheet-in qf-m-safe-bottom absolute bottom-0 left-0 right-0 z-[var(--z-modal)]"
      >
        <div ref={grabRef} className="qf-m-sheet__grab" aria-hidden />
        {/* 071-M5 H4: 이 시트는 종전 focusable 0개(키보드/스크린리더는 Esc 외 닫기
            불가·트랩 앵커 부재) — 헤더에 가시적 닫기 버튼을 신설해 둘 다 해소. */}
        <div className="qf-m-section flex items-center justify-between">
          <div>편집 이력</div>
          <button
            type="button"
            data-testid="mobile-edit-history-close"
            aria-label="닫기"
            onClick={onClose}
            className="flex min-h-[var(--m-touch)] min-w-[var(--m-touch)] items-center justify-center text-text-muted"
          >
            <Icon name="x" size="sm" />
          </button>
        </div>
        {isLoading ? (
          <div className="qf-m-empty">
            <div className="qf-m-empty__body">불러오는 중…</div>
          </div>
        ) : isError ? (
          <div className="qf-m-empty" data-testid="mobile-edit-history-error">
            <div className="qf-m-empty__body">이력을 불러오지 못했습니다.</div>
          </div>
        ) : items.length === 0 ? (
          <div className="qf-m-empty" data-testid="mobile-edit-history-empty">
            <div className="qf-m-empty__body">이전 버전이 없습니다.</div>
          </div>
        ) : (
          <ul
            aria-label="이전 버전"
            data-testid="mobile-edit-history-list"
            className="min-h-0 flex-1 overflow-y-auto"
          >
            {items.map((it) => (
              <li key={it.version} className="qf-m-row">
                <Icon name="clock" size="sm" className="text-text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="qf-m-row__secondary block">
                    v{it.version} ·{' '}
                    {new Date(it.editedAt).toLocaleString('ko-KR', {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  <span className="qf-m-row__primary block whitespace-pre-wrap break-words">
                    {it.contentPlain || '(빈 내용)'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
