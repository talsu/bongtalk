import { useEffect, useRef } from 'react';
import type { MessageDto } from '@qufox/shared-types';
import { useEditHistory } from '../../features/messages/useMessages';
import { Icon } from '../../design-system/primitives';
import { useSheetHistoryMarker } from './useSheetHistoryMarker';

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
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useSheetHistoryMarker(true, onClose);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const items = data?.items ?? [];

  return (
    <div
      data-testid="mobile-edit-history-sheet"
      className="fixed inset-0 z-[var(--z-modal,60)]"
      role="dialog"
      aria-modal="true"
      aria-label="편집 이력"
    >
      <div className="qf-m-sheet-backdrop absolute inset-0" onClick={onClose} />
      <div className="qf-m-sheet qf-m-safe-bottom absolute bottom-0 left-0 right-0 z-[var(--z-modal)] max-h-[70vh] overflow-y-auto">
        <div className="qf-m-sheet__grab" aria-hidden />
        <div className="qf-m-section">
          <div>편집 이력</div>
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
          <ul aria-label="이전 버전" data-testid="mobile-edit-history-list">
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
