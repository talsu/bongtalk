import { useLayoutEffect, useMemo, useRef, useState, type RefObject, type TouchEvent } from 'react';
import type { MessageDto, WorkspaceRole } from '@qufox/shared-types';
import { useAuth } from '../../features/auth/AuthProvider';
import { useMembers } from '../../features/workspaces/useWorkspaces';
import {
  useDeleteMessage,
  useMessageHistory,
  useScrollFetch,
  useUpdateMessage,
  useSendMessage,
} from '../../features/messages/useMessages';
import { useToggleReaction } from '../../features/reactions/useReactions';
import { useCompose } from '../../stores/compose-store';
import { renderMessageContent } from '../../features/messages/parseContent';
import { Avatar, Icon } from '../../design-system/primitives';
import { MobileMessageSheet } from './MobileMessageSheet';
import { cn } from '../../lib/cn';

/**
 * Mobile chat screen — scrolling qf-m-message list + qf-m-composer
 * pinned to the bottom above qf-m-tabbar. Long-press on a message
 * opens a bottom sheet (reply / copy / delete). Swipe-right on a
 * message sends the bottom sheet's "reply in thread" action
 * immediately (matches Discord's swipe-to-reply).
 */
export function MobileMessages({
  workspaceId,
  workspaceSlug,
  channelId,
  channelName,
}: {
  workspaceId: string;
  workspaceSlug: string;
  channelId: string;
  channelName: string;
}): JSX.Element {
  const { user } = useAuth();
  const { data: members } = useMembers(workspaceId);
  const history = useMessageHistory(workspaceId, channelId);
  const delMut = useDeleteMessage(workspaceId, channelId);
  const updMut = useUpdateMessage(workspaceId, channelId);
  const reactMut = useToggleReaction(workspaceId, channelId);
  const { send } = useSendMessage(workspaceId, channelId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<HTMLInputElement>(null);
  const [sheetMsg, setSheetMsg] = useState<MessageDto | null>(null);
  const setReplyTarget = useCompose((s) => s.setReplyTarget);

  // suppress unused warnings until wired into sheet actions
  void updMut;
  void delMut;
  void reactMut;
  void workspaceSlug;

  const messages = useMemo<MessageDto[]>(() => {
    const pages = history.data?.pages ?? [];
    return [...pages.flatMap((p) => p.items)].reverse();
  }, [history.data]);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const x of members?.members ?? []) m.set(x.userId, x.user.username);
    return m;
  }, [members]);

  const roleById = useMemo(() => {
    const m = new Map<string, WorkspaceRole>();
    for (const x of members?.members ?? []) m.set(x.userId, x.role);
    return m;
  }, [members]);
  void roleById;

  useScrollFetch(scrollRef, () => {
    if (history.hasNextPage && !history.isFetchingNextPage) void history.fetchNextPage();
  });

  // Auto-scroll to bottom on mount + new incoming. task-025 follow-4:
  // history prepend grows messages.length while isFetchingNextPage is
  // true and wasAtBottomRef stays true, so without a gate the old code
  // snapped the view to the bottom mid-fetch and threw the user off
  // the history they had just requested.
  const wasAtBottomRef = useRef(true);
  const hasAnchoredRef = useRef(false);
  const prevScrollHeightRef = useRef(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || messages.length === 0) return;
    if (!hasAnchoredRef.current) {
      el.scrollTop = el.scrollHeight;
      hasAnchoredRef.current = true;
      prevScrollHeightRef.current = el.scrollHeight;
      return;
    }
    if (history.isFetchingNextPage) {
      // Mid-prepend: preserve the user's anchor by shifting scrollTop
      // by however much the list grew upward.
      const delta = el.scrollHeight - prevScrollHeightRef.current;
      if (delta > 0) el.scrollTop = el.scrollTop + delta;
      prevScrollHeightRef.current = el.scrollHeight;
      return;
    }
    if (wasAtBottomRef.current) el.scrollTop = el.scrollHeight;
    prevScrollHeightRef.current = el.scrollHeight;
  }, [messages.length, history.isFetchingNextPage]);

  return (
    <>
      <div
        ref={scrollRef}
        data-testid="mobile-message-list"
        className="flex-1 overflow-y-auto px-[var(--s-3)] py-[var(--s-3)] min-h-0"
        onScroll={(e) => {
          const el = e.currentTarget;
          wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {messages.map((m) => (
          <MobileMessageRow
            key={m.id}
            msg={m}
            isMine={m.authorId === user?.id}
            authorName={nameById.get(m.authorId)}
            onLongPress={() => setSheetMsg(m)}
            onSwipeReply={() => {
              setReplyTarget(channelId, {
                messageId: m.id,
                authorName: nameById.get(m.authorId) ?? 'unknown',
              });
              composerInputRef.current?.focus();
            }}
          />
        ))}
      </div>
      <MobileComposer
        channelId={channelId}
        channelName={channelName}
        send={send}
        inputRef={composerInputRef}
      />
      {sheetMsg ? (
        <MobileMessageSheet
          msg={sheetMsg}
          isMine={sheetMsg.authorId === user?.id}
          onClose={() => setSheetMsg(null)}
          onDelete={() => {
            delMut.mutate(sheetMsg.id);
            setSheetMsg(null);
          }}
          onCopy={() => {
            void navigator.clipboard?.writeText(sheetMsg.content ?? '');
            setSheetMsg(null);
          }}
          onReact={(emoji) => {
            if (!sheetMsg.id.startsWith('tmp-')) {
              reactMut.mutate({
                messageId: sheetMsg.id,
                emoji,
                currentlyByMe: sheetMsg.reactions?.find((r) => r.emoji === emoji)?.byMe ?? false,
              });
            }
            setSheetMsg(null);
          }}
        />
      ) : null}
    </>
  );
}

function MobileMessageRow({
  msg,
  isMine,
  authorName,
  onLongPress,
  onSwipeReply,
}: {
  msg: MessageDto;
  isMine: boolean;
  authorName?: string;
  onLongPress: () => void;
  onSwipeReply: () => void;
}): JSX.Element {
  const pressTimer = useRef<number | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const [swipeOffset, setSwipeOffset] = useState(0);

  const LONG_PRESS_MS = 500;
  const SWIPE_THRESHOLD_PX = 80;

  const onTouchStart = (e: TouchEvent): void => {
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY };
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      onLongPress();
    }, LONG_PRESS_MS);
  };
  const onTouchMove = (e: TouchEvent): void => {
    if (!touchStart.current) return;
    const t = e.touches[0];
    const dx = t.clientX - touchStart.current.x;
    const dy = t.clientY - touchStart.current.y;
    // Lateral drag cancels the long-press.
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
      if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    if (dx > 0 && Math.abs(dy) < 30) setSwipeOffset(Math.min(dx, 120));
  };
  const onTouchEnd = (): void => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
    if (swipeOffset >= SWIPE_THRESHOLD_PX) {
      // task-025 follow-2: swipe-right bypasses the sheet and enters
      // reply-mode directly (sets replyTarget + focuses composer).
      onSwipeReply();
    }
    setSwipeOffset(0);
    touchStart.current = null;
  };

  if (msg.deleted) {
    return (
      <div
        data-testid={`mobile-msg-deleted-${msg.id}`}
        className="qf-m-message italic text-text-muted"
      >
        (삭제된 메시지)
      </div>
    );
  }

  return (
    <article
      data-testid={`mobile-msg-${msg.id}`}
      data-mine={isMine ? 'true' : 'false'}
      className={cn('qf-m-message')}
      style={{
        transform: `translateX(${swipeOffset}px)`,
        transition: swipeOffset === 0 ? 'transform 120ms' : undefined,
      }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <Avatar
        name={authorName ?? msg.authorId.slice(0, 2)}
        size="sm"
        className="qf-m-message__avatar"
      />
      <div className="qf-m-message__bubble">
        <div className="qf-m-message__meta">
          <span className="qf-m-message__author">{authorName ?? 'unknown'}</span>
          <time className="qf-m-message__time">
            {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </time>
        </div>
        <div className="qf-m-message__body">{renderMessageContent(msg.content ?? '')}</div>
      </div>
    </article>
  );
}

function MobileComposer({
  channelId,
  channelName,
  send,
  inputRef,
}: {
  channelId: string;
  channelName: string;
  send: (content: string) => void;
  inputRef: RefObject<HTMLInputElement>;
}): JSX.Element {
  const draft = useCompose((s) => s.drafts[channelId] ?? '');
  const setDraft = useCompose((s) => s.setDraft);
  const clearDraft = useCompose((s) => s.clearDraft);
  const replyTarget = useCompose((s) => s.replyTargets[channelId]);
  const setReplyTarget = useCompose((s) => s.setReplyTarget);

  const submit = (): void => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    send(trimmed);
    clearDraft(channelId);
    setReplyTarget(channelId, null);
  };

  return (
    <div className="qf-m-safe-bottom">
      {replyTarget ? (
        <div
          data-testid="mobile-reply-banner"
          data-reply-to={replyTarget.messageId}
          className="flex items-center gap-[var(--s-2)] px-[var(--s-4)] py-[var(--s-2)] bg-bg-panel border-t border-divider text-[length:var(--fs-13)] text-text-muted"
        >
          <Icon name="reply" size="sm" />
          <span className="flex-1 truncate">@{replyTarget.authorName}에게 답장</span>
          <button
            type="button"
            aria-label="답장 취소"
            data-testid="mobile-reply-cancel"
            onClick={() => setReplyTarget(channelId, null)}
            style={{ minWidth: 'var(--m-touch)', minHeight: 'var(--m-touch)' }}
            className="grid place-items-center"
          >
            <Icon name="x" size="sm" />
          </button>
        </div>
      ) : null}
      <form
        data-testid="mobile-composer"
        className="qf-m-composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <button
          type="button"
          data-testid="mobile-composer-plus"
          aria-label="첨부 추가"
          className="qf-m-composer__plus"
        >
          <Icon name="plus-circle" size="md" />
        </button>
        <input
          ref={inputRef}
          data-testid="mobile-msg-input"
          className="qf-m-composer__input"
          value={draft}
          onChange={(e) => setDraft(channelId, e.target.value)}
          placeholder={replyTarget ? `@${replyTarget.authorName}에게 답장…` : `# ${channelName}`}
          onKeyDown={(e) => {
            const native = e.nativeEvent as KeyboardEvent & { isComposing?: boolean };
            if (native.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="submit"
          data-testid="mobile-composer-send"
          aria-label="전송"
          className="qf-m-composer__send"
          disabled={draft.trim().length === 0}
        >
          <Icon name="send" size="md" />
        </button>
      </form>
    </div>
  );
}
