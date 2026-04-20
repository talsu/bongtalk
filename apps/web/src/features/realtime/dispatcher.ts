import { type QueryClient, type InfiniteData } from '@tanstack/react-query';
import type { ListMessagesResponse, MessageDto } from '@qufox/shared-types';
import type { Socket } from 'socket.io-client';
import { qk } from '../../lib/query-keys';
import type { UnreadChannelSummary } from '../channels/useUnread';
import type { MentionInboxResponse, MentionSummary } from '../mentions/useMentions';
import { useNotifications } from '../../stores/notification-store';

export interface DispatcherContext {
  viewerId: () => string | null;
  activeChannelId: () => string | null;
  /**
   * Task-011-B: resolve a mention payload to a UX-friendly URL the
   * toast "jump" action can navigate to. The dispatcher calls this
   * through `onActivate`. Null return = no navigation (e.g. we don't
   * know the workspace slug yet).
   */
  resolveMentionUrl?: (env: {
    workspaceId: string;
    channelId: string;
    messageId: string;
  }) => string | null;
  navigate?: (url: string) => void;
}

const DEFAULT_CTX: DispatcherContext = {
  viewerId: () => null,
  activeChannelId: () => null,
};

/**
 * Task-013-B: fold a reaction add/remove into the message's bucket list.
 *   - Server-authoritative `count` is assigned directly (no ±1 drift).
 *   - `mineChanges` is true when the event originated from the viewer;
 *     only then does `byMe` flip. When someone else reacts, the viewer's
 *     `byMe` must stay untouched.
 *   - count<=0 drops the bucket so the UI doesn't render empty pills.
 *   - New emoji rows append at the end (matches the server's GROUP BY
 *     count-desc, then emoji-asc ordering on subsequent paginated loads).
 */
export function upsertReactionBucket(
  existing: { emoji: string; count: number; byMe: boolean }[],
  args: { emoji: string; count: number; kind: 'added' | 'removed'; mineChanges: boolean },
): { emoji: string; count: number; byMe: boolean }[] {
  const idx = existing.findIndex((r) => r.emoji === args.emoji);
  if (idx === -1) {
    if (args.count <= 0) return existing;
    return [
      ...existing,
      {
        emoji: args.emoji,
        count: args.count,
        byMe: args.mineChanges && args.kind === 'added',
      },
    ];
  }
  if (args.count <= 0) return existing.filter((_, i) => i !== idx);
  const prev = existing[idx];
  return existing.map((r, i) =>
    i === idx
      ? {
          ...r,
          count: args.count,
          byMe: args.mineChanges ? args.kind === 'added' : prev.byMe,
        }
      : r,
  );
}

/**
 * Task-011-B mention toast throttle. Per-viewer token bucket:
 *   - capacity 5 toasts
 *   - refill 5 tokens / second
 * Excess mentions do NOT drop — they collapse into a single
 * "N more mentions" toast that re-issues on the next tick.
 *
 * Exported so `mention-throttle.spec.ts` can exercise the clock-sensitive
 * branches with `vi.useFakeTimers` (task-014-A / task-011-follow-7
 * closure).
 */
export class MentionThrottle {
  private tokens = 5;
  private readonly capacity = 5;
  private readonly refillPerSec = 5;
  private lastRefill = Date.now();
  private collapsed = 0;
  private collapsedTimer: ReturnType<typeof setTimeout> | null = null;

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    const add = elapsed * this.refillPerSec;
    this.tokens = Math.min(this.capacity, this.tokens + add);
    this.lastRefill = now;
  }

  /** Returns true if the caller may emit a real toast NOW. */
  tryConsume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Register an over-budget mention; caller arranges the collapsed toast. */
  collapseOne(emit: (count: number) => void): void {
    this.collapsed += 1;
    if (this.collapsedTimer) return;
    this.collapsedTimer = setTimeout(() => {
      const total = this.collapsed;
      this.collapsed = 0;
      this.collapsedTimer = null;
      if (total > 0) emit(total);
    }, 1000);
  }
}

