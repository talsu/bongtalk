import { useState } from 'react';
import type { MessageDto, WorkspaceRole } from '@qufox/shared-types';
import { cn } from '../../lib/cn';
import { Avatar } from '../../design-system/primitives';
import { ReactionBar } from '../reactions/ReactionBar';
import { roleBadgeLabel } from './roleBadge';
import { renderMessageContent } from './parseContent';

type Props = {
  msg: MessageDto;
  isMine: boolean;
  authorName?: string;
  authorRole?: WorkspaceRole | null;
  onEditSave: (content: string) => void | Promise<void>;
  onDelete: () => void;
  onToggleReaction?: (emoji: string, currentlyByMe: boolean) => void;
  onOpenThread?: (rootId: string) => void;
};

export function MessageItem({
  msg,
  isMine,
  authorName,
  authorRole,
  onEditSave,
  onDelete,
  onToggleReaction,
  onOpenThread,
}: Props): JSX.Element {
  const badge = roleBadgeLabel(authorRole);
  const [editing, setEditing] = useState<string | null>(null);

  if (msg.deleted) {
    return (
      <div
        data-testid={`msg-deleted-${msg.id}`}
        role="note"
        aria-label="삭제된 메시지"
        className="px-[var(--s-7)] py-[var(--s-2)] text-[length:var(--fs-13)] italic text-text-muted"
      >
        (삭제된 메시지)
      </div>
    );
  }

  return (
    <article data-testid={`msg-${msg.id}`} className="qf-message qf-message--head group">
      <Avatar
        name={authorName ?? msg.authorId.slice(0, 2)}
        size="md"
        className="qf-message__avatar"
      />
      <div className="min-w-0">
        <div className="qf-message__meta">
          <span className="qf-message__author">{authorName ?? 'unknown'}</span>
          {badge ? (
            <span data-testid={`msg-role-${msg.id}`} className="qf-badge qf-badge--accent">
              {badge}
            </span>
          ) : null}
          <time className="qf-message__time">{new Date(msg.createdAt).toLocaleTimeString()}</time>
          {msg.edited ? (
            <span data-testid={`msg-edited-${msg.id}`} className="qf-message__time">
              (수정됨)
            </span>
          ) : null}
        </div>
        {editing !== null ? (
          <div className="mt-1 flex items-center gap-2">
            <input
              data-testid={`msg-edit-${msg.id}`}
              className="qf-input flex-1"
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
              type="button"
              data-testid={`msg-edit-save-${msg.id}`}
              onClick={async () => {
                await onEditSave(editing);
                setEditing(null);
              }}
              className="qf-btn qf-btn--ghost qf-btn--sm"
            >
              저장
            </button>
          </div>
        ) : (
          <div data-testid={`msg-content-${msg.id}`} className="qf-message__body">
            {renderMessageContent(msg.content ?? '')}
          </div>
        )}
        {onToggleReaction ? (
          <ReactionBar
            reactions={msg.reactions ?? []}
            onToggle={(emoji, byMe) => onToggleReaction(emoji, byMe)}
          />
        ) : null}
        {onOpenThread && msg.thread && msg.thread.replyCount > 0 ? (
          <button
            type="button"
            data-testid={`thread-open-${msg.id}`}
            onClick={() => onOpenThread(msg.id)}
            className="qf-replybar mt-1"
            aria-label={`${msg.thread.replyCount}개 답글 보기`}
          >
            <span className="qf-replybar__arrow" aria-hidden />
            <span className="qf-replybar__author">{msg.thread.replyCount}개 답글</span>
            {msg.thread.lastRepliedAt ? (
              <span>· 최근 {new Date(msg.thread.lastRepliedAt).toLocaleTimeString()}</span>
            ) : null}
          </button>
        ) : null}
      </div>
      {isMine && editing === null ? (
        <div className={cn('qf-message__toolbar absolute', 'group-hover:!flex')}>
          <button
            type="button"
            data-testid={`msg-edit-btn-${msg.id}`}
            onClick={() => setEditing(msg.content ?? '')}
            className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
            aria-label="메시지 수정"
          >
            ✎
          </button>
          <button
            type="button"
            data-testid={`msg-delete-${msg.id}`}
            onClick={onDelete}
            className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm text-danger"
            aria-label="메시지 삭제"
          >
            ✕
          </button>
        </div>
      ) : null}
    </article>
  );
}
