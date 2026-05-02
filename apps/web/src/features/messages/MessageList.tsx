import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { MessageDto, WorkspaceRole } from '@qufox/shared-types';
import { useAuth } from '../auth/AuthProvider';
import { useMembers } from '../workspaces/useWorkspaces';
import { useDeleteMessage, useMessageHistory, useUpdateMessage } from './useMessages';
import { MessageItem } from './MessageItem';
import { useToggleReaction } from '../reactions/useReactions';
import { CustomEmojiProvider } from '../emojis/CustomEmojiContext';
import { Scrollable } from '../../design-system/primitives';
import {
  takeAnchorSnapshot,
  restoreAnchorScrollTop,
  isNearBottom,
  type AnchorSnapshot,
} from './messageAnchor';

type Props = {
  /** null for Global DM channels (no host workspace). */
  workspaceId: string | null;
  channelId: string;
  onOpenThread?: (rootId: string) => void;
  /**
   * Fallback username lookup for authors NOT in the workspace member
   * list — needed for DMs where the other participant may belong to
   * a different workspace (or no workspace at all). Keys are userIds,
   * values are the usernames to show in the message header.
   */
  extraNames?: Map<string, string>;
};

/**
 * Estimated row height before measureElement reports the real one.
 * 64px is a reasonable midpoint between a single-line continuation
 * row (~32px) and a head row with avatar + meta + body (~96px). The
 * virtualizer remeasures on mount + ResizeObserver, so the estimate
 * only matters for the first paint's reserved height.
 */
const ESTIMATED_ROW_HEIGHT = 64;

/**
 * task-043: virtualized message list. Render order is oldest-first
 * ASC (index 0 at top). Virtualizer mounts only the visible window
 * + 8 rows of overscan, dropping DOM cost from O(N) to O(visible).
 *
 * Anchor invariants kept across virtualization:
 *   - First paint with non-empty history pins to bottom
 *     (`scrollToIndex(N-1, 'end')`) — same as the old non-virtualized
 *     behavior.
 *   - WS append (messages.length grows): if the user was within 100px
 *     of bottom, auto-scroll to the new last index. Otherwise hold.
 *   - History prepend (older page fetched): take a snapshot of the
 *     top visible row's id + in-row offset BEFORE the fetch, then
 *     after the new pages land restore scrollTop to keep that row
 *     pinned to the same position. Avoids the "user scrolls up,
 *     screen jumps to new old messages" bug.
 *
 * Older-fetch trigger replaces the earlier `useScrollFetch` (DOM
 * scroll listener) with the same listener inlined here so we can
 * snapshot the anchor at the same instant the fetch is queued.
 */