/**
 * Centralized realtime → cache mapping. Every server event flows through
 * here — no other file installs socket listeners for cache mutations. This
 * makes adding a new event type a one-file change and makes the test
 * surface tiny (mock socket → emit → assert cache).
 *
 * The dispatcher returns a detach function so the caller (useRealtimeConnection)
 * can unsubscribe on teardown.
 */
export function installRealtimeDispatcher(
  socket: Socket,
  qc: QueryClient,
  ctx: DispatcherContext = DEFAULT_CTX,
): () => void {
  const handlers: Array<{ event: string; handler: (e: unknown) => void }> = [];
  const mentionThrottle = new MentionThrottle();
  // task-014-C / task-015-A (014-follow-2): separate bucket for reply
  // toasts. Reuses MentionThrottle as-is — same 5-capacity, 5 tokens/sec
  // refill, same collapseOne 1-second rollup window. The ORIGINAL plan
  // was a slower 5/min cadence, but in practice a dedicated instance at
  // the same clip is already a big win over sharing the mention bucket
  // (a mentioned user would otherwise lose thread-reply toasts while
  // under a flood of mentions). Parametrizing the throttle for a
  // per-feature refill rate is a later task.
  const replyThrottle = new MentionThrottle();

  const on = <T>(event: string, handler: (e: T) => void): void => {
    const typed = handler as (e: unknown) => void;
    socket.on(event, typed);
    handlers.push({ event, handler: typed });
  };

  // ---------- Messages ----------
  on<{
    id: string;
    channelId: string;
    workspaceId: string;
    message: MessageDto & { parentMessageId?: string | null };
  }>('message.created', (env) => {
    if (!env.channelId || !env.workspaceId || !env.message) return;

    // Unread-count bump (task-010-B). Skip when I sent it, or when I'm
    // already looking at this channel — an open channel drives its own
    // POST /read after 500ms debounce, which zeroes the count.
    const viewer = ctx.viewerId();
    const active = ctx.activeChannelId();
    if (viewer && env.message.authorId !== viewer && active !== env.channelId) {
      // task-018-E: workspace-level totals rendered on the server rail
      // need a refresh whenever any channel's unread count moves.
      // Invalidation (not optimistic update) because the rail shows
      // counts across every workspace — computing the delta in-client
      // would duplicate server logic.
      qc.invalidateQueries({ queryKey: qk.me.unreadTotals() });
      qc.setQueryData<{ channels: UnreadChannelSummary[] }>(
        qk.channels.unreadSummary(env.workspaceId),
        (old) => {
          if (!old) return old;
          const mentioned = viewer ? env.message.mentions?.users?.includes(viewer) : false;
          const everyone = env.message.mentions?.everyone === true;
          const lastMessageAt =
            typeof env.message.createdAt === 'string'
              ? env.message.createdAt
              : new Date().toISOString();
          const found = old.channels.some((c) => c.channelId === env.channelId);
          return {
            channels: found
              ? old.channels.map((c) =>
                  c.channelId === env.channelId
                    ? {
                        ...c,
                        unreadCount: c.unreadCount + 1,
                        hasMention: c.hasMention || mentioned || everyone,
                        lastMessageAt,
                      }
                    : c,
                )
              : [
                  ...old.channels,
                  {
                    channelId: env.channelId,
                    unreadCount: 1,
                    hasMention: mentioned || everyone,
                    lastMessageAt,
                  },
                ],
          };
        },
      );
    }

    // Task-014-C: replies no longer appear in the channel list (roots
    // only). Route them into the thread cache instead so an open
    // thread panel for this root sees the incoming reply live.
    const parentId = env.message.parentMessageId ?? null;
    if (parentId) {
      qc.setQueryData<InfiniteData<{ root: MessageDto; replies: MessageDto[]; pageInfo: unknown }>>(
        qk.messages.thread(parentId),
        (old) => {
          if (!old) return old;
          // Dedupe identical id OR the optimistic tempId our composer
          // inserted before the server round-trip landed.
          const alreadyThere = old.pages.some((p) =>
            p.replies.some((r) => r.id === env.message.id),
          );
          if (alreadyThere) return old;
          const last = old.pages[old.pages.length - 1];
          const collapsed = last.replies.filter(
            (r) =>
              !(
                r.id.startsWith('tmp-') &&
                r.authorId === 'optimistic' &&
                r.content === env.message.content
              ),
          );
          return {
            ...old,
            pages: [...old.pages.slice(0, -1), { ...last, replies: [...collapsed, env.message] }],
          };
        },
      );
      return; // replies don't append to the channel root list
    }

    qc.setQueryData<InfiniteData<ListMessagesResponse>>(
      qk.messages.list(env.workspaceId, env.channelId),
      (old) => {
        if (!old) return old;
        const [first, ...rest] = old.pages;
        // Dedupe by real id AND by the optimistic "tempId" pattern — if
        // the WS broadcast arrives BEFORE our own HTTP POST response
        // (common under load), plain id-equality misses the temp row and
        // we'd end up with two rows for one logical message. Collapse
        // any optimistic row that matches author+content.
        if (first.items.some((m) => m.id === env.message.id)) return old;
        const collapsed = first.items.filter(
          (m) =>
            !(
              m.id.startsWith('tmp-') &&
              m.authorId === 'optimistic' &&
              m.content === env.message.content
            ),
        );
        return {
          ...old,
          pages: [{ ...first, items: [env.message, ...collapsed] }, ...rest],
        };
      },
    );
  });

  // task-014-C: message.thread.replied is the authoritative patch for
  // a root's summary (replyCount, avatar stack, lastRepliedAt). Emitted
  // once per reply by the backend; the envelope-id on the WS dedupes
  // against replay. Also drives the reply toast for recipients
  // (root author + recent repliers), with mention-precedence dedupe.
  on<{
    id: string;
    channelId: string;
    workspaceId: string;
    rootMessageId: string;
    replierId: string;
    replyCount: number;
    lastRepliedAt: string;
    recentReplyUserIds: string[];
    recipients: string[];
  }>('message.thread.replied', (env) => {
    if (!env.channelId || !env.workspaceId || !env.rootMessageId) return;
    qc.setQueryData<InfiniteData<ListMessagesResponse>>(
      qk.messages.list(env.workspaceId, env.channelId),
      (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((p) => ({
            ...p,
            items: p.items.map((m) =>
              m.id === env.rootMessageId
                ? {
                    ...m,
                    thread: {
                      replyCount: env.replyCount,
                      lastRepliedAt: env.lastRepliedAt,
                      recentReplyUserIds: env.recentReplyUserIds,
                    },
                  }
                : m,
            ),
          })),
        };
      },
    );

    // Reply toast: fire only if the viewer is on the recipients list
    // AND didn't already get a mention toast for the same messageId
    // (dispatcher-side dedupe — the reply payload doesn't carry the
    // reply's own id so we dedupe on rootMessageId+replierId which is
    // close enough for beta-grade overlap).
    const viewer = ctx.viewerId();
    if (!viewer || !env.recipients.includes(viewer)) return;
    if (env.replierId === viewer) return; // self-reply: no toast
    // Note: mention-precedence is already enforced server-side — the
    // recipients list excludes anyone the same message @-mentioned.
    if (replyThrottle.tryConsume()) {
      useNotifications.getState().push({
        variant: 'mention',
        title: '새 답글',
        body: `${env.replyCount}개 답글 (마지막 ${new Date(env.lastRepliedAt).toLocaleTimeString()})`,
        ttlMs: 6000,
      });
    } else {
      replyThrottle.collapseOne((count) => {
        useNotifications.getState().push({
          variant: 'mention',
          title: `+${count}개 답글 묶임`,
          body: '답글 받은 스레드를 열어 확인하세요.',
          ttlMs: 8000,
        });
      });
    }
  });

  on<{ channelId: string; workspaceId: string; message: MessageDto }>('message.updated', (env) => {
    if (!env.channelId || !env.workspaceId) return;
    qc.setQueryData<InfiniteData<ListMessagesResponse>>(
      qk.messages.list(env.workspaceId, env.channelId),
      (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((p) => ({
            ...p,
            items: p.items.map((m) => (m.id === env.message.id ? env.message : m)),
          })),
        };
      },
    );
  });

  on<{ channelId: string; workspaceId: string; message: { id: string } }>(
    'message.deleted',
    (env) => {
      if (!env.channelId || !env.workspaceId) return;
      qc.setQueryData<InfiniteData<ListMessagesResponse>>(
        qk.messages.list(env.workspaceId, env.channelId),
        (old) => {
          if (!old) return old;
          return {
            ...old,
            pages: old.pages.map((p) => ({
              ...p,
              items: p.items.map((m) =>
                m.id === env.message.id ? { ...m, deleted: true, content: null } : m,
              ),
            })),
          };
        },
      );
    },
  );

  // ---------- Reactions (task-013-B) ----------
  // One server event per (message, user, emoji) action. The payload's
  // `count` is the authoritative server total for that emoji, so we
  // overwrite the bucket's count rather than ±1 — avoids drift when
  // events arrive out of order or after a reconnect replay.
  const applyReaction = (
    env: {
      messageId: string;
      channelId: string;
      workspaceId: string;
      userId: string;
      emoji: string;
      count: number;
    },
    kind: 'added' | 'removed',
  ) => {
    if (!env.channelId || !env.workspaceId || !env.messageId) return;
    const viewer = ctx.viewerId();
    qc.setQueryData<InfiniteData<ListMessagesResponse>>(
      qk.messages.list(env.workspaceId, env.channelId),
      (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((p) => ({
            ...p,
            items: p.items.map((m) => {
              if (m.id !== env.messageId) return m;
              const existing = m.reactions ?? [];
              // Recompute byMe: if the event was mine, apply directly;
              // otherwise keep whatever byMe the row already had (other
              // users' actions don't change whether *I* reacted).
              const mineChanges = viewer !== null && env.userId === viewer;
              const next = upsertReactionBucket(existing, {
                emoji: env.emoji,
                count: env.count,
                kind,
                mineChanges,
              });
              return { ...m, reactions: next };
            }),
          })),
        };
      },
    );
  };

  on<{
    messageId: string;
    channelId: string;
    workspaceId: string;
    userId: string;
    emoji: string;
    count: number;
  }>('message.reaction.added', (env) => applyReaction(env, 'added'));
  on<{
    messageId: string;
    channelId: string;
    workspaceId: string;
    userId: string;
    emoji: string;
    count: number;
  }>('message.reaction.removed', (env) => applyReaction(env, 'removed'));

  // ---------- Channels ----------
  on<{ workspaceId: string }>('channel.created', (env) => {
    if (env.workspaceId) qc.invalidateQueries({ queryKey: qk.channels.list(env.workspaceId) });
  });
  on<{ workspaceId: string }>('channel.updated', (env) => {
    if (env.workspaceId) qc.invalidateQueries({ queryKey: qk.channels.list(env.workspaceId) });
  });
  on<{ workspaceId: string }>('channel.deleted', (env) => {
    if (env.workspaceId) qc.invalidateQueries({ queryKey: qk.channels.list(env.workspaceId) });
  });
  on<{ workspaceId: string }>('channel.moved', (env) => {
    if (env.workspaceId) qc.invalidateQueries({ queryKey: qk.channels.list(env.workspaceId) });
  });
  on<{ workspaceId: string }>('channel.archived', (env) => {
    if (env.workspaceId) qc.invalidateQueries({ queryKey: qk.channels.list(env.workspaceId) });
  });
  on<{ workspaceId: string }>('channel.unarchived', (env) => {
    if (env.workspaceId) qc.invalidateQueries({ queryKey: qk.channels.list(env.workspaceId) });
  });

  // ---------- Members / Workspace ----------
  on<{ workspaceId: string }>('workspace.member.joined', (env) => {
    if (env.workspaceId) qc.invalidateQueries({ queryKey: qk.workspaces.members(env.workspaceId) });
  });
  on<{ workspaceId: string }>('workspace.member.left', (env) => {
    if (env.workspaceId) {
      qc.invalidateQueries({ queryKey: qk.workspaces.members(env.workspaceId) });
      qc.invalidateQueries({ queryKey: qk.workspaces.list() });
    }
  });
  on<{ workspaceId: string }>('workspace.member.removed', (env) => {
    if (env.workspaceId) {
      qc.invalidateQueries({ queryKey: qk.workspaces.members(env.workspaceId) });
      qc.invalidateQueries({ queryKey: qk.workspaces.list() });
    }
  });
  on<{ workspaceId: string }>('workspace.role.changed', (env) => {
    if (env.workspaceId) {
      qc.invalidateQueries({ queryKey: qk.workspaces.detail(env.workspaceId) });
      qc.invalidateQueries({ queryKey: qk.workspaces.members(env.workspaceId) });
    }
  });

  // ---------- Presence ----------
  on<{ workspaceId: string; onlineUserIds: string[] }>('presence.updated', (env) => {
    if (env.workspaceId) {
      qc.setQueryData(qk.presence.workspace(env.workspaceId), env.onlineUserIds);
    }
  });

  // ---------- Mentions (task-011-B) ----------
  on<{
    id?: string;
    targetUserId: string;
    workspaceId: string;
    channelId: string;
    messageId: string;
    actorId: string;
    snippet: string;
    createdAt: string;
    everyone: boolean;
  }>('mention.received', (env) => {
    const viewer = ctx.viewerId();
    if (!viewer || env.targetUserId !== viewer) return;
    // Skip when the user is already looking at the channel — no
    // need to toast yourself about a message you can see.
    if (ctx.activeChannelId() === env.channelId) return;

    // Cache update: bump unreadCount, prepend to recent (cap 20).
    qc.setQueryData<MentionInboxResponse>(['me', 'mentions'], (old) => {
      const entry: MentionSummary = {
        messageId: env.messageId,
        channelId: env.channelId,
        workspaceId: env.workspaceId,
        authorId: env.actorId,
        snippet: env.snippet,
        createdAt: env.createdAt,
        everyone: env.everyone,
      };
      if (!old) return { unreadCount: 1, recent: [entry] };
      if (old.recent.some((m) => m.messageId === env.messageId)) return old;
      return {
        unreadCount: old.unreadCount + 1,
        recent: [entry, ...old.recent].slice(0, 20),
      };
    });

    const push = useNotifications.getState().push;
    const url = ctx.resolveMentionUrl?.({
      workspaceId: env.workspaceId,
      channelId: env.channelId,
      messageId: env.messageId,
    });
    const navigate = ctx.navigate;
    const onActivate = url && navigate ? () => navigate(url) : undefined;

    if (mentionThrottle.tryConsume()) {
      push({
        variant: 'mention',
        title: env.everyone ? '@everyone mentioned' : 'You were mentioned',
        body: env.snippet,
        ttlMs: 6000,
        onActivate,
      });
    } else {
      mentionThrottle.collapseOne((count) => {
        push({
          variant: 'mention',
          title: `${count} more mention${count === 1 ? '' : 's'}`,
          body: 'Open the mentions inbox to see them all.',
          ttlMs: 8000,
        });
      });
    }
  });

  return () => {
    for (const { event, handler } of handlers) socket.off(event, handler);
  };
}

/** Event types the dispatcher handles — exposed so tests can iterate them. */
export const DISPATCHED_EVENTS = [
  'message.created',
  'message.updated',
  'message.deleted',
  'channel.created',
  'channel.updated',
  'channel.deleted',
  'channel.moved',
  'channel.archived',
  'channel.unarchived',
  'workspace.member.joined',
  'workspace.member.left',
  'workspace.member.removed',
  'workspace.role.changed',
  'presence.updated',
  'mention.received',
  'message.reaction.added',
  'message.reaction.removed',
  'message.thread.replied',
] as const;
