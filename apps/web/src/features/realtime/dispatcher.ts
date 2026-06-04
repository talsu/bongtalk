import { type QueryClient, type InfiniteData } from '@tanstack/react-query';
import {
  WS_EVENTS,
  ReactionUpdatedPayloadSchema,
  ReactionClearedPayloadSchema,
  EmojiCreatedPayloadSchema,
  EmojiDeletedPayloadSchema,
  EmojiAliasUpdatedPayloadSchema,
  MentionNewPayloadSchema,
  NotificationBadgeUpdatePayloadSchema,
  ConnectionReadyPayloadSchema,
  UnreadCountIncrementPayloadSchema,
  ChannelPinAddedPayloadSchema,
  ChannelPinRemovedPayloadSchema,
  AttachmentProcessingDonePayloadSchema,
  MessageEmbedUpdatedPayloadSchema,
  MemberKickedPayloadSchema,
  MemberBannedPayloadSchema,
  WorkspaceDeletedPayloadSchema,
  WorkspaceRestoredPayloadSchema,
  ApplicationReceivedPayloadSchema,
  ApplicationReviewedPayloadSchema,
  ReminderFirePayloadSchema,
  SavedUpdatedPayloadSchema,
  MESSAGE_PIN_CAP,
  type ListMessagesResponse,
  type ListThreadRepliesResponse,
  type MessageDto,
  type PresenceUpdatePayload,
  type WorkspacePresenceUpdatedPayload,
} from '@qufox/shared-types';
import { peekReactionIntent } from '../reactions/reaction-intent';
import type { Socket } from 'socket.io-client';
import { qk } from '../../lib/query-keys';
import type { UnreadChannelSummary } from '../channels/useUnread';
import type { MentionInboxResponse, MentionSummary } from '../mentions/useMentions';
import { useNotifications } from '../../stores/notification-store';
import { snoozeReminder } from '../saved/api';
import { useTypingStore } from '../typing/useTypingStore';
import { useReadState } from './readStateStore';
import { useBadgeStore } from '../notifications/badgeStore';

/**
 * S50 (D10 · FR-PS-02/06): channel:pin_* 이벤트는 wire 에 workspaceId 를 싣지 않고
 * channelId 만 싣는다(채널 룸 fanout — channelId 가 유일 식별자). 메시지 목록 캐시
 * 키는 `['messages', wsId, chId]` 라 wsId 를 모르므로, channelId 가 일치하는 모든
 * messages.list 쿼리를 predicate 로 찾아 핀 마커(pinnedAt/pinnedBy)를 patch 한다.
 */
function patchPinMarker(
  qc: QueryClient,
  channelId: string,
  messageId: string,
  pinnedAt: string | null,
  pinnedBy: string | null,
): void {
  qc.setQueriesData<InfiniteData<ListMessagesResponse>>(
    {
      predicate: (q) => {
        const k = q.queryKey;
        return Array.isArray(k) && k[0] === 'messages' && k[2] === channelId && k.length === 3;
      },
    },
    (old) => {
      if (!old) return old;
      let touched = false;
      const pages = old.pages.map((p) => ({
        ...p,
        items: p.items.map((m) => {
          if (m.id !== messageId) return m;
          touched = true;
          return { ...m, pinnedAt, pinnedBy };
        }),
      }));
      return touched ? { ...old, pages } : old;
    },
  );
}

/**
 * S50 (D10 · FR-PS-03): 핀 패널 목록 + 헤더 카운트 쿼리를 channelId 일치 기준으로
 * invalidate 한다(다음 read 가 서버 진실값으로 재조회). pin_added/removed 둘 다 호출.
 */
