import { type QueryClient, type InfiniteData } from '@tanstack/react-query';
import {
  WS_EVENTS,
  type ListMessagesResponse,
  type MessageDto,
  type PresenceUpdatePayload,
  type WorkspacePresenceUpdatedPayload,
} from '@qufox/shared-types';
import type { Socket } from 'socket.io-client';
import { qk } from '../../lib/query-keys';
import type { UnreadChannelSummary } from '../channels/useUnread';
import type { MentionInboxResponse, MentionSummary } from '../mentions/useMentions';
import { useNotifications } from '../../stores/notification-store';
import { useTypingStore } from '../typing/useTypingStore';
import { useReadState } from './readStateStore';

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
  /**
   * Task-019-D: consult the user's notification preferences before
   * firing a toast / browser Notification. Returns the delivery
   * channel; `OFF` means the dispatcher skips the notify call. Caller
   * passes the concrete event type matching NotificationEventType.
   */
  resolveNotificationChannel?: (
    workspaceId: string,
    eventType: 'MENTION' | 'REPLY' | 'REACTION' | 'DIRECT',
  ) => 'TOAST' | 'BROWSER' | 'BOTH' | 'OFF';
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
    // S03 (FR-MSG-04): clientNonce echo. Present on sends that carried a nonce;
    // the SENDING tab uses it to swap its optimistic row deterministically.
    // Other tabs / devices ignore it and dedupe by messageId (FR-RT-24).
    nonce?: string | null;
    message: MessageDto & { parentMessageId?: string | null };
  }>('message.created', (env) => {
    if (!env.channelId || !env.workspaceId || !env.message) return;

    // S30 (FR-S07): 검색 결과 패널이 열려 있는 동안 새 메시지가 들어오면
    // "새 결과가 있을 수 있습니다" 배너의 신호로 쓴다. 정교한 매칭 판정 대신
    // 단순 워크스페이스 활동 신호만 흘린다(과한 판정은 carryover). 검색 패널
    // hook 이 이 window 이벤트를 구독해 banner 플래그를 켠다.
    //
    // S30 fix-forward (MAJOR M3): 본인이 보낸 메시지에는 배너를 켜지 않는다.
    // 종전엔 author 무관 발화라 자기 전송에도 "새 결과" 배너가 떠 노이즈였다.
    // (전 워크스페이스 활동에 발화하는 광범위 노이즈의 정밀 매칭은 carryover —
    // 여기서는 자기메시지 스킵만 적용한다.)
    const viewer = ctx.viewerId();
    if (typeof window !== 'undefined' && env.message.authorId !== viewer) {
      window.dispatchEvent(
        new CustomEvent('qufox.search.activity', { detail: { workspaceId: env.workspaceId } }),
      );
    }

    // task-027-E: DM channels feed the DM list cache too. Invalidation
    // only — the server ranking (last-message desc + unread counts)
    // is the source of truth.
    qc.invalidateQueries({ queryKey: ['dm', 'list'] });

    // Unread-count bump (task-010-B). Skip when I sent it, or when I'm
    // already looking at this channel — an open channel drives its own
    // POST /read after 500ms debounce, which zeroes the count. (viewer 는
    // 위 search.activity 분기에서 이미 읽어둔 값을 재사용한다.)
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
          // S21 (FR-RS-16): 멘션이면 mentionCount 도 +1. 서버 권위 카운트는
          // read_state:updated / refetch 가 덮어쓴다(낙관적 +1 은 근사치).
          // S21 fix-forward (MAJOR-D): @here / @channel 범위 멘션도 라이브 배지에
          // 반영해 reload(서버 집계)와 일치시킨다. 종전엔 here/channel 을 무시해
          // 새 메시지 수신 시 배지가 깜빡였다 reload 로만 채워졌다.
          const isMention =
            !!mentioned ||
            everyone ||
            env.message.mentions?.here === true ||
            env.message.mentions?.channel === true;
          return {
            channels: found
              ? old.channels.map((c) =>
                  c.channelId === env.channelId
                    ? {
                        ...c,
                        unreadCount: c.unreadCount + 1,
                        mentionCount: c.mentionCount + (isMention ? 1 : 0),
                        hasMention: c.hasMention || isMention,
                        lastMessageAt,
                      }
                    : c,
                )
              : [
                  ...old.channels,
                  {
                    channelId: env.channelId,
                    unreadCount: 1,
                    mentionCount: isMention ? 1 : 0,
                    hasMention: isMention,
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
        // FR-RT-24: always dedupe by real messageId first (idempotent across
        // tabs / a racing HTTP-POST onSuccess).
        if (first.items.some((m) => m.id === env.message.id)) return old;
        // S03 (FR-MSG-04): if this echo carries our clientNonce, swap the
        // matching optimistic row (`tmp-<nonce>`) deterministically — no
        // author/content heuristic needed.
        const optimisticId = env.nonce ? `tmp-${env.nonce}` : null;
        if (optimisticId && first.items.some((m) => m.id === optimisticId)) {
          return {
            ...old,
            pages: [
              {
                ...first,
                items: first.items.map((m) => (m.id === optimisticId ? env.message : m)),
              },
              ...rest,
            ],
          };
        }
        // Fallback (no nonce, or WS broadcast arrived before our own optimistic
        // insert): collapse any optimistic row matching author+content so a
        // single logical message never renders twice.
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
    // task-026-E: replies to the viewer's threads feed Activity. Skip
    // the invalidation if the viewer is the replier (you don't need
    // a badge for your own reply).
    const viewerForActivity = ctx.viewerId();
    if (viewerForActivity && env.replierId !== viewerForActivity) {
      qc.invalidateQueries({ queryKey: ['me', 'activity'] });
    }
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
    // task-019-D: gate reply toast by preference.
    const replyChannel = ctx.resolveNotificationChannel?.(env.workspaceId, 'REPLY') ?? 'BOTH';
    if (replyChannel === 'OFF' || replyChannel === 'BROWSER') return;
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

  on<{
    channelId: string;
    workspaceId: string;
    message: Partial<MessageDto> & { id: string };
  }>('message.updated', (env) => {
    if (!env.channelId || !env.workspaceId) return;
    qc.setQueryData<InfiniteData<ListMessagesResponse>>(
      qk.messages.list(env.workspaceId, env.channelId),
      (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((p) => ({
            ...p,
            // S05 (FR-MSG-06): WS 페이로드는 편집된 본문 + 새 version 만 담은
            // 부분 DTO. 기존 캐시 행 위에 merge 해 reactions/thread/attachments
            // 등 미동봉 필드를 보존하고 version 을 갱신한다(다음 편집의 낙관적
            // 잠금 기준이 최신값이 되도록).
            items: p.items.map((m) => (m.id === env.message.id ? { ...m, ...env.message } : m)),
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
          // S05 (FR-MSG-09): 스레드 reply 가 달린 root 는 플레이스홀더로 대체
          // (deleted:true 마킹 → MessageItem 이 "(삭제된 메시지)" 렌더), reply
          // 없는 단독 메시지는 목록에서 즉시 제거. reply 존재 여부는 캐시 행의
          // thread.replyCount 로 판정한다(서버 events 스키마 변경 없이 결정).
          return {
            ...old,
            pages: old.pages.map((p) => {
              const target = p.items.find((m) => m.id === env.message.id);
              const isThreadRootWithReplies =
                !!target &&
                target.parentMessageId === null &&
                !!target.thread &&
                target.thread.replyCount > 0;
              if (target && !isThreadRootWithReplies) {
                // 단독 메시지(또는 reply 자신) → 즉시 제거.
                return { ...p, items: p.items.filter((m) => m.id !== env.message.id) };
              }
              return {
                ...p,
                items: p.items.map((m) =>
                  m.id === env.message.id ? { ...m, deleted: true, content: null } : m,
                ),
              };
            }),
          };
        },
      );
    },
  );

  // task-045 iter1: pinned message toggle. payload 의 pinnedAt 가 null
  // 이면 unpin, ISO string 이면 pin. 채널 룸 fanout 이라 받는 즉시
  // 모든 시청자의 cache 행에 patch 적용. workspaceId 가 null 인 DM
  // 채널은 BE 가 emit 자체를 안 하므로 이 핸들러로 흘러들어오지 않음.
  on<{
    channelId: string;
    workspaceId: string | null;
    messageId: string;
    pinnedAt: string | null;
    pinnedBy: string | null;
  }>('message.pin.toggled', (env) => {
    if (!env.channelId || !env.workspaceId || !env.messageId) return;
    qc.setQueryData<InfiniteData<ListMessagesResponse>>(
      qk.messages.list(env.workspaceId, env.channelId),
      (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((p) => ({
            ...p,
            items: p.items.map((m) =>
              m.id === env.messageId ? { ...m, pinnedAt: env.pinnedAt, pinnedBy: env.pinnedBy } : m,
            ),
          })),
        };
      },
    );
  });

  // ---------- Read state (S21 · FR-RS-01) ----------
  // read_state:updated 는 호출자의 user:{userId} 룸으로만 emit 된다(ACK 한
  // 기기 + 다른 기기/탭). 한 기기에서 채널을 읽으면 다른 기기의 사이드바
  // 배지를 즉시 맞춘다. S21 fix-forward (NIT-G): 페이로드에 workspaceId 가
  // 실리면 `qk.channels.unreadSummary(workspaceId)` 키를 직접 patch 해 전체
  // 쿼리캐시 스캔을 피한다. 구 서버 페이로드(workspaceId 누락)는 종전대로
  // 캐시된 모든 unread-summary 쿼리를 훑어 channelId 일치 행을 patch 한다.
  on<{
    channelId: string;
    workspaceId?: string | null;
    lastReadMessageId: string | null;
    unreadCount: number;
    mentionCount?: number;
  }>('read_state:updated', (env) => {
    if (!env.channelId) return;
    const mentionCount = env.mentionCount ?? 0;
    // S23 MAJOR fix: 다른 기기/탭(또는 본인)의 ACK 가 커서를 전진시키면
    // readStateStore 도 따라가게 한다 — NEW MESSAGES 구분선의 lastRead 출처가
    // 멀티세션에서 정합하도록(서버 권위). 단, lastReadMessageId 가 non-null 일
    // 때만 전진한다. null(아직 커서가 없거나 unread 가 남은 상태)일 때 store 를
    // 삭제하면 S09 around-reload seam(readStateStore 의 around=lastRead 재로드)을
    // 파괴하므로 clear 하지 않고 기존 값을 유지한다(後進·소실 방지).
    if (env.lastReadMessageId !== null && env.lastReadMessageId !== undefined) {
      useReadState.getState().setLastRead(env.channelId, env.lastReadMessageId);
    }
    // 워크스페이스 레일 합계는 다시 계산하기보다 무효화(서버 권위).
    qc.invalidateQueries({ queryKey: qk.me.unreadTotals() });

    const patchSummary = (old: { channels: UnreadChannelSummary[] } | undefined) => {
      if (!old || !old.channels.some((c) => c.channelId === env.channelId)) return old;
      return {
        channels: old.channels.map((c) =>
          c.channelId === env.channelId
            ? {
                ...c,
                unreadCount: env.unreadCount,
                mentionCount,
                hasMention: mentionCount > 0,
              }
            : c,
        ),
      };
    };

    // NIT-G: workspaceId 가 있으면 keyed 쿼리 직접 patch(스캔 없음).
    if (env.workspaceId) {
      qc.setQueryData<{ channels: UnreadChannelSummary[] }>(
        qk.channels.unreadSummary(env.workspaceId),
        patchSummary,
      );
      return;
    }

    // 폴백: workspaceId 누락 시 캐시된 unread-summary 쿼리들 중 이 채널 행을
    // 가진 것을 patch.
    const queries = qc.getQueryCache().findAll({ queryKey: ['workspaces'] });
    for (const q of queries) {
      const key = q.queryKey;
      // ['workspaces', wsId, 'unread-summary'] 형태만 대상.
      if (!Array.isArray(key) || key[2] !== 'unread-summary') continue;
      qc.setQueryData<{ channels: UnreadChannelSummary[] }>(key, patchSummary);
    }
  });

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
  }>('message.reaction.added', (env) => {
    applyReaction(env, 'added');
    // task-026-E: reactions on the viewer's own messages feed the
    // Activity inbox — invalidate both list + unread counts so the
    // Bell / tabbar badge reflect the increment within ~1 RTT.
    qc.invalidateQueries({ queryKey: ['me', 'activity'] });
  });
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

  // ---------- Typing (task-018-F / S32 · FR-RT-09) ----------
  // 정본은 콜론 이벤트입니다.
  //   typing:update — 단건 snapshot { channelId, typingUserIds }
  //   typing:batch  — full snapshot { channelId, typingUserIds } (3명 이상 시 주기 emit)
  // S32 fix-forward(contract CRITICAL · 4팀 합의): 두 이벤트의 와이어 필드명을
  // `typingUserIds` 로 통일했습니다(종전 typing:batch 의 `userIds` 키 제거).
  // 둘 다 full-replace 로 store 에 반영합니다(merge 아님). store 가 userId 별
  // 10초 타이머로 자동 소멸을 관리합니다. 배포 롤아웃 윈도우 동안 구 서버의 점
  // 표기 `typing.updated` 도 alias 로 구독합니다(무회귀).
  on<{ channelId: string; typingUserIds?: string[] }>(WS_EVENTS.TYPING_UPDATE, (env) => {
    if (!env.channelId) return;
    useTypingStore.getState().set(env.channelId, env.typingUserIds ?? []);
  });
  on<{ channelId: string; typingUserIds?: string[] }>(WS_EVENTS.TYPING_BATCH, (env) => {
    if (!env.channelId) return;
    useTypingStore.getState().set(env.channelId, env.typingUserIds ?? []);
  });
  // 롤아웃 호환 alias: 구 서버 점 표기 단건 이벤트.
  on<{ channelId: string; typingUserIds?: string[] }>('typing.updated', (env) => {
    if (!env.channelId) return;
    useTypingStore.getState().set(env.channelId, env.typingUserIds ?? []);
  });
  // S32 (FR-RT-09): 소켓이 끊기면 모든 타이핑 인디케이터를 즉시 클리어 + 타이머
  // 정리. 재연결 후 서버가 최신 snapshot 을 다시 내려보내므로 stale 인디케이터가
  // 잔류하지 않게 합니다.
  on<unknown>('disconnect', () => {
    useTypingStore.getState().clearAll();
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
  // S25 fix-forward(contract HIGH): typed via WorkspacePresenceUpdatedPayload +
  // the WS_EVENTS constant (was a raw string literal + inline shape). The wire
  // name stays the dot form `presence.updated` — colon rename is an S10
  // carryover. online/dnd/idle are guaranteed arrays now (server always sends
  // all three), but we keep the ?? [] defence for older-server compatibility.
  on<WorkspacePresenceUpdatedPayload>(WS_EVENTS.WORKSPACE_PRESENCE_UPDATED, (env) => {
    if (!env.workspaceId) return;
    // Write the full shape so the usePresence hook can reconstruct the
    // online + dnd + idle sets from the cache; mounts that arrive after the
    // socket's initial snapshot still read the latest state instead of
    // sitting at empty until the next broadcast.
    qc.setQueryData(qk.presence.workspace(env.workspaceId), {
      online: env.onlineUserIds ?? [],
      dnd: env.dndUserIds ?? [],
      idle: env.idleUserIds ?? [],
    });
  });

  // S26 (FR-P16): per-user precise presence push from subscription fan-out.
  // The server emits presence:update to a socket ONLY for users it subscribed
  // to (presence:subscribe). Distinct from the coarse workspace broadcast
  // above: this carries a single user's masked status and lands under a
  // per-user cache key, so a DM peer / viewport-watched member's dot updates
  // even with no shared workspace snapshot. The set of events a tab receives
  // is gated server-side by the subscription Set + authz, so no extra
  // filtering is needed here.
  on<PresenceUpdatePayload>(WS_EVENTS.PRESENCE_UPDATE, (env) => {
    if (!env.userId) return;
    qc.setQueryData(qk.presence.user(env.userId), {
      status: env.status,
      updatedAt: env.updatedAt,
    });
  });

  // ---------- task-045 iter7: user profile (custom status) ----------
  // 본인 또는 다른 사용자의 customStatus 변경 broadcast. dispatcher 는
  // workspace 멤버 list react-query cache 의 user 객체에 customStatus 만
  // 패치 — 큰 invalidate 보다 효율적. 멤버 list 가 없으면 무영향.
  on<{ userId: string; customStatus: string | null }>('user.profile.updated', (env) => {
    if (!env.userId) return;
    // 모든 workspace members 캐시 키를 순회 — env 에 workspaceId 가 없어
    // 사용자가 속한 모든 워크스페이스를 invalidate. 비용 작음 (members
    // list 자체는 낮은 빈도 fetch).
    qc.invalidateQueries({ queryKey: ['workspaces', 'members'] });
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
    // task-026-E: mention also feeds Activity — invalidate before the
    // channel-presence skip below so unread count reflects even when
    // the user is currently on the target channel.
    qc.invalidateQueries({ queryKey: ['me', 'activity'] });
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

    // task-019-D: gate mention toast by user preference. OFF silences
    // both toast + browser Notification (browser Notification API is
    // not called from this dispatcher yet, but the channel lookup
    // tracks intent for when it lands).
    const channel = ctx.resolveNotificationChannel?.(env.workspaceId, 'MENTION') ?? 'BOTH';
    if (channel === 'OFF' || channel === 'BROWSER') return;

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
  'message.pin.toggled',
  'user.profile.updated',
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
  'presence:update',
  'mention.received',
  'message.reaction.added',
  'message.reaction.removed',
  'message.thread.replied',
  'typing:update',
  'typing:batch',
  'typing.updated',
  // S32 (FR-RT-09): 소켓 disconnect 시 타이핑 인디케이터 전체 클리어.
  'disconnect',
  'read_state:updated',
] as const;