export function MessageList({
  workspaceId,
  channelId,
  onOpenThread,
  extraNames,
}: Props): JSX.Element {
  const { user } = useAuth();
  const { data: members } = useMembers(workspaceId ?? undefined);
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

  const messageIds = useMemo(() => messages.map((m) => m.id), [messages]);

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

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 8,
  });

  // task-021-R1-scroll-jumps-on-new-message: track whether the user
  // was anchored to the bottom BEFORE the latest append.
  const wasAtBottomRef = useRef(true);
  const hasAnchoredRef = useRef(false);
  // task-043 B-1: snapshot of the topmost visible row before a
  // history-prepend so we can restore the scroll anchor afterward.
  const anchorSnapshotRef = useRef<AnchorSnapshot | null>(null);
  // Length BEFORE the latest render. Used to detect prepends.
  const prevLengthRef = useRef(0);
  // task-043 reviewer H4: track the FIRST id and the LAST id from the
  // previous render so the layout effect can tell prepend (first id
  // changed) from append (last id changed) when the snapshot is set
  // but a WS message arrives before the older page lands.
  const prevFirstIdRef = useRef<string | null>(null);
  const prevLastIdRef = useRef<string | null>(null);

  // task-043 reviewer H5: refs mirror the closures the scroll listener
  // needs so the listener can attach exactly once and never see stale
  // state. Without these the effect re-binds on every messages-array
  // change (every WS message), opening a remove/add window where
  // momentum-scroll events can be dropped.
  const messageIdsRef = useRef(messageIds);
  messageIdsRef.current = messageIds;
  const historyRef = useRef(history);
  historyRef.current = history;
  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;

  // Scroll listener: track bottom-near for B-2 + trigger older-page
  // fetch when the user crosses the top threshold. Attached ONCE per
  // mount (refs above carry the latest closure data).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = (): void => {
      wasAtBottomRef.current = isNearBottom({
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        slack: 100,
      });
      const h = historyRef.current;
      if (el.scrollTop < 100 && h.hasNextPage && !h.isFetchingNextPage) {
        // Snapshot BEFORE kicking off the fetch so the post-prepend
        // layout effect knows where to restore.
        anchorSnapshotRef.current = takeAnchorSnapshot({
          scrollTop: el.scrollTop,
          virtualItems: virtualizerRef.current.getVirtualItems(),
          messageIds: messageIdsRef.current,
        });
        void h.fetchNextPage();
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // task-021-R1: on channel switch, reset anchor + snapshot state.
  useEffect(() => {
    hasAnchoredRef.current = false;
    wasAtBottomRef.current = true;
    anchorSnapshotRef.current = null;
    prevLengthRef.current = 0;
    prevFirstIdRef.current = null;
    prevLastIdRef.current = null;
  }, [channelId]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || messages.length === 0) {
      prevLengthRef.current = messages.length;
      prevFirstIdRef.current = null;
      prevLastIdRef.current = null;
      return;
    }

    const prevLen = prevLengthRef.current;
    const prevFirstId = prevFirstIdRef.current;
    const prevLastId = prevLastIdRef.current;
    const newFirstId = messageIds[0] ?? null;
    const newLastId = messageIds[messageIds.length - 1] ?? null;
    prevLengthRef.current = messages.length;
    prevFirstIdRef.current = newFirstId;
    prevLastIdRef.current = newLastId;

    // First paint with non-empty history → pin to bottom.
    if (!hasAnchoredRef.current) {
      virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
      hasAnchoredRef.current = true;
      wasAtBottomRef.current = true;
      return;
    }

    // task-043 reviewer H4: distinguish prepend vs append by which end
    // of the array changed. Prepend = newFirstId differs from prev
    // first id (older page landed at index 0). Append = newLastId
    // differs from prev last id (WS event added to the tail). Length
    // grew but neither end changed → idempotent re-render, do nothing.
    const isPrepend =
      messages.length > prevLen && prevFirstId !== null && newFirstId !== prevFirstId;
    const isAppend = messages.length > prevLen && prevLastId !== null && newLastId !== prevLastId;

    // History prepend: restore the snapshot anchor.
    if (isPrepend && anchorSnapshotRef.current) {
      const restored = restoreAnchorScrollTop({
        snapshot: anchorSnapshotRef.current,
        messageIds,
        startForIndex: (i) => {
          const item = virtualizer.getVirtualItems().find((v) => v.index === i);
          if (item) return item.start;
          // Fallback: read the virtualizer's measurementsCache which
          // holds heights for every measured row; ESTIMATED_ROW_HEIGHT
          // is the floor for never-seen rows.
          const cache = virtualizer.measurementsCache;
          const cached = cache && cache[i];
          if (cached && typeof cached.start === 'number') return cached.start;
          return i * ESTIMATED_ROW_HEIGHT;
        },
      });
      anchorSnapshotRef.current = null;
      if (restored !== null) {
        // Clamp negative scrollTop to 0 (browsers do this anyway).
        el.scrollTop = Math.max(0, restored);
        return;
      }
    }

    // WS append: bottom-near → auto scroll-to-bottom. Also clear any
    // stale snapshot — the scroll listener may have set one without a
    // prepend ever landing (e.g. user scrolled up while at top
    // threshold but the fetch was deduped because hasNextPage flipped
    // to false).
    if (isAppend) {
      anchorSnapshotRef.current = null;
      if (wasAtBottomRef.current) {
        virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
      }
    }
    // Otherwise hold position; the user has scrolled up and a new
    // message arrived. Existing unread / new-message divider UX
    // (when added) layers on top of this hold.
  }, [messages.length, messageIds, virtualizer]);

  const items = virtualizer.getVirtualItems();

  return (
    <CustomEmojiProvider workspaceId={workspaceId}>
      <Scrollable
        ref={scrollRef}
        data-testid="msg-list"
        role="log"
        aria-live="polite"
        aria-label="메시지"
        // task-043 reviewer H2: the `py-[var(--s-3)]` padding used to
        // sit on this Scrollable, but the inner `virtual-list-inner`
        // wrapper carries `height: virtualizer.getTotalSize()` which
        // is anchored at offsetTop=0 inside the scroll container.
        // External padding offset the inner-wrapper top by 8px and
        // every restoreAnchorScrollTop drifted by exactly that
        // amount. Move the visual breathing room INTO the inner
        // wrapper so the virtualizer's coordinate system stays
        // congruent with `el.scrollTop`.
        className="flex-1"
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
        ) : (
          <div
            data-testid="virtual-list-inner"
            style={{
              height: virtualizer.getTotalSize(),
              position: 'relative',
              width: '100%',
            }}
          >
            {items.map((vi) => {
              const m = messages[vi.index];
              if (!m) return null;
              const prev = vi.index > 0 ? messages[vi.index - 1] : null;
              const isContinuation =
                !!prev &&
                !prev.deleted &&
                !m.deleted &&
                prev.authorId === m.authorId &&
                prev.parentMessageId === m.parentMessageId &&
                new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < 5 * 60_000;
              return (
                <div
                  key={m.id}
                  data-testid="message-row"
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  <MessageItem
                    msg={m}
                    isMine={m.authorId === user?.id}
                    isContinuation={isContinuation}
                    authorName={nameById.get(m.authorId) ?? extraNames?.get(m.authorId)}
                    authorRole={roleById.get(m.authorId) ?? null}
                    onEditSave={async (content) => {
                      await updMut.mutateAsync({ msgId: m.id, content });
                    }}
                    onDelete={async () => {
                      await delMut.mutateAsync(m.id);
                    }}
                    onToggleReaction={(emoji, byMe) => {
                      if (m.id.startsWith('tmp-')) return;
                      reactMut.mutate({ messageId: m.id, emoji, currentlyByMe: byMe });
                    }}
                    onOpenThread={
                      onOpenThread && !m.id.startsWith('tmp-')
                        ? (rootId) => onOpenThread(rootId)
                        : undefined
                    }
                  />
                </div>
              );
            })}
          </div>
        )}
      </Scrollable>
    </CustomEmojiProvider>
  );
}
