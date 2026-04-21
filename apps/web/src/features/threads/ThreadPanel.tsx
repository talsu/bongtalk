import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MessageDto, WorkspaceRole } from '@qufox/shared-types';
import { useMembers } from '../workspaces/useWorkspaces';
import { Avatar } from '../../design-system/primitives';
import { roleBadgeLabel } from '../messages/roleBadge';
import { renderMessageContent } from '../messages/parseContent';
import { cn } from '../../lib/cn';
import { useThreadReplies, useSendReply } from './useThread';

type Props = {
  workspaceId: string;
  channelId: string;
  channelName?: string;
  rootId: string;
  onClose: () => void;
};

/**
 * Task-014-C + design-system v2 refresh: right-side thread panel
 * rebuilt on the DS `qf-thread-panel` primitives (see
 * /design-system/index.html § Thread). Header → pinned origin card →
 * day divider → compact `qf-thread-msg` rows → `qf-thread-composer`.
 */
export function ThreadPanel({
  workspaceId,
  channelId,
  channelName,
  rootId,
  onClose,
}: Props): JSX.Element | null {
  const { data: members } = useMembers(workspaceId);
  const history = useThreadReplies(rootId);
  const reply = useSendReply(workspaceId, channelId, rootId);
  const scrollRef = useRef<HTMLDivElement>(null);

  const pages = history.data?.pages ?? [];
  const root: MessageDto | undefined = pages[0]?.root;
  const replies = useMemo<MessageDto[]>(() => pages.flatMap((p) => p.replies), [pages]);

  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members?.members ?? []) map.set(m.userId, m.user.username);
    return map;
  }, [members]);

  const roleById = useMemo(() => {
    const map = new Map<string, WorkspaceRole>();
    for (const m of members?.members ?? []) map.set(m.userId, m.role);
    return map;
  }, [members]);

  // Scroll to bottom when new replies arrive (only if already near bottom).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (near) el.scrollTop = el.scrollHeight;
  }, [replies.length]);

  // ESC closes the panel — scoped to this panel's mount lifetime.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!rootId) return null;

  const rootAuthorName = root ? (nameById.get(root.authorId) ?? 'unknown') : '';
  const rootBadge = root ? roleBadgeLabel(roleById.get(root.authorId) ?? null) : null;

  return (
    <aside data-testid="thread-panel" aria-label="스레드" className="qf-thread-panel">
      <header className="qf-thread-panel__header">
        <span className="qf-thread-panel__icon" aria-hidden>
          💬
        </span>
        <div className="min-w-0 flex-1">
          <div className="qf-thread-panel__title">스레드</div>
          <div className="qf-thread-panel__sub">
            {channelName ? `#${channelName}` : ''}
            {root?.thread?.replyCount ? ` · ${root.thread.replyCount} replies` : ''}
          </div>
        </div>
        <button
          type="button"
          data-testid="thread-close"
          onClick={onClose}
          aria-label="스레드 닫기"
          className="qf-thread-panel__close"
        >
          ✕
        </button>
      </header>

      <div ref={scrollRef} data-testid="thread-body" className="qf-thread-body">
        {root ? (
          <div data-testid="thread-root" className="qf-thread-origin">
            <div className="qf-thread-origin__meta">
              <span className="qf-thread-origin__author">{rootAuthorName}</span>
              {rootBadge ? <span className="qf-badge qf-badge--accent">{rootBadge}</span> : null}
              <span className="qf-thread-origin__time">
                {new Date(root.createdAt).toLocaleTimeString()}
              </span>
            </div>
            <div className="qf-thread-origin__body">{root.content ?? ''}</div>
          </div>
        ) : history.isLoading ? (
          <div className="qf-thread-divider">불러오는 중…</div>
        ) : null}

        {history.hasNextPage ? (
          <button
            type="button"
            data-testid="thread-load-more"
            onClick={() => history.fetchNextPage()}
            className="mx-[var(--s-5)] mb-[var(--s-2)] block text-left text-[length:var(--fs-11)] text-text-muted underline"
          >
            {history.isFetchingNextPage ? '불러오는 중…' : '이전 답글 보기'}
          </button>
        ) : null}

        {replies.length > 0 ? (
          <div className="qf-thread-divider">{replies.length} replies</div>
        ) : null}

        {replies.map((m, idx) => {
          const prev = idx > 0 ? replies[idx - 1] : null;
          const isContinuation =
            !!prev &&
            !prev.deleted &&
            !m.deleted &&
            prev.authorId === m.authorId &&
            new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000;
          return (
            <ThreadReplyRow
              key={m.id}
              msg={m}
              authorName={nameById.get(m.authorId)}
              isContinuation={isContinuation}
            />
          );
        })}
      </div>

      <ThreadComposer
        disabled={reply.isPending}
        onSubmit={(content) =>
          reply.mutate({
            content,
            tempId: `tmp-${crypto.randomUUID()}`,
            idempotencyKey: crypto.randomUUID(),
          })
        }
      />
    </aside>
  );
}

