import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { MessageDto, WorkspaceRole } from '@qufox/shared-types';
import { useAuth } from '../auth/AuthProvider';
import { useMembers } from '../workspaces/useWorkspaces';
import {
  useDeleteMessage,
  useMessageHistory,
  useScrollFetch,
  useUpdateMessage,
} from './useMessages';
import { MessageItem } from './MessageItem';
import { useToggleReaction } from '../reactions/useReactions';
import { CustomEmojiProvider } from '../emojis/CustomEmojiContext';
import { Scrollable } from '../../design-system/primitives';

type Props = {
  workspaceId: string;
  channelId: string;
  onOpenThread?: (rootId: string) => void;
};

/**
 * The scrollable body of the message column. Infinite-scroll upward via
 * `useScrollFetch`. Virtualization (react-virtual) is prepared by the
 * surrounding `<Scrollable>` but kept off by default — the 50-message
 * page size keeps DOM cost trivial until we have real steady-state data.
 */
export function MessageList({ workspaceId, channelId, onOpenThread }: Props): JSX.Element {
  const { user } = useAuth();
  const { data: members } = useMembers(workspaceId);
  const history = useMessageHistory(workspaceId, channelId);
  const delMut = useDeleteMessage(workspaceId, channelId);
  const updMut = useUpdateMessage(workspaceId, channelId);
  const reactMut = useToggleReaction(workspaceId, channelId);
  const scrollRef = useRef<HTMLDivElement>(null);

  const messages = useMemo<MessageDto[]>(() => {
    const pages = history.data?.pages ?? [];
    const all = pages.flatMap((p) => p.items);
    return [...all].reverse(); // DESC pages → ASC render order
  }, [history.data]);

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

  useScrollFetch(scrollRef, () => {
    if (history.hasNextPage && !history.isFetchingNextPage) {
      void history.fetchNextPage();
    }
  });

  // task-021-R1-scroll-jumps-on-new-message: track whether the user
  // was anchored to the bottom BEFORE the latest append. The previous
  // single-effect implementation read scrollHeight AFTER append,
  // conflating "user was at bottom" with "new message grew the list"
  // — the nearBottom check misfired when a tall message arrived.
  // A scroll listener stamps the ref on every scroll; the post-append
  // effect consults the ref to decide whether to auto-scroll.
  //
  // Reviewer R1 BLOCKER fix: on INITIAL channel open the scroll
  // listener's synchronous warm-up read `scrollTop=0, scrollHeight
  // large` → stamped `false` → user landed at the top of history
  // instead of the latest message. A separate `hasAnchoredRef` flag
  // guarantees the very first `messages.length > 0` transition pins
  // to bottom regardless of the ref.
  const wasAtBottomRef = useRef(true);
  const hasAnchoredRef = useRef(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = (): void => {
      wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    // Do NOT call onScroll() synchronously on mount — the channel is
    // about to scroll to bottom via the layout-effect below.
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || messages.length === 0) return;
    // First paint with non-empty history → pin to bottom unconditionally.
    if (!hasAnchoredRef.current) {
      el.scrollTop = el.scrollHeight;
      hasAnchoredRef.current = true;
      wasAtBottomRef.current = true;
      return;
    }
    // Subsequent appends: only pin if the user was anchored to the
    // bottom BEFORE this update.
    if (wasAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length]);

  // task-021-R1: on channel switch (mount of a new MessageList /
  // effect re-run via channelId-driven remount), reset the anchored
  // flag so the next history load pins to bottom again.
  useEffect(() => {
    hasAnchoredRef.current = false;
    wasAtBottomRef.current = true;
  }, [channelId]);

  return (
    <CustomEmojiProvider workspaceId={workspaceId}>
      <Scrollable
        ref={scrollRef}
        data-testid="msg-list"
        role="log"
        aria-live="polite"
        aria-label="메시지"
        className="flex-1 py-[var(--s-3)]"
      >
        {history.hasNextPage ? (
          <div className="py-[var(--s-3)] text-center text-[length:var(--fs-11)] text-text-muted">
            {history.isFetchingNextPage ? '이전 메시지 불러오는 중…' : '스크롤해 더 보기'}
          </div>
        ) : null}
        {messages.length === 0 ? (
          <div className="qf-empty">
            <div className="qf-empty__title">채널이 한산하네요</div>
            <div className="qf-empty__body">아래에서 첫 메시지를 보내 대화를 시작하세요.</div>
          </div>
        ) : null}
        {messages.map((m, idx) => {
          // Discord-like continuation rule: collapse the avatar + meta of
          // consecutive messages from the same author within 5 minutes,
          // provided both live in the same thread context (both roots OR
          // both replies to the same parent). Deleted messages reset the
          // grouping so the "(삭제된 메시지)" line stands alone.
          const prev = idx > 0 ? messages[idx - 1] : null;
          const isContinuation =
            !!prev &&
            !prev.deleted &&
            !m.deleted &&
            prev.authorId === m.authorId &&
            prev.parentMessageId === m.parentMessageId &&
            new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000;
          return (
            <MessageItem
              key={m.id}
              msg={m}
              isMine={m.authorId === user?.id}
              isContinuation={isContinuation}
              authorName={nameById.get(m.authorId)}
              authorRole={roleById.get(m.authorId) ?? null}
              onEditSave={async (content) => {
                await updMut.mutateAsync({ msgId: m.id, content });
              }}
              onDelete={() => {
                void delMut.mutate(m.id);
              }}
              onToggleReaction={(emoji, byMe) => {
                // Optimistic rows have tempIds — they can't accept reactions
                // until the server roundtrip replaces them with a real id.
                if (m.id.startsWith('tmp-')) return;
                reactMut.mutate({ messageId: m.id, emoji, currentlyByMe: byMe });
              }}
              onOpenThread={
                onOpenThread && !m.id.startsWith('tmp-')
                  ? (rootId) => onOpenThread(rootId)
                  : undefined
              }
            />
          );
        })}
      </Scrollable>
    </CustomEmojiProvider>
  );
}
