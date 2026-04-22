import { useEffect } from 'react';
import type { MessageDto } from '@qufox/shared-types';
import { Icon } from '../../design-system/primitives';

/**
 * Bottom sheet surfaced by long-press / swipe on a message row.
 * Uses DS qf-m-sheet / qf-m-sheet__item classes. Quick-reaction row
 * on top (5 presets), then menu items (Copy, Delete if mine).
 */

const QUICK = ['👍', '❤️', '😂', '🎉', '🙏'] as const;

export function MobileMessageSheet({
  msg,
  isMine,
  onClose,
  onDelete,
  onCopy,
  onReact,
  onReply,
}: {
  msg: MessageDto;
  isMine: boolean;
  onClose: () => void;
  onDelete: () => void;
  onCopy: () => void;
  onReact: (emoji: string) => void;
  onReply: () => void;
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      data-testid={`mobile-msg-sheet-${msg.id}`}
      className="fixed inset-0 z-[var(--z-modal,60)]"
      role="dialog"
      aria-modal="true"
    >
      <div className="qf-m-sheet-backdrop absolute inset-0" onClick={onClose} />
      <div className="qf-m-sheet qf-m-safe-bottom absolute bottom-0 left-0 right-0">
        <div className="qf-m-sheet__grab" aria-hidden />
        {/* Quick reaction row */}
        <div className="flex items-center justify-around py-[var(--s-3)]">
          {QUICK.map((e) => (
            <button
              key={e}
              type="button"
              data-testid={`mobile-quick-react-${e}`}
              onClick={() => onReact(e)}
              className="text-[length:var(--fs-18)] px-[var(--s-3)] py-[var(--s-2)] rounded-[var(--r-md)] active:bg-bg-muted"
            >
              {e}
            </button>
          ))}
        </div>
        <div className="qf-m-sheet__divider" aria-hidden />
        <button
          type="button"
          data-testid="mobile-msg-reply"
          onClick={onReply}
          className="qf-m-sheet__item"
        >
          <span className="qf-m-sheet__icon">
            <Icon name="reply" size="sm" />
          </span>
          <span>답장</span>
        </button>
        <button
          type="button"
          data-testid="mobile-msg-copy"
          onClick={onCopy}
          className="qf-m-sheet__item"
        >
          <span className="qf-m-sheet__icon">
            <Icon name="copy" size="sm" />
          </span>
          <span>메시지 복사</span>
        </button>
        {isMine ? (
          <button
            type="button"
            data-testid="mobile-msg-delete"
            onClick={onDelete}
            className="qf-m-sheet__item qf-m-sheet__item--danger"
          >
            <span className="qf-m-sheet__icon">
              <Icon name="trash" size="sm" />
            </span>
            <span>메시지 삭제</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
