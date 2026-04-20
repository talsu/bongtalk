import { useEffect, useMemo, useRef, useState } from 'react';
import type { MessageDto, WorkspaceRole } from '@qufox/shared-types';
import { useAuth } from '../auth/AuthProvider';
import { useMembers } from '../workspaces/useWorkspaces';
import { MessageItem } from '../messages/MessageItem';
import { Scrollable } from '../../design-system/primitives';
import { useThreadReplies, useSendReply } from './useThread';

type Props = {
  workspaceId: string;
  channelId: string;
  rootId: string;
  onClose: () => void;
};

/**
 * Task-014-C: right-side thread panel. Header renders the root
 * message, body lists replies, footer is a composer bound to the
 * root id. Closes on X click, ESC, or the parent removing the
 * `?thread=` query param (owned by the route).
 */
export function ThreadPanel({
  workspaceId,
  channelId,
  rootId,
  onClose,
}: Props): JSX.Element | null {
  const { user } = useAuth();
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

  // Scroll to bottom when new replies arrive.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (near) el.scrollTop = el.scrollHeight;
  }, [replies.length]);

  // ESC closes the panel — scoped to this panel's mount lifetime so
  // the channel view's own ESC bindings still work when the panel is
  // not open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!rootId) return null;

  return (
    <aside
      data-testid="thread-panel"
      aria-label="스레드"
      className="flex h-full w-full flex-col border-l border-border-subtle bg-bg-panel md:w-thread"
    >
      <header className="qf-topbar justify-between">
        <div className="qf-topbar__title">스레드</div>
        <button
          type="button"
          data-testid="thread-close"
          onClick={onClose}
          aria-label="스레드 닫기"
          className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
        >
          ✕
        </button>
      </header>
      <Scrollable
        ref={scrollRef}
        data-testid="thread-body"
        role="log"
        aria-live="polite"
        className="flex-1 px-2 py-3"
      >
        {!root && history.isLoading ? (
          <div className="py-4 text-center text-xs text-text-muted">불러오는 중…</div>
        ) : null}
        {root ? (
          <div
            data-testid="thread-root"
            className="mb-2 rounded-md border border-border-subtle bg-bg-subtle/40"
          >
            <MessageItem
              msg={root}
              isMine={root.authorId === user?.id}
              authorName={nameById.get(root.authorId)}
              authorRole={roleById.get(root.authorId) ?? null}
              onEditSave={async () => undefined}
              onDelete={() => undefined}
            />
          </div>
        ) : null}
        {history.hasNextPage ? (
          <button
            type="button"
            data-testid="thread-load-more"
            onClick={() => history.fetchNextPage()}
            className="block w-full py-2 text-center text-[length:var(--fs-11)] text-text-muted underline"
          >
            {history.isFetchingNextPage ? '불러오는 중…' : '이전 답글 보기'}
          </button>
        ) : null}
        {replies.map((m) => (
          <MessageItem
            key={m.id}
            msg={m}
            isMine={m.authorId === user?.id}
            authorName={nameById.get(m.authorId)}
            authorRole={roleById.get(m.authorId) ?? null}
            onEditSave={async () => undefined}
            onDelete={() => undefined}
          />
        ))}
      </Scrollable>
      <footer className="border-t border-border-subtle bg-chat p-[var(--s-3)]">
        <ReplyComposer
          disabled={reply.isPending}
          onSubmit={(content) =>
            reply.mutate({
              content,
              tempId: `tmp-${crypto.randomUUID()}`,
              idempotencyKey: crypto.randomUUID(),
            })
          }
        />
      </footer>
    </aside>
  );
}

function ReplyComposer({
  onSubmit,
  disabled,
}: {
  onSubmit: (content: string) => void;
  disabled: boolean;
}): JSX.Element {
  const [draft, setDraft] = useState('');
  const submit = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setDraft('');
  };
  return (
    <form
      data-testid="thread-composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        data-testid="thread-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={2}
        maxLength={4000}
        placeholder="답글 남기기"
        className="qf-input qf-textarea"
      />
      <div className="mt-[var(--s-2)] flex items-center justify-between text-[length:var(--fs-11)] text-text-muted">
        <span>Enter 전송, Shift+Enter 줄바꿈</span>
        <button
          type="submit"
          data-testid="thread-send"
          disabled={disabled || draft.trim().length === 0}
          className="qf-btn qf-btn--primary qf-btn--sm"
        >
          답글
        </button>
      </div>
    </form>
  );
}