function invalidatePinViews(qc: QueryClient, channelId: string): void {
  qc.invalidateQueries({
    predicate: (q) => {
      const k = q.queryKey;
      return Array.isArray(k) && k[0] === 'messages' && k[2] === channelId && k[3] === 'pins';
    },
  });
}

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
                      // S36 (FR-TH-04): 새 답글 도착 → reply bar unread dot 을 켠다.
                      // 단 viewer 본인이 보낸 답글이면 미읽이 아니다(채널 미읽이
                      // 자기 메시지를 포함하는 것과 달리, 스레드 chip dot 은 "내가
                      // 아직 안 본 새 답글" UX 이므로 self-reply 는 dot 을 켜지
                      // 않는다). 기존 hasUnread(서버 산정값)는 새 답글이 그것을
                      // 덮으므로 보존하지 않는다. 정확한 값은 다음 목록 refetch /
                      // 패널 ACK 가 서버 기준으로 재수렴시킨다.
                      hasUnread: viewerForActivity !== env.replierId,
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

  // S35 (FR-TH-06): message.thread.broadcast — 'Also send to #channel' 로 게시된
  // SYSTEM_THREAD_BROADCAST 채널 행을 채널 타임라인 캐시에 삽입한다. 답글의
  // message.created 는 parentMessageId 가 있어 thread 캐시로만 라우팅되므로,
  // broadcast 행은 별도 이벤트로 채널 행을 추가한다. 페이로드의 broadcastMessage
  // (= message)를 MessageDto 로 캐시 head 에 삽입하되 messageId 중복은 dedupe.
  on<{
    id: string;
    channelId: string;
    workspaceId: string;
    parentMessageId: string;
    parentExcerpt: string;
    message: MessageDto & { parentMessageId?: string | null; isBroadcast?: boolean };
  }>('message.thread.broadcast', (env) => {
    if (!env.channelId || !env.workspaceId || !env.message) return;
    // broadcast 행은 채널 미읽에 포함된다(FR-TH-14). 본인이 보낸 게 아니고
    // 현재 보고 있는 채널이 아니면 미읽 +1. (정확한 unread 집계·삭제 시 감소는
    // ThreadReadState 와 함께 S36 — 여기서는 message.created 와 동일한 낙관적
    // bump 만 적용해 라이브 배지가 즉시 반영되게 한다.)
    const viewer = ctx.viewerId();
    const active = ctx.activeChannelId();
    if (viewer && env.message.authorId !== viewer && active !== env.channelId) {
      qc.invalidateQueries({ queryKey: qk.me.unreadTotals() });
      qc.setQueryData<{ channels: UnreadChannelSummary[] }>(
        qk.channels.unreadSummary(env.workspaceId),
        (old) => {
          if (!old) return old;
          const lastMessageAt =
            typeof env.message.createdAt === 'string'
              ? env.message.createdAt
              : new Date().toISOString();
          const found = old.channels.some((c) => c.channelId === env.channelId);
          return {
            channels: found
              ? old.channels.map((c) =>
                  c.channelId === env.channelId
                    ? { ...c, unreadCount: c.unreadCount + 1, lastMessageAt }
                    : c,
                )
              : [
                  ...old.channels,
                  {
                    channelId: env.channelId,
                    unreadCount: 1,
                    mentionCount: 0,
                    hasMention: false,
                    lastMessageAt,
                  },
                ],
          };
        },
      );
    }
    // broadcast MessageDto 를 채널 타임라인 캐시 head 에 삽입. parentExcerpt 를
    // 함께 박아 채널 행이 레이블 + 루트 excerpt 를 렌더하게 한다.
    const broadcastDto: MessageDto = {
      ...env.message,
      isBroadcast: true,
      parentExcerpt: env.parentExcerpt ?? null,
    };
    qc.setQueryData<InfiniteData<ListMessagesResponse>>(
      qk.messages.list(env.workspaceId, env.channelId),
      (old) => {
        if (!old) return old;
        const [first, ...rest] = old.pages;
        // FR-RT-24: messageId 중복 dedupe(재연결 replay / 다중 탭).
        if (first.items.some((m) => m.id === env.message.id)) return old;
        return {
          ...old,
          pages: [{ ...first, items: [broadcastDto, ...first.items] }, ...rest],
        };
      },
    );
  });

  // S38 (FR-TH-13): thread:lock:changed — 스레드 잠금/해제 실시간 반영. 채널
  // 타임라인 루트 + 열린 스레드 패널 루트의 threadLocked 를 갱신해, MEMBER 이하
  // 의 composer 가 즉시 잠기거나 풀린다. Threads 탭 목록은 잠금 상태를 표시하지
  // 않으므로 무효화하지 않는다(불필요한 refetch 회피).
  on<{
    channelId: string;
    workspaceId: string | null;
    // S38 fix-forward (contract HIGH): 서버 payload + wire 스키마와 정합되게
    // actorId(잠금/해제 수행자)를 타입에 포함한다. 현재 캐시 갱신 로직은 actorId 를
    // 소비하지 않지만(누가 잠갔는지 무관하게 threadLocked 만 반영), 타입 누락을
    // 메워 ThreadLockChangedPayloadSchema 와 1:1 로 맞춘다.
    actorId: string;
    parentMessageId: string;
    locked: boolean;
  }>('thread:lock:changed', (env) => {
    if (!env.channelId || !env.parentMessageId) return;
    // 채널 타임라인 캐시의 루트 행 threadLocked 갱신.
    if (env.workspaceId) {
      qc.setQueryData<InfiniteData<ListMessagesResponse>>(
        qk.messages.list(env.workspaceId, env.channelId),
        (old) => {
          if (!old) return old;
          return {
            ...old,
            pages: old.pages.map((p) => ({
              ...p,
              items: p.items.map((m) =>
                m.id === env.parentMessageId ? { ...m, threadLocked: env.locked } : m,
              ),
            })),
          };
        },
      );
    }
    // 열린 스레드 패널 캐시의 루트(root) threadLocked 갱신 — composer 잠금 실시간.
    qc.setQueryData<InfiniteData<ListThreadRepliesResponse>>(
      qk.messages.thread(env.parentMessageId),
      (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((p, idx) =>
            idx === 0 && p.root ? { ...p, root: { ...p.root, threadLocked: env.locked } } : p,
          ),
        };
      },
    );
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
            // 잠금 기준이 최신값이 되도록). S37: 페이로드가 contentPlain 도 실으므로
            // merge 시 평문 정본도 최신값으로 갱신된다("메시지 복사" 정합).
            items: p.items.map((m) => (m.id === env.message.id ? { ...m, ...env.message } : m)),
          })),
        };
      },
    );
    // S37 보안 fix-forward: 재편집되면 열려 있던 편집 이력 팝오버의 스냅샷이
    // stale 해진다. 해당 메시지의 editHistory 캐시를 무효화해, 다음에 팝오버를
    // 열면(또는 열린 채로) 최신 이력을 다시 가져오게 한다(stale 스냅샷 방지).
    qc.invalidateQueries({
      queryKey: qk.messages.editHistory(env.workspaceId, env.channelId, env.message.id),
    });
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

      // S35 (FR-TH-20b): 채널 타임라인과 Thread Panel 의 공유 상태 동기화. 같은
      // message.deleted 이벤트로 양쪽을 한 번에 처리한다(별도 2차 fetch 없음 →
      // 2회 렌더 방지). 삭제된 메시지가 *답글*이면 그 답글이 들어있는 열린 스레드
      // 캐시에서 해당 행을 deleted:true 로 마킹한다(ThreadReplyRow 가 "(삭제된
      // 답글)" placeholder 렌더). 삭제된 메시지가 *루트*면 그 루트의 thread 캐시
      // (rootId = messageId)에서 root 를 deleted 로 마킹해 패널이 placeholder 를
      // 보이게 한다. parentMessageId 가 이벤트에 없으므로 모든 thread 캐시를
      // 순회하되, 일치하는 캐시 1곳만 실제로 바뀐다(나머지는 동일 참조 반환 →
      // 무-렌더). thread 캐시는 보통 0~1개라 순회 비용은 무시할 만하다.
      const threadQueries = qc.getQueriesData<
        InfiniteData<{ root: MessageDto; replies: MessageDto[]; pageInfo: unknown }>
      >({ queryKey: qk.messages.threadRoot() });
      for (const [key] of threadQueries) {
        qc.setQueryData<
          InfiniteData<{ root: MessageDto; replies: MessageDto[]; pageInfo: unknown }>
        >(key, (old) => {
          if (!old) return old;
          let changed = false;
          const pages = old.pages.map((p) => {
            // 루트가 삭제된 경우: 첫 페이지의 root 를 마킹.
            const rootHit = p.root && p.root.id === env.message.id && !p.root.deleted;
            // 답글이 삭제된 경우: replies 중 해당 id 를 마킹.
            const replyHit = p.replies.some((r) => r.id === env.message.id && !r.deleted);
            if (!rootHit && !replyHit) return p;
            changed = true;
            return {
              ...p,
              root: rootHit ? { ...p.root, deleted: true, content: null } : p.root,
              replies: replyHit
                ? p.replies.map((r) =>
                    r.id === env.message.id ? { ...r, deleted: true, content: null } : r,
                  )
                : p.replies,
            };
          });
          return changed ? { ...old, pages } : old;
        });
      }
    },
  );

  // S64 (FR-RM09): message:bulk_deleted — bulk purge 결과. channelId + messageIds[] 가
  // 실려오므로 해당 채널의 messages.list 캐시에서 그 id 들을 한 번에 제거한다(개별
  // message.deleted 루프 대신 단일 이벤트). workspaceId 는 wire 에 없으므로 channelId
  // 가 일치하는 모든 messages.list 쿼리를 순회해 patch 한다(채널 단위 fanout).
  on<{ channelId: string; messageIds: string[] }>(WS_EVENTS.MESSAGE_BULK_DELETED, (env) => {
    if (!env.channelId || !Array.isArray(env.messageIds) || env.messageIds.length === 0) return;
    const removeIds = new Set(env.messageIds);
    // channelId 가 일치하는 모든 messages.list(['messages', wsId, chId]) 쿼리에서
    // bulk-deleted id 들을 한 번에 제거한다(patchPinMarker 와 동일 predicate · k[2]=chId).
    qc.setQueriesData<InfiniteData<ListMessagesResponse>>(
      {
        predicate: (q) => {
          const k = q.queryKey;
          return (
            Array.isArray(k) && k[0] === 'messages' && k[2] === env.channelId && k.length === 3
          );
        },
      },
      (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((p) => ({
            ...p,
            items: p.items.filter((m) => !removeIds.has(m.id)),
          })),
        };
      },
    );
  });

  // S50 (D10 · FR-PS-02): channel:pin_added — 메시지가 채널 핀에 추가됨. 채널 룸
  // fanout 이라 받는 즉시 (1) 메시지 목록 캐시 행에 pinnedAt/pinnedBy patch(핀 마커
  // 표시), (2) 핀 패널 목록 + 헤더 카운트 쿼리 invalidate, (3) used>=soft cap(50)
  // 도달 시 경고 toast(FR-PS-04). workspaceId 는 wire 에 없으므로 활성 채널의
  // wsId 를 알 수 없는 경우를 대비해 모든 messages.list 쿼리에서 channelId 가
  // 일치하는 행을 patch 한다(채널 단위 fanout — channelId 가 유일 식별자).
  on<unknown>(WS_EVENTS.CHANNEL_PIN_ADDED, (env) => {
    const parsed = ChannelPinAddedPayloadSchema.safeParse(env);
    if (!parsed.success) return;
    const { channelId, messageId, pinnedAt, pinnedBy, used } = parsed.data;
    patchPinMarker(qc, channelId, messageId, pinnedAt, pinnedBy);
    invalidatePinViews(qc, channelId);
    // FR-PS-04: soft cap(50) 도달 시 경고 toast. used 미동봉(구 서버)이면 생략.
    if (typeof used === 'number' && used >= MESSAGE_PIN_CAP) {
      useNotifications.getState().push({
        variant: 'warning',
        title: '채널 핀이 거의 가득 찼습니다',
        body: `이 채널에 고정된 메시지가 ${used}개입니다. 권장 한도 ${MESSAGE_PIN_CAP}개에 도달했습니다.`,
        ttlMs: 6000,
      });
    }
  });

  // S50 (D10 · FR-PS-06): channel:pin_removed — 핀 해제(unpin) 또는 핀된 메시지
  // 소프트 삭제 cascade. 메시지 목록 행의 pinnedAt/pinnedBy 를 null 로 patch 하고
  // 핀 패널/헤더 카운트를 invalidate 한다(메시지 자체 삭제는 별도 message.deleted
  // 핸들러가 처리 — 여기서는 핀 표식만 정리).
  on<unknown>(WS_EVENTS.CHANNEL_PIN_REMOVED, (env) => {
    const parsed = ChannelPinRemovedPayloadSchema.safeParse(env);
    if (!parsed.success) return;
    const { channelId, messageId } = parsed.data;
    patchPinMarker(qc, channelId, messageId, null, null);
    invalidatePinViews(qc, channelId);
  });

  // ---------- Attachment processing (S58 · D11 · FR-AM-25) ----------
  // attachment:processing_done — 첨부 후처리가 끝나 표시 상태가 확정됨(READY|BLOCKED).
  // 채널 룸 fanout 이라 channelId 가 유일 식별자다. channelId 가 일치하는 모든 messages.list
  // 캐시(`['messages', wsId, chId]` 3-tuple)에서 해당 messageId 행의 attachment 배열 중
  // attachmentId 가 일치하는 항목의 processingStatus → payload.status, thumbnailKey →
  // payload.thumbnailKey 로 patch 한다. 캐시에 해당 메시지/첨부가 없으면 무시한다(no-op).
  //
  // forward-compat: 현재 백엔드는 이 이벤트를 emit 하지 않는다(Sharp/ffmpeg 서버 리사이즈
  // 영구 보류 · complete 시 즉시 READY). 핸들러만 미리 등록해 두어 서버가 나중에 emit 을
  // 켜더라도 무회귀로 동작하게 한다(patchPinMarker 의 channelId predicate 선례를 모사).
  on<unknown>(WS_EVENTS.ATTACHMENT_PROCESSING_DONE, (env) => {
    const parsed = AttachmentProcessingDonePayloadSchema.safeParse(env);
    if (!parsed.success) return;
    const { channelId, messageId, attachmentId, status, thumbnailKey } = parsed.data;
    qc.setQueriesData<InfiniteData<ListMessagesResponse>>(
      {
        predicate: (q) => {
          const k = q.queryKey;
          return Array.isArray(k) && k[0] === 'messages' && k[2] === channelId && k.length === 3;
        },
      },
      (old) => {
        if (!old) return old;
        let touched = false;
        const pages = old.pages.map((p) => ({
          ...p,
          items: p.items.map((m) => {
            if (m.id !== messageId || !m.attachments?.length) return m;
            // attachmentId 일치 항목만 patch — 일치가 없으면 행을 건드리지 않는다.
            if (!m.attachments.some((a) => a.id === attachmentId)) return m;
            touched = true;
            return {
              ...m,
              attachments: m.attachments.map((a) =>
                a.id === attachmentId ? { ...a, processingStatus: status, thumbnailKey } : a,
              ),
            };
          }),
        }));
        return touched ? { ...old, pages } : old;
      },
    );
  });

  // ---------- Link unfurl (S60 · D11 · FR-RC07/08) ----------
  // message:embed_updated — 메시지 본문 URL 의 비동기 unfurl 이 끝나거나 사후 suppress 로
  // embed 집합이 바뀜. 채널 룸 fanout 이라 channelId 가 식별자다. embeds 는 해당 메시지의
  // 비-suppress embed 전체 스냅샷(idempotent replace)이므로, channelId 가 일치하는 모든
  // messages.list 캐시(`['messages', wsId, chId]` 3-tuple)에서 해당 messageId 행의 embeds 를
  // 통째로 교체한다. 캐시에 해당 메시지가 없으면 무시한다(no-op · 다음 list 재조회로 자가 치유).
  on<unknown>(WS_EVENTS.MESSAGE_EMBED_UPDATED, (env) => {
    const parsed = MessageEmbedUpdatedPayloadSchema.safeParse(env);
    if (!parsed.success) return;
    const { channelId, messageId, embeds } = parsed.data;
    qc.setQueriesData<InfiniteData<ListMessagesResponse>>(
      {
        predicate: (q) => {
          const k = q.queryKey;
          return Array.isArray(k) && k[0] === 'messages' && k[2] === channelId && k.length === 3;
        },
      },
      (old) => {
        if (!old) return old;
        let touched = false;
        const pages = old.pages.map((p) => ({
          ...p,
          items: p.items.map((m) => {
            if (m.id !== messageId) return m;
            touched = true;
            return { ...m, embeds };
          }),
        }));
        return touched ? { ...old, pages } : old;
      },
    );
  });

  // ---------- Saved reminders (S53 · D10 · FR-PS-09/10/11) ----------
  // user:reminder_fire — 저장 항목 리마인더 시각 도래. 개인 user 룸으로 push 된다.
  // 토스트(액션: 10분 후 다시 / 완료로 표시 / 무시) + 권한 있으면 브라우저
  // Notification 을 띄운다. 발화로 저장 목록 메타가 바뀌었으므로 캐시도 무효화한다.
  on<unknown>(WS_EVENTS.REMINDER_FIRE, (env) => {
    const parsed = ReminderFirePayloadSchema.safeParse(env);
    if (!parsed.success) return;
    const { savedMessageId, channelName, messagePreview } = parsed.data;
    // 발화 = reminderAt 가 비워졌으므로 저장 목록/카운트 + 놓친-리마인더 배너 무효화.
    void qc.invalidateQueries({ queryKey: ['saved', 'list'] });
    void qc.invalidateQueries({ queryKey: ['saved', 'count'] });
    void qc.invalidateQueries({ queryKey: ['saved', 'overdue'] }); // S53 리뷰 M1
    const body = `#${channelName} · ${messagePreview}`.slice(0, 180);
    // 토스트(액션: "10분 후 다시"). "완료로 표시"/"무시" 는 토스트 단일 action 슬롯
    // 제약상 1개만 노출 — 가장 흔한 스누즈를 1차 액션으로 둔다(완료는 저장함에서).
    // S53 리뷰(ui): 행동 유도형 알림이라 variant=warning(qf-toast--warn) — info 는 중립.
    useNotifications.getState().push({
      variant: 'warning',
      title: '저장한 메시지 리마인더',
      body,
      ttlMs: 12000,
      action: {
        label: '10분 후 다시',
        onClick: () => {
          void snoozeReminder(savedMessageId)
            .then(() => {
              void qc.invalidateQueries({ queryKey: ['saved', 'list'] });
              void qc.invalidateQueries({ queryKey: ['saved', 'count'] });
              void qc.invalidateQueries({ queryKey: ['saved', 'overdue'] });
            })
            .catch(() => undefined);
        },
      },
    });
    // 권한이 이미 허용돼 있으면 브라우저 Notification 도 띄운다(요청은 모달에서 1회).
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification('저장한 메시지 리마인더', { body });
      }
    } catch {
      // Notification 생성 실패는 무해(토스트로 폴백).
    }
  });

  // user:saved_updated — 저장 항목 메타(status/reminderAt) 변경. 다른 기기/탭에서
  // 설정/취소/스누즈/발화/탭 이동이 일어났을 때 저장 목록/카운트 캐시를 무효화한다.
  on<unknown>(WS_EVENTS.SAVED_UPDATED, (env) => {
    const parsed = SavedUpdatedPayloadSchema.safeParse(env);
    if (!parsed.success) return;
    void qc.invalidateQueries({ queryKey: ['saved', 'list'] });
    void qc.invalidateQueries({ queryKey: ['saved', 'count'] });
    void qc.invalidateQueries({ queryKey: ['saved', 'overdue'] }); // S53 리뷰 M1
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
    serverTimestamp?: string;
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

    // S47 (FR-MN-20 ACK 우선): ACK 시각을 워크스페이스 배지에 기록해, 이후 도착하는
    // ACK-이전 시각의 notification:badge_update 를 stale 로 거른다. 단일 채널 ACK 로는
    // 워크스페이스 합계를 정확히 알 수 없으므로 카운트는 건드리지 않고 시각만 전진한다
    // (정확한 합계는 후속 badge_update 또는 GET /me/notification-badges 재동기화가 채움).
    // S47 fix-forward (BLOCKER-2): lastAckedAt 을 클라 Date.now() 가 아니라 서버가
    // 실어 보낸 serverTimestamp(서버 시계)로 저장한다. badge_update 의 serverTimestamp
    // 와 동일 시계로 비교돼, 서버 시계 지연 상황에서 정당한 신규 badge_update 가 stale
    // 로 폐기되지 않는다. 구 서버 페이로드(serverTimestamp 누락)는 ACK 시각 갱신을 건너뛴다.
    if (env.workspaceId && env.serverTimestamp) {
      useBadgeStore.getState().markAcked(env.workspaceId, env.serverTimestamp);
    }

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

  // ---------- Reactions (S39 · FR-RE01/RE03) ----------
  // reaction:updated 는 한 메시지의 *전체* 반응 집계(full snapshot)를 싣는다.
  // 서버 add/remove(toggle) 1건당 이 이벤트 1건이 채널 룸으로 fanout 되며, 클라는
  // 해당 messageId 의 reactions 를 payload 로 **full replace** 한다(증분 ±1 아님 —
  // out-of-order / 재연결 replay 에도 카운트가 수렴). per-viewer `me`(=byMe) 는
  // 브로드캐스트 payload 에 담을 수 없으므로(수신자마다 다름), 각 이모지의 users
  // 목록에 내 userId 가 들어있는지로 **로컬 계산**한다. users 는 최대 5명 cap 이라,
  // reactor 6명 이상인 이모지에서 내가 6번째 이후면 users 에 안 보일 수 있다.
  //
  // S39 fix-forward (reviewer MAJOR ★2): 종전엔 cap 밖일 때 `byMe = inUsers ||
  // prevByMe` 로 직전 캐시값을 *영구 latch* 했다 — 내가 방금 제거했는데도 byMe 가
  // true 로 굳는 sticky-ghost 회귀였다. 이제 reaction-intent 모듈의 **뷰어 권위 의도**
  // (useReactions 가 낙관 토글/POST 응답으로 기록)를 우선 참조한다:
  //   - 살아있는 의도가 있으면 그 byMe(내가 막 제거했으면 false → 정확 수렴, 막
  //     추가했으면 true → 깜빡임 방지). cap 밖이어도 정확.
  //   - 의도가 없으면(다른 사람만 반응했거나, 내 토글이 이미 WS 와 합의해 만료됨)
  //     순수 `inUsers` 로 계산한다(latch 제거).
  on<{
    messageId: string;
    channelId: string;
    reactions: Array<{
      emoji: string;
      count: number;
      users: Array<{ id: string; username?: string | null }>;
    }>;
  }>(WS_EVENTS.REACTION_UPDATED, (env) => {
    if (!env.channelId || !env.messageId) return;
    // S39 (SHOULD 3): 신뢰경계 가드 — 형태가 어긋난 reaction:updated 페이로드는
    // 캐시를 건드리지 않고 버린다(서버 회귀/멀티 dispatcher 오발신 방어). 통과 시
    // 검증된 형태를 그대로 쓴다.
    const parsed = ReactionUpdatedPayloadSchema.safeParse(env);
    if (!parsed.success) return;
    const payload = parsed.data;
    const viewer = ctx.viewerId();
    // workspaceId 는 wire payload 에 없다 — 메시지 목록 캐시(`['messages', wsId,
    // chId]` 3-tuple)만 골라 해당 messageId 를 가진 행을 patch 한다(채널 룸 fanout
    // 이라 보통 1개). thread(`['messages','thread',…]`) / detail(2-tuple) /
    // history·jump-around(5-tuple) 캐시는 형태로 배제된다.
    const listKeys = qc
      .getQueryCache()
      .findAll({ queryKey: ['messages'] })
      .map((q) => q.queryKey)
      .filter(
        (k): k is readonly [string, string, string] =>
          Array.isArray(k) && k.length === 3 && k[0] === 'messages' && k[1] !== 'thread',
      );
    for (const key of listKeys) {
      qc.setQueryData<InfiniteData<ListMessagesResponse>>(key, (old) => {
        if (!old) return old;
        let changed = false;
        const pages = old.pages.map((p) => {
          if (!p.items.some((m) => m.id === payload.messageId)) return p;
          changed = true;
          return {
            ...p,
            items: p.items.map((m) => {
              if (m.id !== payload.messageId) return m;
              const reactions = payload.reactions.map((r) => {
                const inUsers = viewer !== null && r.users.some((u) => u.id === viewer);
                // ★ sticky-ghost 방지: 뷰어의 권위 의도가 살아있으면 그 값을 우선한다
                // (내가 막 제거 → false 로 정확 수렴 / 막 추가 → true 로 깜빡임 방지).
                // 의도가 없으면(타인만 반응, 또는 WS 와 합의해 만료) 순수 inUsers.
                const intent = peekReactionIntent(payload.messageId, r.emoji);
                const byMe = intent !== null ? intent : inUsers;
                return { emoji: r.emoji, count: r.count, byMe };
              });
              return { ...m, reactions };
            }),
          };
        });
        return changed ? { ...old, pages } : old;
      });
    }
    // task-026-E: 내 메시지에 달린 반응은 Activity 인박스에 반영 — list + unread
    // 카운트를 무효화해 Bell / tabbar 배지가 ~1 RTT 안에 갱신되게 한다.
    qc.invalidateQueries({ queryKey: ['me', 'activity'] });
    // S40 fix-forward (HIGH): reactor 목록 모달이 열려 있을 때 같은 메시지의 반응이
    // 바뀌면 그 목록도 stale 해진다. `['reactions','users', messageId]` prefix
    // (qk.reactions.users 가 만드는 `[...,msgId,emoji]` 키의 상위)로 무효화해 다음
    // authoritative read 로 재수렴시킨다(emoji 별로 따로 걸지 않고 메시지 단위 일괄).
    qc.invalidateQueries({ queryKey: ['reactions', 'users', payload.messageId] });
  });

  // ---------- Reactions cleared (S40 · FR-RE09) ----------
  // reaction:cleared 는 OWNER/ADMIN 이 메시지의 *전체* 반응을 일괄 삭제했음을 알린다.
  // 집계가 없으므로 해당 messageId 의 reactions 를 통째로 비운다(full clear). 채널 룸
  // fanout 이라 메시지 목록 캐시(3-tuple `['messages', wsId, chId]`)에서 해당 행을 찾아
  // reactions: [] 로 patch 한다(reaction:updated 의 캐시 선별 로직과 동일 형태 가드).
  on<{ messageId: string; channelId: string }>(WS_EVENTS.REACTION_CLEARED, (env) => {
    if (!env.channelId || !env.messageId) return;
    const parsed = ReactionClearedPayloadSchema.safeParse(env);
    if (!parsed.success) return;
    const { messageId } = parsed.data;
    const listKeys = qc
      .getQueryCache()
      .findAll({ queryKey: ['messages'] })
      .map((q) => q.queryKey)
      .filter(
        (k): k is readonly [string, string, string] =>
          Array.isArray(k) && k.length === 3 && k[0] === 'messages' && k[1] !== 'thread',
      );
    for (const key of listKeys) {
      qc.setQueryData<InfiniteData<ListMessagesResponse>>(key, (old) => {
        if (!old) return old;
        let changed = false;
        const pages = old.pages.map((p) => {
          if (!p.items.some((m) => m.id === messageId && (m.reactions ?? []).length > 0)) return p;
          changed = true;
          return {
            ...p,
            items: p.items.map((m) => (m.id === messageId ? { ...m, reactions: [] } : m)),
          };
        });
        return changed ? { ...old, pages } : old;
      });
    }
    // S40 fix-forward (HIGH): 전체 반응이 비워졌으니 이 메시지의 열린 reactor 목록
    // 캐시(`['reactions','users', messageId]` prefix)를 제거한다 — 일괄 삭제 후에는
    // 모든 reactor 가 사라지므로 invalidate(재요청 후 빈 목록)보다 removeQueries 로
    // 즉시 파기하는 편이 stale 목록 깜빡임을 막는다. (out-of-order 로 cleared 뒤
    // 도착한 reaction:updated 가 반응을 부활시키는 극희귀 케이스는 다음 authoritative
    // read 가 self-heal 한다 — 별도 처리 불요.)
    qc.removeQueries({ queryKey: ['reactions', 'users', messageId] });
  });

  // ---------- Custom emoji lifecycle (S41 · FR-EM01/FR-EM04/FR-RC20) ----------
  // emoji:created 는 워크스페이스에 새 커스텀 이모지가 확정됐음을 알린다. 해당
  // 워크스페이스의 `['custom-emojis', wsId]` 쿼리를 invalidate 해 피커/매니저가
  // 새 이모지를 다음 read 로 반영하게 한다(presigned url 정합을 서버 list 에 위임).
  on<{ workspaceId: string; emojiId: string; name: string }>(WS_EVENTS.EMOJI_CREATED, (env) => {
    const parsed = EmojiCreatedPayloadSchema.safeParse(env);
    if (!parsed.success) return;
    qc.invalidateQueries({ queryKey: ['custom-emojis', parsed.data.workspaceId] });
  });

  // emoji:deleted 는 커스텀 이모지가 삭제됐음을 알린다. 캐시에서 해당 emojiId 를
  // 즉시 제거해 피커/매니저에서 사라지게 하고, 진행 중 메시지 반응의 [삭제된
  // 이모지] placeholder 전환은 다음 authoritative read(reaction:updated 또는
  // 메시지 refetch)가 self-heal 한다(FR-EM06). 제거 후 stale 표시를 막기 위해
  // 캐시를 직접 patch 한 뒤 invalidate 로 재수렴시킨다.
  on<{ workspaceId: string; emojiId: string; name: string }>(WS_EVENTS.EMOJI_DELETED, (env) => {
    const parsed = EmojiDeletedPayloadSchema.safeParse(env);
    if (!parsed.success) return;
    const { workspaceId, emojiId } = parsed.data;
    qc.setQueryData<{ items: Array<{ id: string }> }>(['custom-emojis', workspaceId], (old) => {
      if (!old) return old;
      return { ...old, items: old.items.filter((e) => e.id !== emojiId) };
    });
    qc.invalidateQueries({ queryKey: ['custom-emojis', workspaceId] });
    // S42: 삭제된 이모지의 별칭도 피커 데이터에서 사라져야 하므로 함께 무효화.
    qc.invalidateQueries({ queryKey: ['emoji-picker-data', workspaceId] });
  });

  // emoji:alias_updated (S42 · FR-EM05/FR-EM07) — 별칭 추가/삭제 시 해당 워크스페이스
  // 의 `['custom-emojis', wsId]` + 피커 데이터를 invalidate 해 파서(:alias:→img)/
  // 자동완성/피커가 새 별칭 매핑을 다음 read 로 반영하게 한다. payload 에 aliases
  // 스냅샷이 실리지만 보수적으로 invalidate 후 재조회한다(서버 list 가 정본).
  on<{ workspaceId: string; emojiId: string; aliases: string[] }>(
    WS_EVENTS.EMOJI_ALIAS_UPDATED,
    (env) => {
      const parsed = EmojiAliasUpdatedPayloadSchema.safeParse(env);
      if (!parsed.success) return;
      qc.invalidateQueries({ queryKey: ['custom-emojis', parsed.data.workspaceId] });
      qc.invalidateQueries({ queryKey: ['emoji-picker-data', parsed.data.workspaceId] });
    },
  );

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
  // S70 (FR-W12): PRD 콜론 wire ws:member_left{reason}. dot 핸들러와 같은 멤버 목록 무효화로
  // 수렴한다(reason='temp_expired' 강퇴 포함). 중복 수신해도 무해(멱등 invalidate).
  on<unknown>(WS_EVENTS.MEMBER_LEFT, (raw) => {
    const wsId = (raw as { workspaceId?: string } | null)?.workspaceId;
    if (typeof wsId !== 'string' || wsId.length === 0) return;
    qc.invalidateQueries({ queryKey: qk.workspaces.members(wsId) });
    qc.invalidateQueries({ queryKey: qk.workspaces.list() });
  });
  on<{ workspaceId: string }>('workspace.member.removed', (env) => {
    if (env.workspaceId) {
      qc.invalidateQueries({ queryKey: qk.workspaces.members(env.workspaceId) });
      qc.invalidateQueries({ queryKey: qk.workspaces.list() });
    }
  });
  // S63 (FR-RM05·06): kick(재가입 가능) / ban(영구 차단). 둘 다 멤버 목록 + 내
  // 워크스페이스 목록을 갱신한다. 대상이 viewer 본인이면 안내 토스트를 띄운다 — 서버가
  // 곧 소켓을 끊고(kickUserEverywhere) 클라가 재연결을 시도하지만, 비멤버라 워크스페이스
  // 접근이 막힌다(REST 404). 워크스페이스 목록 갱신으로 떠난 워크스페이스가 사이드바에서
  // 사라진다(리다이렉트는 라우터가 멤버십 상실을 감지해 처리).
  const onKickOrBan = (env: { workspaceId?: string; userId?: string }, banned: boolean): void => {
    if (!env.workspaceId) return;
    qc.invalidateQueries({ queryKey: qk.workspaces.members(env.workspaceId) });
    qc.invalidateQueries({ queryKey: qk.workspaces.list() });
    if (banned) qc.invalidateQueries({ queryKey: ['workspaces', env.workspaceId, 'bans'] });
    const viewer = ctx.viewerId();
    if (viewer && env.userId === viewer) {
      useNotifications.getState().push({
        variant: 'danger',
        title: banned ? '워크스페이스에서 차단되었습니다' : '워크스페이스에서 퇴장되었습니다',
        body: banned
          ? '이 워크스페이스에 다시 참여할 수 없습니다.'
          : '다시 초대받으면 재참여할 수 있습니다.',
      });
    }
  };
  on<{ workspaceId: string; userId: string }>('workspace.member.kicked', (env) =>
    onKickOrBan(env, false),
  );
  on<{ workspaceId: string; userId: string }>('workspace.member.banned', (env) =>
    onKickOrBan(env, true),
  );
  // S63 fix-forward (contract D-1 = BLOCKER/MAJOR): PRD 가 명시한 콜론 wire 이벤트
  // member:kicked / member:banned. 서버 outbox→WS subscriber 가 dot(workspace.member.*)
  // 을 콜론으로 변환해 워크스페이스 룸으로 추가 emit 한다(다른 멤버의 실시간 멤버 목록
  // 갱신 + 차단 목록 갱신 · FR-RM05/06). 형태가 어긋난 페이로드는 신뢰경계 가드로 버린다
  // (reaction:updated / mention:new 패턴). dot 핸들러와 같은 onKickOrBan 으로 수렴하며,
  // 같은 캐시 무효화/토스트라 중복 수신해도 무해하다(멱등).
  on<unknown>(WS_EVENTS.MEMBER_KICKED, (raw) => {
    const parsed = MemberKickedPayloadSchema.safeParse(raw);
    if (!parsed.success) return;
    onKickOrBan(parsed.data, false);
  });
  on<unknown>(WS_EVENTS.MEMBER_BANNED, (raw) => {
    const parsed = MemberBannedPayloadSchema.safeParse(raw);
    if (!parsed.success) return;
    onKickOrBan(parsed.data, true);
  });
  on<{ workspaceId: string }>('workspace.role.changed', (env) => {
    if (env.workspaceId) {
      qc.invalidateQueries({ queryKey: qk.workspaces.detail(env.workspaceId) });
      qc.invalidateQueries({ queryKey: qk.workspaces.members(env.workspaceId) });
    }
  });

  // S72 (FR-W15): 워크스페이스 소프트 삭제/복원의 콜론 wire 이벤트. 서버 outbox→WS
  // subscriber 가 dot(workspace.deleted / .restored)을 콜론으로 변환해 워크스페이스 룸으로
  // 추가 emit 한다. deleted 수신 시 내 워크스페이스 목록 + 상세를 무효화해 사이드바에서
  // 제거하고, 삭제된 워크스페이스가 지금 보고 있는 곳이면 홈(/dm)으로 리다이렉트한다(슬러그는
  // 캐시된 워크스페이스 목록에서 해석). OWNER 본인의 다른 세션/탭도 동기화된다. restored 는
  // 목록/상세를 다시 무효화해 사이드바에 복귀시킨다. 형태 불량은 신뢰경계 가드로 버린다.
  const redirectIfActiveWorkspace = (workspaceId: string): void => {
    const navigate = ctx.navigate;
    if (!navigate) return;
    const data = qc.getQueryData<{ workspaces: Array<{ id: string; slug: string }> }>([
      'workspaces',
      'mine',
    ]);
    const slug = data?.workspaces.find((w) => w.id === workspaceId)?.slug;
    if (!slug) return;
    if (typeof window !== 'undefined' && window.location.pathname.startsWith(`/w/${slug}`)) {
      navigate('/dm');
    }
  };
  on<unknown>(WS_EVENTS.WORKSPACE_DELETED, (raw) => {
    const parsed = WorkspaceDeletedPayloadSchema.safeParse(raw);
    if (!parsed.success) return;
    const wsId = parsed.data.workspaceId;
    // 리다이렉트 판정은 목록이 무효화돼 사라지기 전에 슬러그를 읽어야 하므로 먼저 수행한다.
    redirectIfActiveWorkspace(wsId);
    qc.invalidateQueries({ queryKey: ['workspaces', 'mine'] });
    qc.invalidateQueries({ queryKey: qk.workspaces.detail(wsId) });
  });
  on<unknown>(WS_EVENTS.WORKSPACE_RESTORED, (raw) => {
    const parsed = WorkspaceRestoredPayloadSchema.safeParse(raw);
    if (!parsed.success) return;
    qc.invalidateQueries({ queryKey: ['workspaces', 'mine'] });
    qc.invalidateQueries({ queryKey: qk.workspaces.detail(parsed.data.workspaceId) });
  });

  // ---------- S70 (D13 · FR-W06/W06a): 가입 신청 ----------
  // ws:application_received — ADMIN 리뷰 패널이 목록을 갱신하도록 신청 쿼리를 무효화하고,
  // 패널이 구독할 window 이벤트로 흘린다(workspaceId 기준). 형태 불량은 신뢰경계 가드로 버린다.
  on<unknown>(WS_EVENTS.APPLICATION_RECEIVED, (raw) => {
    const parsed = ApplicationReceivedPayloadSchema.safeParse(raw);
    if (!parsed.success) return;
    // 신청 목록은 slug 로 키하나 wire 에는 workspaceId 만 있으므로 ['workspaces', *, 'applications']
    // 접두 전체를 무효화한다(패널이 마운트돼 있으면 즉시 refetch). 추가로 window 이벤트로도 흘린다.
    qc.invalidateQueries({ queryKey: ['workspaces'], predicate: applicationQueryPredicate });
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('qufox.application.received', { detail: parsed.data }));
    }
  });
  // ws:application_reviewed — 신청자 본인 대기 화면이 구독한다(approved=토스트+2초 이동,
  // rejected=거절 카피+reviewNote, interview=인터뷰 안내). 본인 신청 상태 쿼리도 무효화해
  // polling 과 WS 가 동일 진실값으로 수렴하게 한다.
  on<unknown>(WS_EVENTS.APPLICATION_REVIEWED, (raw) => {
    const parsed = ApplicationReviewedPayloadSchema.safeParse(raw);
    if (!parsed.success) return;
    qc.invalidateQueries({ queryKey: ['workspaces'], predicate: applicationQueryPredicate });
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('qufox.application.reviewed', { detail: parsed.data }));
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

  // ---------- Mentions (task-011-B · S44 FR-MN-01: wire `mention:new`) ----------
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
    // S44 contract fix-forward: 서버 MentionReceivedPayload 와 정합하는 @here 표식.
    here: boolean;
  }>('mention:new', (rawEnv) => {
    // S44 contract fix-forward: 신뢰경계 가드 — 형태가 어긋난 mention:new
    // 페이로드는 캐시를 건드리지 않고 버린다(reaction:updated 패턴 동일·서버 회귀/
    // 멀티 dispatcher 오발신 방어). 통과 시 검증된 형태(here 포함)를 그대로 쓴다.
    const parsed = MentionNewPayloadSchema.safeParse(rawEnv);
    if (!parsed.success) return;
    const env = parsed.data;
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
        // S44 contract: schema 의 workspaceId 는 nullable(Global DM 경계). 현재
        // 멘션은 항상 워크스페이스 채널이라 string 이지만, 타입상 null 일 수 있어
        // 캐시 필드(string)에는 빈 문자열로 보정한다(렌더는 messageId 로 라우팅).
        workspaceId: env.workspaceId ?? '',
        authorId: env.actorId,
        snippet: env.snippet,
        createdAt: env.createdAt,
        everyone: env.everyone,
        // S44 contract fix-forward: @here 표식 캐시 반영.
        here: env.here,
      };
      if (!old) return { unreadCount: 1, recent: [entry] };
      if (old.recent.some((m) => m.messageId === env.messageId)) return old;
      return {
        unreadCount: old.unreadCount + 1,
        recent: [entry, ...old.recent].slice(0, 20),
      };
    });

    // S44 contract: schema 의 workspaceId 는 nullable(Global DM 경계). 멘션은 현재
    // 항상 워크스페이스 채널이라 null 이 오지 않지만, 토스트 라우팅 헬퍼는 string 을
    // 요구하므로 null 이면 토스트 단계를 건너뛴다(캐시는 위에서 이미 갱신됨).
    const workspaceId = env.workspaceId;
    if (workspaceId === null) return;
    // task-019-D: gate mention toast by user preference. OFF silences
    // both toast + browser Notification (browser Notification API is
    // not called from this dispatcher yet, but the channel lookup
    // tracks intent for when it lands).
    const channel = ctx.resolveNotificationChannel?.(workspaceId, 'MENTION') ?? 'BOTH';
    if (channel === 'OFF' || channel === 'BROWSER') return;

    const push = useNotifications.getState().push;
    const url = ctx.resolveMentionUrl?.({
      workspaceId,
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

  // ---------- Badge resync (S47 · FR-MN-20) ----------
  // notification:badge_update 는 서버 진실값 배지(isMuted 제외 집계)를 싣는다.
  // 클라는 낙관적 +1 을 이 값으로 교체한다(server last-write-wins). badgeStore 가
  // serverTimestamp 와 lastAckedAt 을 비교해 ACK 이전 시각의 stale badge_update 를
  // 무시한다(FR-MN-20 ACK 우선). 형태가 어긋난 페이로드는 신뢰경계 가드로 버린다.
  on<{
    serverId: string;
    channelId: string | null;
    mentionCount: number;
    unreadCount: number;
    serverTimestamp: string;
  }>(WS_EVENTS.NOTIFICATION_BADGE_UPDATE, (rawEnv) => {
    const parsed = NotificationBadgeUpdatePayloadSchema.safeParse(rawEnv);
    if (!parsed.success) return;
    const env = parsed.data;
    useBadgeStore.getState().applyServerUpdate({
      workspaceId: env.serverId,
      mentionCount: env.mentionCount,
      unreadCount: env.unreadCount,
      serverTimestamp: env.serverTimestamp,
    });
  });

  // ---------- S69 (FR-W23) 다중 워크스페이스 unread 낙관 갱신 ----------
  // unread_count:increment 는 활성 워크스페이스 무관 가입한 모든 워크스페이스의 user 룸
  // 으로 도착한다. payload.workspaceId 가 있으면 그 워크스페이스 서버아이콘 배지를 낙관
  // +delta 한다(직후 notification:badge_update 서버 진실값이 교정). workspaceId 누락(구
  // 서버)이면 채널→워크스페이스 매핑을 모르므로 unread-totals 무효화로 폴백한다.
  on<unknown>(WS_EVENTS.UNREAD_COUNT_INCREMENT, (rawEnv) => {
    const parsed = UnreadCountIncrementPayloadSchema.safeParse(rawEnv);
    if (!parsed.success) return;
    const env = parsed.data;
    if (env.workspaceId) {
      useBadgeStore.getState().applyOptimisticIncrement(env.workspaceId, env.delta);
    } else {
      qc.invalidateQueries({ queryKey: qk.me.unreadTotals() });
    }
  });

  // ---------- S69 (FR-W20) connection:ready 멘션 카운트 복원 ----------
  // 재연결 직후 가입한 모든 워크스페이스의 멘션 카운트를 첫 페인트부터 채운다(비활성
  // 워크스페이스 서버아이콘 멘션 배지 복원). 구 서버는 allWorkspaceMentionCounts 누락 →
  // no-op(기존 badge resync 폴백).
  on<unknown>(WS_EVENTS.CONNECTION_READY, (rawEnv) => {
    const parsed = ConnectionReadyPayloadSchema.safeParse(rawEnv);
    if (!parsed.success) return;
    const counts = parsed.data.allWorkspaceMentionCounts;
    if (counts && counts.length > 0) {
      useBadgeStore.getState().applyConnectionMentionCounts(counts);
    }
  });

  return () => {
    for (const { event, handler } of handlers) socket.off(event, handler);
  };
}

/**
 * S70: 가입 신청 쿼리 무효화 predicate. wire payload 에는 slug 가 아니라 workspaceId 만
 * 있으므로(신청 쿼리는 slug 로 키함), ['workspaces', *, 'applications', ...] 형태의 키만
 * 골라 무효화한다(과도한 전 워크스페이스 무효화를 피한다). qk.workspaces.applications /
 * myApplication 둘 다 세 번째 세그먼트가 'applications' 다.
 */
function applicationQueryPredicate(query: { queryKey: readonly unknown[] }): boolean {
  const k = query.queryKey;
  return k[0] === 'workspaces' && k[2] === 'applications';
}

/** Event types the dispatcher handles — exposed so tests can iterate them. */
export const DISPATCHED_EVENTS = [
  'message.created',
  'message.updated',
  'message.deleted',
  // S50 (D10 · FR-PS-02/06): 핀 추가/해제 wire 이벤트(서버가 message.pin.toggled →
  // channel:pin_added / channel:pin_removed 로 변환해 emit).
  WS_EVENTS.CHANNEL_PIN_ADDED,
  WS_EVENTS.CHANNEL_PIN_REMOVED,
  // S53 (D10 · FR-PS-09/10/11): 저장 리마인더 발화 + 저장 항목 갱신(개인 user 룸).
  WS_EVENTS.REMINDER_FIRE,
  WS_EVENTS.SAVED_UPDATED,
  // S58 (D11 · FR-AM-25): 첨부 후처리 완료(채널 룸 fanout · forward-compat no-op-ready).
  WS_EVENTS.ATTACHMENT_PROCESSING_DONE,
  // S60 (D11 · FR-RC07/08): 링크 unfurl 결과 갱신(채널 룸 fanout).
  WS_EVENTS.MESSAGE_EMBED_UPDATED,
  // S64 (D12 · FR-RM09): bulk purge — 일괄 soft-delete된 messageIds[] 제거(채널 룸 fanout).
  WS_EVENTS.MESSAGE_BULK_DELETED,
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
  // S63 (FR-RM05·06): kick(재가입 가능) / ban(영구 차단) 멤버 이벤트(dot — 본인 user 룸
  // + 워크스페이스 룸 fanout).
  'workspace.member.kicked',
  'workspace.member.banned',
  // S63 fix-forward (contract D-1): PRD 콜론 wire 이벤트(워크스페이스 룸 fanout — 다른
  // 멤버의 멤버 목록/차단 목록 실시간 갱신).
  WS_EVENTS.MEMBER_KICKED,
  WS_EVENTS.MEMBER_BANNED,
  // S70 (D13 · FR-W06/W06a): 가입 신청 접수(ADMIN 패널) / 처리 결과(신청자 대기 화면).
  WS_EVENTS.APPLICATION_RECEIVED,
  WS_EVENTS.APPLICATION_REVIEWED,
  // S70 (D13 · FR-W12): 멤버 이탈(임시멤버 자동 강퇴 포함) — 워크스페이스 룸 fanout.
  WS_EVENTS.MEMBER_LEFT,
  // S72 (D13 · FR-W15): 워크스페이스 소프트 삭제/복원 — 워크스페이스 룸 fanout(콜론 wire).
  WS_EVENTS.WORKSPACE_DELETED,
  WS_EVENTS.WORKSPACE_RESTORED,
  'workspace.role.changed',
  'presence.updated',
  'presence:update',
  // S44 (FR-MN-01): 멘션 알림 wire 이름은 PRD 카탈로그 `mention:new` 로 정렬한다
  // (서버 내부 outbox 는 mention.received, outbox→WS subscriber 가 콜론으로 변환).
  'mention:new',
  // S47 (FR-MN-20): 서버 진실값 배지 재동기화(server last-write-wins · ACK 우선).
  'notification:badge_update',
  // S39 (FR-RE03): 반응 추가/제거 통합 wire 이벤트(full-replace). 종전의
  // message.reaction.added / .removed 를 단일 reaction:updated 로 대체.
  'reaction:updated',
  // S40 (FR-RE09): OWNER/ADMIN 의 메시지 전체 반응 일괄 삭제(full clear).
  'reaction:cleared',
  // S41 (FR-EM01/FR-EM04/FR-RC20): 워크스페이스 커스텀 이모지 업로드/삭제.
  'emoji:created',
  'emoji:deleted',
  // S42 (FR-EM05/FR-EM07): 커스텀 이모지 별칭 추가/삭제.
  'emoji:alias_updated',
  'message.thread.replied',
  // S35 (FR-TH-06): 스레드→채널 broadcast 행 삽입.
  'message.thread.broadcast',
  // S38 (FR-TH-13): 스레드 잠금/해제 실시간 반영.
  'thread:lock:changed',
  'typing:update',
  'typing:batch',
  'typing.updated',
  // S32 (FR-RT-09): 소켓 disconnect 시 타이핑 인디케이터 전체 클리어.
  'disconnect',
  'read_state:updated',
  // S69 (FR-W23): 다중 워크스페이스 unread 낙관 갱신(user 룸 · workspaceId 포함).
  WS_EVENTS.UNREAD_COUNT_INCREMENT,
  // S69 (FR-W20): connection:ready 가입 워크스페이스별 멘션 카운트 복원.
  WS_EVENTS.CONNECTION_READY,
] as const;