function ThreadReplyRow({
  msg,
  authorName,
  isContinuation,
}: {
  msg: MessageDto;
  authorName?: string;
  isContinuation: boolean;
}): JSX.Element {
  const isHead = !isContinuation;
  if (msg.deleted) {
    return (
      <div
        data-testid={`thread-reply-${msg.id}`}
        className="qf-thread-msg qf-thread-msg--cont italic text-text-muted"
      >
        <div className="qf-thread-msg__avatar" aria-hidden />
        <div>
          <div className="qf-thread-msg__body">(삭제된 답글)</div>
        </div>
      </div>
    );
  }
  return (
    <article
      data-testid={`thread-reply-${msg.id}`}
      className={cn('qf-thread-msg', isHead ? 'qf-thread-msg--head' : 'qf-thread-msg--cont')}
    >
      {isHead ? (
        <Avatar
          name={authorName ?? msg.authorId.slice(0, 2)}
          size="sm"
          className="qf-thread-msg__avatar"
        />
      ) : (
        <span className="qf-avatar qf-avatar--sm qf-thread-msg__avatar" aria-hidden="true" />
      )}
      <div className="min-w-0">
        {isHead ? (
          <div className="qf-thread-msg__meta">
            <span className="qf-thread-msg__author">{authorName ?? 'unknown'}</span>
            <span className="qf-thread-msg__time">
              {new Date(msg.createdAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          </div>
        ) : null}
        <div className="qf-thread-msg__body">{renderMessageContent(msg.content ?? '')}</div>
      </div>
    </article>
  );
}

function ThreadComposer({
  onSubmit,
  disabled,
}: {
  onSubmit: (content: string) => void;
  disabled: boolean;
}): JSX.Element {
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Same auto-grow rule as MessageComposer — single-line start, grows
  // up to 160px for the smaller panel, then scrolls internally.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = '0px';
    const next = Math.min(160, Math.max(22, el.scrollHeight));
    el.style.height = `${next}px`;
  }, [draft]);

  const submit = (): void => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setDraft('');
  };

  return (
    <form
      data-testid="thread-composer"
      className="qf-thread-composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div
        className={cn(
          'flex items-center gap-[var(--s-3)]',
          'rounded-[var(--r-lg)] border border-border-subtle bg-bg-input',
          'px-[var(--s-4)] py-[var(--s-3)]',
        )}
      >
        <textarea
          ref={textareaRef}
          data-testid="thread-input"
          value={draft}
          rows={1}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // task-021-R1-ime-enter-half-sends: guard against Enter
            // during Korean IME composition (composer + thread share
            // the same rule).
            const native = e.nativeEvent as KeyboardEvent & { isComposing?: boolean };
            if (native.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          maxLength={4000}
          placeholder="스레드에 답글…"
          className="flex-1 resize-none bg-transparent outline-none placeholder:text-text-muted text-text"
          style={{ minHeight: '22px', maxHeight: '160px' }}
        />
      </div>
      <div className="qf-thread-composer__options">
        <label className="qf-thread-composer__checkbox" title="추후 지원 예정">
          <input type="checkbox" disabled />
          <span>채널에도 공유</span>
        </label>
      </div>
      <button
        type="submit"
        hidden
        aria-hidden="true"
        data-testid="thread-send"
        disabled={disabled || draft.trim().length === 0}
      />
    </form>
  );
}
