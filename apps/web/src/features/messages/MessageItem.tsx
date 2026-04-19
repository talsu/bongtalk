import { useState } from 'react';
import type { MessageDto } from '@qufox/shared-types';
import { cn } from '../../lib/cn';
import { Avatar } from '../../design-system/primitives';

type Props = {
  msg: MessageDto;
  isMine: boolean;
  authorName?: string;
  onEditSave: (content: string) => void | Promise<void>;
  onDelete: () => void;
};

/**
 * Single message row. Hover reveals edit/delete (own messages only).
 * Deleted messages render a muted placeholder — meta-data still visible
 * for audit continuity but content is server-masked to `null`.
 */
export function MessageItem({ msg, isMine, authorName, onEditSave, onDelete }: Props): JSX.Element {
  const [editing, setEditing] = useState<string | null>(null);

  if (msg.deleted) {
    return (
      <div
        data-testid={`msg-deleted-${msg.id}`}
        role="note"
        aria-label="삭제된 메시지"
        className="rounded-md px-3 py-1 text-xs italic text-text-muted"
      >
        (삭제된 메시지)
      </div>
    );
  }

  return (
    <article
      data-testid={`msg-${msg.id}`}
      className="group flex items-start gap-3 px-3 py-1 hover:bg-bg-subtle/50"
    >
      <Avatar name={authorName ?? msg.authorId.slice(0, 2)} size="md" className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-foreground">{authorName ?? 'unknown'}</span>
          <time className="text-[10px] text-text-muted">
            {new Date(msg.createdAt).toLocaleTimeString()}
          </time>
          {msg.edited ? (
            <span data-testid={`msg-edited-${msg.id}`} className="text-[10px] text-text-muted">
              (수정됨)
            </span>
          ) : null}
        </div>
        {editing !== null ? (
          <div className="mt-1 flex items-center gap-2">
            <input
              data-testid={`msg-edit-${msg.id}`}
              className="flex-1 rounded-md border border-border-subtle bg-bg-surface px-2 py-1 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={editing}
              onChange={(e) => setEditing(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === 'Enter') {
                  await onEditSave(editing);
                  setEditing(null);
                }
                if (e.key === 'Escape') setEditing(null);
              }}
              autoFocus
            />
            <button
              data-testid={`msg-edit-save-${msg.id}`}
              onClick={async () => {
                await onEditSave(editing);
                setEditing(null);
              }}
              className="text-xs text-text-muted underline"
            >
              저장
            </button>
          </div>
        ) : (
          <p data-testid={`msg-content-${msg.id}`} className="break-words text-sm text-foreground">
            {msg.content}
          </p>
        )}
      </div>
      {isMine && editing === null ? (
        <div className={cn('flex items-center gap-1 opacity-0 group-hover:opacity-100')}>
          <button
            type="button"
            data-testid={`msg-edit-btn-${msg.id}`}
            onClick={() => setEditing(msg.content ?? '')}
            className="rounded px-2 py-0.5 text-[11px] text-text-muted hover:bg-bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="메시지 수정"
          >
            수정
          </button>
          <button
            type="button"
            data-testid={`msg-delete-${msg.id}`}
            onClick={onDelete}
            className="rounded px-2 py-0.5 text-[11px] text-danger hover:bg-bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="메시지 삭제"
          >
            삭제
          </button>
        </div>
      ) : null}
    </article>
  );
}
