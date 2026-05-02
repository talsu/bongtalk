/**
 * task-043 B-1: pure helpers for the history-prepend scroll anchor.
 *
 * The MessageList renders oldest-first (index 0 = top, last = bottom).
 * `useMessageHistory` paginates DESC pages but the component reverses
 * to ASC for render order. When the user scrolls near the top
 * (`scrollTop < 100`), `useScrollFetch` calls `fetchNextPage` which
 * fetches the OLDER page; that page is appended to the InfiniteQuery
 * pages list and after `.flatMap(p => p.items).reverse()` the new
 * older messages appear at index 0 of `messages[]` — every existing
 * message's index shifts forward by `prependCount`.
 *
 * Without compensation the virtualizer keeps the same scrollTop and
 * the user's view jumps to the new old messages. The fix:
 *   1. Before calling fetchNextPage, snapshot (id, scrollOffset) of
 *      the FIRST message currently visible at the top.
 *   2. After the new pages land and the messages array updates,
 *      compute the new index of that id and the virtualizer's start
 *      offset for the new index.
 *   3. Set scrollTop = newStart + savedOffset (idempotent: applying
 *      the same delta twice yields the same result).
 *
 * These two helpers split the snapshot/restore math from React so a
 * unit spec can assert the offset arithmetic without rendering.
 */

export interface AnchorSnapshot {
  /** id of the message currently anchored at the top of the viewport. */
  messageId: string;
  /**
   * Offset within that row at the moment of the snapshot. Equal to
   * `scrollTop - virtualItem.start` of the anchored row. Stays stable
   * across the prepend because we re-add the new start after fetch.
   */
  offsetWithinRow: number;
}

export interface VirtualItemLike {
  index: number;
  start: number;
}

/**
 * Take a snapshot of the topmost visible row plus its in-row offset.
 * Returns null when the message list is empty (nothing to anchor).
 */
export function takeAnchorSnapshot(args: {
  scrollTop: number;
  virtualItems: VirtualItemLike[];
  messageIds: ReadonlyArray<string>;
}): AnchorSnapshot | null {
  const { scrollTop, virtualItems, messageIds } = args;
  if (virtualItems.length === 0 || messageIds.length === 0) return null;
  // The first virtualItem returned by react-virtual is the top of the
  // visible window. Use that as the anchor.
  const top = virtualItems[0];
  const id = messageIds[top.index];
  if (!id) return null;
  return {
    messageId: id,
    offsetWithinRow: scrollTop - top.start,
  };
}

/**
 * After a prepend, compute the scrollTop that re-anchors the visible
 * top to the same message + in-row offset. Returns null when the
 * anchor message is no longer in the new list (rare — server returned
 * a different shape) so the caller can fall back to no-op.
 */
export function restoreAnchorScrollTop(args: {
  snapshot: AnchorSnapshot;
  messageIds: ReadonlyArray<string>;
  /** Resolves the virtualItem.start for a given index after layout. */
  startForIndex: (index: number) => number | undefined;
}): number | null {
  const { snapshot, messageIds, startForIndex } = args;
  const newIndex = messageIds.indexOf(snapshot.messageId);
  if (newIndex < 0) return null;
  const newStart = startForIndex(newIndex);
  if (newStart === undefined) return null;
  return newStart + snapshot.offsetWithinRow;
}

/**
 * Bottom-near judgement reused by the WS-append auto-scroll path.
 * Returns true iff the user is within `slack` pixels of the bottom.
 */
export function isNearBottom(args: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  slack?: number;
}): boolean {
  const slack = args.slack ?? 100;
  return args.scrollHeight - args.scrollTop - args.clientHeight <= slack;
}
