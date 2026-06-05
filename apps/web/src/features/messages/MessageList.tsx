import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import {
  isSystemMessageType,
  resolveMemberDisplayName,
  type Channel,
  type ListMessagesResponse,
  type MessageDto,
  type WorkspaceRole,
} from '@qufox/shared-types';
import { useAuth } from '../auth/AuthProvider';
import { useMembers } from '../workspaces/useWorkspaces';
import {
  useDeleteMessage,
  useJumpAround,
  useMessageHistory,
  usePinMessage,
  useSendMessage,
  useUnpinMessage,
  useUpdateMessage,
} from './useMessages';
import { qk } from '../../lib/query-keys';
import { MessageItem } from './MessageItem';
import { ReportModal } from './ReportModal';
import { useInitSavedStatus, useToggleSave, savedKeys } from '../saved/useSavedMessages';
import type { MentionLookup } from './renderAst';
import { SystemMessage } from './SystemMessage';
import { isContinuation as computeIsContinuation } from './grouping';
import { formatDayDivider, isSameLocalDay, localDayKey } from './formatMessageTime';
import { useChannelList } from '../channels/useChannels';
import { useToggleReaction } from '../reactions/useReactions';
import { CustomEmojiProvider } from '../emojis/CustomEmojiContext';
import { useEmojiPickerData } from '../emojis/useCustomEmojis';
import { Scrollable } from '../../design-system/primitives';
import {
  takeAnchorSnapshot,
  restoreAnchorScrollTop,
  isNearBottom,
  type AnchorSnapshot,
} from './messageAnchor';
import { useChannelLru } from '../realtime/channelLru';
import { useUnreadSummary, useMarkUnread } from '../channels/useUnread';
import { useReadState } from '../realtime/readStateStore';
import { useNotifications } from '../../stores/notification-store';
import { shouldToastJumpNotFound } from './jumpNotFound';
import {
  buildRowPlan,
  computeFirstUnreadIndex,
  firstVisibleIndex,
  lastRowVirtualIndex,
  messageIndexForVirtualIndex,
  shouldShowJumpPill,
  virtualIndexForDivider,
  virtualIndexForMessageIndex,
} from './newMessages';

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
  /**
   * S22 (FR-RS-02): 읽음 커서 콜백. 목록의 최신 메시지 id 와 현재 뷰가
   * scroll-to-bottom 인지(가상화: 마지막 virtualIndex 가 마지막 메시지인지 +
   * 바닥 근접)를 MessageColumn 으로 올려보내, ACK 디바운스/즉시 발화를
   * 결정하게 한다. tail(최신 메시지 id)이 바뀔 때마다 호출된다.
   */
  onReadCursor?: (cursor: { lastMessageId: string; atBottom: boolean }) => void;
  /**
   * S23 MAJOR fix (cold 캐시 구분선): 부모(MessageColumn)가 채널 open 시
   * markRead/zeroOutChannelUnread 로 unread-summary 캐시를 0 으로 누르기 *전에*
   * 캡처한 진입 시점의 읽음 상태. 제공되면 MessageList 는 자체적으로
   * unread-summary 를 다시 읽지 않고 이 값으로 구분선 firstUnread 를 환산한다
   * (zero-out 오염 차단 — FR-RS-06). 미제공(DM 등)이면 종전대로 폴백.
   */
  unreadSnapshot?: { unreadCount: number; lastReadMessageId: string | null };
  /**
   * S30 fix-forward (BLOCKER 기능 M2): 검색 결과 점프 대상 messageId(`?msg=`).
   * 제공되면 초기 로드를 그 메시지 중심(around)으로 가져오고, 로드 후 해당
   * 메시지 행으로 스크롤 + 짧은 하이라이트 펄스를 적용합니다. 처리 후
   * `onJumpConsumed` 를 호출해 부모가 URL 의 `?msg=` 를 제거하게 합니다.
   */
  jumpMessageId?: string | null;
  /** M2: 점프 스크롤이 완료돼 `?msg=` 를 URL 에서 제거해도 됨을 알립니다. */
  onJumpConsumed?: () => void;
  /**
   * S71 (FR-W09a): 빈 채널 empty state 하단에 끼워 넣을 생성자(OWNER) CTA. 부모(MessageColumn)가
   * OWNER + 기본 채널 조건일 때만 CreatorEmptyStateCta 를 전달한다(미전달 시 기존 empty state 유지).
   */
  creatorCta?: ReactNode;
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
  onReadCursor,
  unreadSnapshot,
  jumpMessageId,
  onJumpConsumed,
  creatorCta,
}: Props): JSX.Element {
  const { user } = useAuth();
  const { data: members } = useMembers(workspaceId ?? undefined);
  // S06 (FR-MSG-22): 빈 채널 상태 보강용 채널 메타(name/type/topic/createdAt).
  // workspaceId 가 null(DM)이면 hook 이 비활성(enabled:false)이라 undefined.
  const { data: channelList } = useChannelList(workspaceId ?? undefined);
  // S09 (FR-RT-22): 채널 진입(전환)을 LRU 에 기록하고, 상한 초과 채널의
  // 메시지 목록 캐시를 evict 합니다. useMessageHistory 보다 먼저 호출해
  // evict 신호(pendingAround)가 초기 로드 시점에 반영되도록 합니다.
  useChannelLru(workspaceId, channelId);
  const qc = useQueryClient();
  // S30 fix-forward (M2): `?msg=` 점프가 있으면 그 메시지를 around anchor 로
  // 초기 로드(lastRead 복원보다 우선). jumpMessageId 는 부모가 1회 소비 후
  // 제거하므로 재요청 시 재anchor 되지 않습니다.
  const history = useMessageHistory(workspaceId, channelId, jumpMessageId);
  // S37 fix-forward (BLOCKER-1): 점프 대상 전용 one-shot around 로드. 메인 list
  // 캐시가 이미 있어(채널 캐시 hit) queryFn 이 재실행되지 않는 경우에도, 이
  // 별도 쿼리가 around-load 를 확실히 발화한다. settled 상태 + 결과(대상 포함
  // 여부 / 404)가 not-found 토스트 판정과 메인 list seed(스크롤)의 단일 출처다.
  const jumpAround = useJumpAround(workspaceId, channelId, jumpMessageId);
  const delMut = useDeleteMessage(workspaceId, channelId);
  const updMut = useUpdateMessage(workspaceId, channelId);
  const reactMut = useToggleReaction(workspaceId, channelId);
  // task-045 iter1: pin/unpin mutations. DM 채널 (workspaceId=null) 은
  // hook 안에서 reject 하므로 호출 자체는 항상 가능. UI 쪽에서 wsId 가
  // null 이면 onPin/onUnpin 콜백 자체를 undefined 로 전달해 메뉴 hide.
  const pinMut = usePinMessage(workspaceId, channelId);
  const unpinMut = useUnpinMessage(workspaceId, channelId);
  // S51 (FR-PS-07/13): 개인 저장 토글. 낙관적으로 per-message saved 캐시를 뒤집는다.
  const saveMut = useToggleSave();

  // S42 (FR-PK01): 피커 데이터(퀵반응·최근·skinTone)를 채널 단위 단일 쿼리로 읽어
  // 각 MessageItem 의 ReactionBar 피커에 prop 으로 내려준다(per-row useQuery 회피 —
  // MessageItem 정적 렌더 invariant 보존). 사용자 퀵반응 우선, 없으면 워크스페이스
  // 기본(FR-PK04 fallback). DM(workspaceId=null)이면 hook 비활성 → 전부 undefined.
  const { data: pickerData } = useEmojiPickerData(workspaceId);
  const pickerQuickReactions =
    pickerData?.userQuickReactions ?? pickerData?.workspaceQuickReactions;
  // S24 (FR-RS-08): 메시지 "미읽음으로 표시" — 이 메시지 직전으로 읽음 커서 後進.
  // DM(workspaceId=null)은 unread-summary 가 없어 hook 이 no-op 이므로 콜백 hide.
  const markUnreadMut = useMarkUnread(workspaceId ?? undefined);
  // S03 (FR-MSG-05): retry a failed optimistic send. Reuses the SAME
  // clientNonce encoded in the failed row id so the server dedupes against
  // the original Idempotency-Key.
  const { retry } = useSendMessage(workspaceId, channelId);
  const scrollRef = useRef<HTMLDivElement>(null);
  // S64 (FR-RM11): 메시지 신고 모달 대상 messageId(없으면 닫힘). 워크스페이스 채널에서만
  // 신고 메뉴를 노출하므로 DM(workspaceId=null)에서는 onReport 자체를 전달하지 않는다.
  const [reportTargetId, setReportTargetId] = useState<string | null>(null);

  const messages = useMemo<MessageDto[]>(() => {
    const pages = history.data?.pages ?? [];
    const all = pages.flatMap((p) => p.items);
    return [...all].reverse(); // DESC pages → ASC render order
  }, [history.data]);

  const messageIds = useMemo(() => messages.map((m) => m.id), [messages]);

  // S83a (FR-KS-06): composer 가 빈 draft 에서 ↑ 를 누르면 qufox.message.editLast 를
  // dispatch 한다. 현재 채널의 마지막 내 메시지(tmp 제외)에 nonce 를 bump 해 MessageItem 이
  // 인라인 편집 모드로 진입하게 한다. 내 메시지가 없으면 no-op.
  const [editReq, setEditReq] = useState<{ id: string; nonce: number } | null>(null);
  useEffect(() => {
    const onEditLast = (ev: Event): void => {
      const detail = (ev as CustomEvent<{ channelId?: string }>).detail;
      if (detail?.channelId && detail.channelId !== channelId) return;
      const mine = messages.filter((m) => m.authorId === user?.id && !m.id.startsWith('tmp-'));
      const last = mine[mine.length - 1];
      if (!last) return;
      setEditReq((prev) => ({ id: last.id, nonce: (prev?.nonce ?? 0) + 1 }));
    };
    window.addEventListener('qufox.message.editLast', onEditLast);
    return () => window.removeEventListener('qufox.message.editLast', onEditLast);
  }, [messages, user?.id, channelId]);

  // S52 (FR-PS-13): 렌더 중인 메시지 id 배치로 서버 저장 상태를 1회 seed 해 툴바
  // 북마크 채움을 초기화한다(N+1 단건 GET 금지). tmp(낙관적 send) 행은 서버 id 가
  // 없어 제외한다.
  const savedSeedIds = useMemo(
    () => messageIds.filter((id) => !id.startsWith('tmp-')),
    [messageIds],
  );
  useInitSavedStatus(savedSeedIds);

  // S75 (D14 / FR-PS-06 · B1 carryover): 채팅 작성자 표시명도 멤버목록과 동일하게
  // ws 오버라이드 우선순위(wsNickname > displayName > username)로 해석한다. 이미 로드된
  // 채널 멤버 데이터(useMembers — wsNickname/displayName 포함)를 재사용하므로 추가 라운드
  // 트립/N+1 이 없다(S74 가 멤버목록만 반영하고 채팅 작성자명은 username 폴백이던 carryover 해소).
  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members?.members ?? []) map.set(m.userId, resolveMemberDisplayName(m.user));
    return map;
  }, [members]);

  const roleById = useMemo(() => {
    const map = new Map<string, WorkspaceRole>();
    for (const m of members?.members ?? []) map.set(m.userId, m.role);
    return map;
  }, [members]);

  // task-045 iter1: viewer 의 워크스페이스 role. members 응답은 viewer
  // 자신도 포함 — userId 매칭으로 role 추출. DM 채널 (workspaceId=null)
  // 또는 viewer 가 멤버 list 에 없으면 null → MessageItem 의 Pin 메뉴
  // 자동 hide.
  const viewerRole = useMemo<WorkspaceRole | null>(() => {
    if (!user) return null;
    return roleById.get(user.id) ?? null;
  }, [roleById, user]);

  // S04 (FR-MSG-13): mention 표시명 룩업. 서버가 `@username` 을
  // `@{cuid2}` 로 정규화해 저장하므로 contentAst 의 mention_user 노드는
  // userId(cuid2) 만 담습니다. 워크스페이스 멤버 맵(nameById) + DM 참가자
  // fallback(extraNames) 으로 표시명을 다시 해석해 `@username` pill 을
  // 그립니다. 맵에 없으면 renderAst 가 userId 로 폴백합니다.
  const mentionLookup = useMemo<MentionLookup>(
    () => ({
      userName: (userId: string) => nameById.get(userId) ?? extraNames?.get(userId),
    }),
    [nameById, extraNames],
  );

  // S34 (FR-TH-03): reply bar 의 최근 답글자 아바타 표시명 resolver. mention
  // 룩업과 같은 소스(워크스페이스 멤버 맵 + DM 참가자 fallback)를 공유한다.
  // MessageItem 으로 넘겨 chip 이 seed-color 점 대신 이름 이니셜 아바타를 그린다.
  const resolveReplyName = useMemo(
    () => (userId: string) => nameById.get(userId) ?? extraNames?.get(userId),
    [nameById, extraNames],
  );

  // S06 (FR-MSG-22): 현재 채널 메타를 채널 목록에서 찾습니다. 카테고리화된
  // 채널 + uncategorized 를 모두 훑어 id 매칭. 못 찾거나 DM 이면 undefined →
  // 빈 상태가 generic 카피로 폴백합니다.
  const channelMeta = useMemo(() => {
    if (!channelList) return undefined;
    const all = [
      ...channelList.categories.flatMap((c) => c.channels),
      ...channelList.uncategorized,
    ];
    return all.find((c) => c.id === channelId);
  }, [channelList, channelId]);

  // S23 (FR-RS-06): NEW MESSAGES 구분선 — 채널 진입 시점의 읽음 상태 스냅샷.
  // unread-summary 의 채널별 unreadCount + readStateStore 의 lastReadMessageId
  // 를 firstUnread index 로 환산해 구분선이 들어갈 ASC 메시지 인덱스를 정한다.
  // 진입 시점에 한 번 고정(snapshot)해 스크롤/새 ACK 로 즉시 사라지지 않게 한다
  // (FR-RS-06 — 채널 진입 스냅샷). 첫 페인트(메시지 로드 완료) 전까지는 null.
  //
  // S23 MAJOR fix (cold 캐시 구분선 소실): 종전엔 여기서 useUnreadSummary 를
  // 직접 읽었으나, 부모(MessageColumn)가 채널 open 시 markRead/zeroOut 으로 같은
  // 캐시 키를 0 으로 누르므로 cold summary(미캐시/staleTime 만료) 진입에서는
  // 스냅샷이 unreadCount=0 을 봐 구분선이 사라졌다. 이제 부모가 zero-out *이전*
  // 에 고정한 `unreadSnapshot` prop 을 단일 출처로 쓴다(prop 미제공 시에만
  // useUnreadSummary 폴백 — DM 등). MessageList 는 channelId 마다 remount(key)
  // 되므로 prop 은 채널 수명 동안 불변이다.
  const { data: unreadSummary } = useUnreadSummary(workspaceId ?? undefined);
  const dividerIndexRef = useRef<number | null>(null);
  const dividerSnappedRef = useRef(false);
  const [dividerIndex, setDividerIndex] = useState<number | null>(null);
  useEffect(() => {
    // 채널 전환 시 스냅샷 초기화(아래 layout effect 와 동일 채널 키).
    dividerSnappedRef.current = false;
    dividerIndexRef.current = null;
    setDividerIndex(null);
  }, [channelId]);
  useLayoutEffect(() => {
    if (dividerSnappedRef.current) return;
    if (messages.length === 0) return;
    // 부모 스냅샷이 있으면 그것을 단일 출처로 쓴다(zero-out 오염 차단).
    // 없으면(DM 등) 종전 폴백: unread-summary 로드 대기 후 캐시 + store 사용.
    let unreadCount: number;
    let lastReadMessageId: string | null;
    if (unreadSnapshot) {
      unreadCount = unreadSnapshot.unreadCount;
      lastReadMessageId = unreadSnapshot.lastReadMessageId;
    } else {
      // unread-summary 가 아직 로드 안 됐으면 다음 렌더를 기다린다(불변식: 진입
      // 직후 한 번만 스냅샷). DM(workspaceId=null)은 unread-summary 가 없어
      // unreadCount=0 으로 폴백 → 구분선 미표시(carryover).
      if (workspaceId && !unreadSummary) return;
      const summaryRow = workspaceId
        ? unreadSummary?.channels.find((c) => c.channelId === channelId)
        : undefined;
      unreadCount = summaryRow?.unreadCount ?? 0;
      lastReadMessageId = useReadState.getState().getLastRead(channelId);
    }
    const idx = computeFirstUnreadIndex({ messageIds, lastReadMessageId, unreadCount });
    dividerIndexRef.current = idx;
    dividerSnappedRef.current = true;
    setDividerIndex(idx);
  }, [channelId, workspaceId, unreadSummary, unreadSnapshot, messages.length, messageIds]);

  // S23 (FR-RS-06): 구분선을 별도 가상행으로 끼우는 좌표 플랜. count/매핑이
  // 단일 출처(newMessages)라 렌더·anchor·jump 판정이 동일 좌표계를 쓴다.
  const rowPlan = useMemo(
    () => buildRowPlan({ messageCount: messages.length, dividerIndex }),
    [messages.length, dividerIndex],
  );
  const dividerVirtualIndex = virtualIndexForDivider(rowPlan);

  const virtualizer = useVirtualizer({
    count: rowPlan.count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 8,
  });

  // S30 fix-forward (M2): 검색 점프 후 잠시 강조할 메시지 id. data-jump-highlight
  // 속성으로 해당 행에 짧은 펄스(아래 className arbitrary, DS --mention-bg 토큰)를
  // 입히고 ~2s 후 해제합니다.
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  // 같은 jumpMessageId 에 대해 스크롤/소비를 1회만 수행하기 위한 가드.
  const consumedJumpRef = useRef<string | null>(null);
  // S37 (FR-MSG-18): not-found 토스트를 같은 점프 대상에 대해 1회만 띄우기 위한 가드.
  const notFoundToastedRef = useRef<string | null>(null);
  // S37 fix-forward (BLOCKER-1): around 결과로 메인 list 를 1회만 seed 하기 위한 가드.
  const jumpSeededRef = useRef<string | null>(null);
  const highlightTimerRef = useRef<number | null>(null);
  const pushNotification = useNotifications((s) => s.push);

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
  // S23: rowPlan(구분선 좌표)을 ref 로 노출해 스크롤 리스너/anchor effect 가
  // 가상 인덱스↔메시지 인덱스 변환에 최신 plan 을 쓰게 한다(재바인딩 없이).
  const rowPlanRef = useRef(rowPlan);
  rowPlanRef.current = rowPlan;
  // S22 (FR-RS-02): onReadCursor 를 ref 로 보관해 콜백 identity 변화가 cursor
  // 효과를 재실행하지 않도록 한다(tail id 변경에만 반응).
  const onReadCursorRef = useRef(onReadCursor);
  onReadCursorRef.current = onReadCursor;

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
        // S23: 가상 인덱스(구분선 행 포함)를 메시지 인덱스로 변환해 넘긴다.
        // 구분선 행(매핑 null)은 제외 — anchor 는 메시지 행에만 건다.
        const plan = rowPlanRef.current;
        const mappedItems = virtualizerRef.current
          .getVirtualItems()
          .map((vi) => ({ index: messageIndexForVirtualIndex(plan, vi.index), start: vi.start }))
          .filter((vi): vi is { index: number; start: number } => vi.index !== null);
        anchorSnapshotRef.current = takeAnchorSnapshot({
          scrollTop: el.scrollTop,
          virtualItems: mappedItems,
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
    // S23: 바닥 고정은 마지막 *가상행*(구분선 행 포함 count-1). 마지막 행은
    // 항상 메시지라 lastRowVirtualIndex 가 곧 최신 메시지의 가상 좌표다.
    if (!hasAnchoredRef.current) {
      virtualizer.scrollToIndex(lastRowVirtualIndex(rowPlanRef.current), { align: 'end' });
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
        // S23: 메시지 인덱스 i 를 가상 인덱스로 변환해 해당 행의 start 를 찾는다
        // (구분선 행 삽입으로 두 좌표계가 어긋나므로 변환 필수).
        startForIndex: (i) => {
          const vIdx = virtualIndexForMessageIndex(rowPlanRef.current, i);
          const item = virtualizer.getVirtualItems().find((v) => v.index === vIdx);
          if (item) return item.start;
          // Fallback: read the virtualizer's measurementsCache which
          // holds heights for every measured row; ESTIMATED_ROW_HEIGHT
          // is the floor for never-seen rows.
          const cache = virtualizer.measurementsCache;
          const cached = cache && cache[vIdx];
          if (cached && typeof cached.start === 'number') return cached.start;
          return vIdx * ESTIMATED_ROW_HEIGHT;
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
        virtualizer.scrollToIndex(lastRowVirtualIndex(rowPlanRef.current), { align: 'end' });
      }
    }
    // Otherwise hold position; the user has scrolled up and a new
    // message arrived. Existing unread / new-message divider UX
    // (when added) layers on top of this hold.
  }, [messages.length, messageIds, virtualizer]);

  const items = virtualizer.getVirtualItems();

  // S23 (FR-RS-07): Jump-to-First-Unread pill 표시 판정. IntersectionObserver
  // 대신 현재 *보이는* 최상단 가상행 인덱스 vs 구분선 가상행 인덱스를 비교한다
  // (가상화는 구분선이 마운트 안 된 채 윈도우 밖일 수 있어 IO 불가).
  //
  // S23 MAJOR fix (overscan 오판): items[0].index 는 뷰포트 위 overscan(8행)을
  // 포함하므로 구분선이 화면 밖(위)인데도 마운트돼 있다는 이유로 pill 이 숨었다.
  // scrollTop 기준으로 실제 보이는 최상단(첫 start+size > scrollTop)을 골라
  // overscan 을 보정한다(firstVisibleIndex 단일 출처).
  const scrollTopForPill = scrollRef.current?.scrollTop ?? 0;
  const firstVisible = firstVisibleIndex(
    items.map((vi) => ({ index: vi.index, start: vi.start, size: vi.size })),
    scrollTopForPill,
  );
  const showJumpPill = shouldShowJumpPill({
    firstRenderedIndex: firstVisible,
    dividerIndex: dividerVirtualIndex,
  });

  // FR-RS-07: pill 클릭 → 구분선으로 스크롤(align:start) + 20ms 이내 미세 보정
  // 스크롤(가상화 remeasure 후 위치가 어긋날 수 있어 한 번 더 정렬). 구분선이
  // 없으면 no-op.
  //
  // S23 cheap fix (#9): 20ms 보정 타이머 핸들을 ref 에 저장해 언마운트/연속
  // 클릭 시 정리한다(중복 타이머 누수 방지).
  // S23 a11y BLOCKER fix (#7): jump 직후 pill 이 언마운트되면 포커스가 body 로
  // 떨어져 키보드 사용자가 맥락을 잃는다. 스크롤 컨테이너(tabIndex=-1)로 포커스를
  // 옮겨 SR/키보드 포커스를 유지한다.
  const jumpTimerRef = useRef<number | null>(null);
  const jumpToFirstUnread = (): void => {
    if (dividerVirtualIndex === null) return;
    virtualizer.scrollToIndex(dividerVirtualIndex, { align: 'start' });
    if (jumpTimerRef.current !== null) window.clearTimeout(jumpTimerRef.current);
    jumpTimerRef.current = window.setTimeout(() => {
      virtualizer.scrollToIndex(dividerVirtualIndex, { align: 'start' });
      jumpTimerRef.current = null;
    }, 20);
    // 포커스를 스크롤 컨테이너로 이동(pill 언마운트로 포커스 소실 방지).
    scrollRef.current?.focus();
  };
  // 언마운트 시 대기 중인 보정 타이머 정리.
  useEffect(() => {
    return () => {
      if (jumpTimerRef.current !== null) {
        window.clearTimeout(jumpTimerRef.current);
        jumpTimerRef.current = null;
      }
    };
  }, []);

  // S30 fix-forward (BLOCKER 기능 M2) + S37 fix-forward (BLOCKER-1): `?msg=` 점프
  // 소비. 검색 결과/permalink 클릭으로 채널이 열리면 해당 메시지로 스크롤 +
  // 하이라이트 펄스를 적용하고 부모에게 소비 완료를 알립니다(부모가 URL 의 `?msg=`
  // 제거). 같은 id 는 1회만 처리합니다.
  //
  // BLOCKER-1 의 핵심: 토스트/스크롤 판정의 단일 출처를 메인 list 가 아니라 전용
  // around 쿼리(jumpAround)로 둔다. 메인 list 는 채널이 캐시돼 있으면 around-load
  // 가 발화되지 않아(키 불변) window-밖 존재 메시지를 not-found 로 오판했다.
  // 분기:
  //   (1) 대상이 메인 list 에 이미 있음        → 스크롤 + 하이라이트 + 소비.
  //   (2) 없음 + around 로딩 중(settled 전)    → 대기(다음 렌더 재시도, 토스트 X).
  //   (3) 없음 + around 성공 + 결과에 대상 포함 → 메인 list 를 around 결과로 1회
  //       seed → 다음 렌더에서 (1) 경로로 스크롤(window-밖이어도 동작).
  //   (4) 없음 + around settled + 결과에 대상 없음(soft-deleted 필터) 또는 에러
  //       (404/MESSAGE_NOT_FOUND) → not-found 토스트 1회 + 소비.
  useEffect(() => {
    if (!jumpMessageId) return;
    if (consumedJumpRef.current === jumpMessageId) return;
    const msgIndex = messageIds.indexOf(jumpMessageId);
    if (msgIndex < 0) {
      // around 쿼리 상태로 판정한다(메인 list 가 아님).
      const jumpSettled = jumpAround.isError || (jumpAround.isSuccess && !jumpAround.isFetching);
      // (2) 아직 로딩 중이면 대기.
      if (!jumpSettled) return;

      // around 결과에 대상이 비-삭제 상태로 존재하는지(=실제 점프 가능) 판정.
      const aroundItems = jumpAround.data?.items ?? [];
      const foundInAround = aroundItems.some((m) => m.id === jumpMessageId && !m.deleted);

      // (3) 대상이 around 에 있으면 메인 list 캐시를 around 결과로 1회 seed 한다.
      // permalink 점프는 의도적으로 그 메시지 주변으로 컨텍스트를 재앵커하는
      // UX(Slack/Discord 동일)라, 단일 around 페이지로 교체해도 무방하다 —
      // around 응답의 커서로 이후 페이지네이션도 정상 동작한다.
      if (foundInAround) {
        if (jumpSeededRef.current !== jumpMessageId) {
          jumpSeededRef.current = jumpMessageId;
          qc.setQueryData<InfiniteData<ListMessagesResponse>>(
            qk.messages.list(workspaceId ?? 'global', channelId),
            () => ({ pages: [jumpAround.data as ListMessagesResponse], pageParams: [undefined] }),
          );
        }
        // seed 후 메인 list 가 갱신되면 이 effect 가 재실행돼 (1) 경로로 스크롤한다.
        return;
      }

      // (4) around 가 settled 인데 대상이 없음(삭제 필터) 또는 에러(404) → not-found.
      const code = (jumpAround.error as { errorCode?: string } | undefined)?.errorCode;
      const notFound = shouldToastJumpNotFound({
        jumpMessageId,
        settled: jumpSettled,
        found: foundInAround,
        isError: jumpAround.isError,
      });
      if (notFound && notFoundToastedRef.current !== jumpMessageId) {
        notFoundToastedRef.current = jumpMessageId;
        pushNotification({
          variant: 'warning',
          title: '메시지를 찾을 수 없습니다',
          body:
            code === 'MESSAGE_NOT_FOUND'
              ? '삭제되었거나 접근할 수 없는 메시지입니다.'
              : '이 메시지는 더 이상 존재하지 않습니다.',
          ttlMs: 4000,
        });
        // 소비 처리: URL 의 `?msg=` 를 제거해 재진입/뒤로가기 루프를 막는다.
        onJumpConsumed?.();
      }
      return;
    }
    // (1) 대상이 메인 list 에 존재 → 스크롤 + 하이라이트 + 소비.
    consumedJumpRef.current = jumpMessageId;
    // 가상 인덱스로 변환해 화면 중앙으로 스크롤(가상화 remeasure 보정 1회).
    const vIdx = virtualIndexForMessageIndex(rowPlanRef.current, msgIndex);
    virtualizer.scrollToIndex(vIdx, { align: 'center' });
    window.setTimeout(() => {
      virtualizer.scrollToIndex(vIdx, { align: 'center' });
      // 스크롤 후 실제 DOM 요소가 있으면 보장 차원에서 scrollIntoView 한 번 더.
      const el = scrollRef.current?.querySelector<HTMLElement>(
        `[data-testid="msg-${jumpMessageId}"]`,
      );
      el?.scrollIntoView({ block: 'center' });
    }, 20);
    // 하이라이트 펄스(약 2s) 적용 후 해제.
    setHighlightedId(jumpMessageId);
    if (highlightTimerRef.current !== null) window.clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = window.setTimeout(() => {
      setHighlightedId(null);
      highlightTimerRef.current = null;
    }, 2000);
    // 소비 완료를 부모에 통지 → `?msg=` 파라미터 제거(재진입/뒤로가기 루프 방지).
    onJumpConsumed?.();
  }, [
    jumpMessageId,
    messageIds,
    virtualizer,
    onJumpConsumed,
    qc,
    workspaceId,
    channelId,
    // S37 fix-forward (BLOCKER-1): not-found/seed 판정에 쓰는 around 쿼리 상태.
    jumpAround.isError,
    jumpAround.isSuccess,
    jumpAround.isFetching,
    jumpAround.data,
    jumpAround.error,
    pushNotification,
  ]);

  // 언마운트 시 하이라이트 타이머 정리.
  useEffect(() => {
    return () => {
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
        highlightTimerRef.current = null;
      }
    };
  }, []);

  // S22 (FR-RS-02): tail(최신 메시지 id)이 바뀔 때마다 읽음 커서를 올려보낸다.
  // atBottom 판정:
  //   1. 마지막 메시지가 가상 윈도우에 렌더돼 있어야 하고(마지막 virtualIndex
  //      === messages.length-1), AND
  //   2. 스크롤 컨테이너가 바닥 50px 이내(FR-RS-02 임계치).
  // 둘 중 하나라도 거짓이면 사용자가 위를 보고 있는 것이므로 즉시 ACK 가 아니라
  // 디바운스 경로로 보낸다(MessageColumn 이 분기).
  const lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : null;
  useEffect(() => {
    if (!lastMessageId) return;
    const cb = onReadCursorRef.current;
    if (!cb) return;
    const el = scrollRef.current;
    const lastVirtual = items.length > 0 ? items[items.length - 1] : null;
    // S23: 마지막 가상행(구분선 행 포함)이 렌더됐는지로 바닥 도달 판정.
    const lastRendered = lastVirtual
      ? lastVirtual.index === lastRowVirtualIndex(rowPlanRef.current)
      : false;
    const nearBottom = el
      ? isNearBottom({
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          slack: 50,
        })
      : false;
    cb({ lastMessageId, atBottom: lastRendered && nearBottom });
    // tail id 변경에만 반응한다. items/messages.length/scroll element 는 같은
    // 렌더에서 함께 갱신되므로 lastMessageId 만 deps 로 둬도 cursor 가 정합한다.
    // (이 repo 는 react-hooks/exhaustive-deps 규칙 미설치 — disable 주석 불필요.)
  }, [lastMessageId]);

  return (
    <CustomEmojiProvider workspaceId={workspaceId}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {showJumpPill ? (
          <button
            type="button"
            data-testid="jump-to-unread"
            // FR-RS-07: 채팅 영역 상단 고정 pill. DS 토큰만(raw hex/px 금지).
            //
            // S23 ui-designer HIGH + a11y S-3 fix (#6): 종전 bg-accent 는
            // --bg-selected(navy n-5)로 해석돼 의도(violet accent)와 다르고 흰
            // 텍스트 대비가 미달했다. --badge-unread-bg(a-600, 흰 텍스트 AA
            // 통과 + accent 계열)로 교체한다.
            // S23 a11y BLOCKER fix (#7): pill 의 focus-visible 링이 shadow-[]
            // (elev-3)에 덮이지 않도록 focus-visible 에서 --ring-focus 를 명시한다.
            className="absolute left-1/2 top-[var(--s-3)] z-[var(--z-sticky)] -translate-x-1/2 rounded-[var(--r-pill)] bg-[var(--badge-unread-bg)] px-[var(--s-4)] py-[var(--s-2)] text-[length:var(--fs-13)] font-medium text-[color:var(--text-onAccent)] shadow-[var(--elev-3)] focus-visible:shadow-[var(--ring-focus)] focus-visible:outline-none"
            onClick={jumpToFirstUnread}
          >
            새 메시지로 이동
          </button>
        ) : null}
        <Scrollable
          ref={scrollRef}
          data-testid="msg-list"
          role="log"
          aria-live="polite"
          aria-label="메시지"
          // S23 a11y BLOCKER fix (#7): jump 후 pill 언마운트로 포커스가 body 로
          // 떨어지지 않게, jumpToFirstUnread 가 이 컨테이너로 포커스를 옮긴다.
          // tabIndex=-1 로 프로그램적 포커스만 허용(탭 순서엔 들어가지 않음).
          tabIndex={-1}
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
            <ChannelEmptyState channel={channelMeta} creatorCta={creatorCta} />
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
                // S23 (FR-RS-06): 구분선 행은 메시지가 아니므로 별도 렌더.
                if (vi.index === dividerVirtualIndex) {
                  return (
                    <div
                      key="new-messages-divider"
                      data-testid="new-messages-divider-row"
                      ref={virtualizer.measureElement}
                      data-index={vi.index}
                      style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${vi.start}px)`,
                      }}
                    >
                      <NewMessagesDivider />
                    </div>
                  );
                }
                // 가상 인덱스 → 메시지 ASC 인덱스(구분선 뒤는 한 칸 당김).
                const msgIndex = messageIndexForVirtualIndex(rowPlan, vi.index);
                if (msgIndex === null) return null;
                const m = messages[msgIndex];
                if (!m) return null;
                const prev = msgIndex > 0 ? messages[msgIndex - 1] : null;
                // S06 (FR-MSG-11): 이전 메시지와 로컬 달력 일이 바뀌는 지점마다
                // 날짜 구분선을 행 안에 prepend 합니다. 첫 메시지(prev 없음)
                // 위에도 그 날짜의 구분선을 둡니다. 가상화 행 안에 두어
                // measureElement 가 divider 높이까지 함께 측정하게 합니다.
                const showDayDivider = !prev || !isSameLocalDay(m.createdAt, prev.createdAt);
                const dayDivider = showDayDivider ? <DayDivider iso={m.createdAt} /> : null;
                // S04 (FR-MSG-19): SYSTEM_* 메시지는 항상 독립 행(grouped=false)
                // 으로 렌더하고, 직전 메시지가 시스템 행이면 현재 메시지의
                // 그루핑을 끊습니다(±1 인접 재계산). 그루핑은 클라이언트가
                // 계산하며 서버는 grouped 를 내려주지 않습니다. 술어는
                // grouping.ts 단일 출처를 공유합니다.
                const isSystem = isSystemMessageType(m.type);
                const isContinuation = computeIsContinuation(m, prev);
                if (isSystem) {
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
                      {dayDivider}
                      {/* S35 (FR-TH-06): broadcast 행은 SYSTEM 타입이지만 클릭 시
                          스레드를 연다 — onOpenThread 를 전달한다. 일반 SYSTEM_*
                          행은 onOpenThread 가 있어도 SystemMessage 가 broadcast
                          분기에서만 사용하므로 무영향. */}
                      <SystemMessage
                        msg={m}
                        onOpenThread={
                          // F-04: 삭제된 broadcast 는 클릭 비활성이므로 onOpenThread 를
                          // 전달하지 않는다(SystemMessage 도 deleted 시 비클릭이지만,
                          // 게이트에서 한 번 더 막아 클릭 핸들러 자체를 비운다).
                          onOpenThread && !m.id.startsWith('tmp-') && !m.deleted
                            ? onOpenThread
                            : undefined
                        }
                        // S51 (FR-PS-15): SYSTEM_PIN 행은 채널 멤버 누구나 삭제 가능.
                        // 일반 메시지 delMut 을 재사용한다(서버 게이트가 SYSTEM_PIN
                        // 멤버 삭제를 허용 + 원본 핀 유지). tmp/이미 삭제 행은 비노출.
                        onDelete={
                          m.type === 'SYSTEM_PIN' && !m.id.startsWith('tmp-') && !m.deleted
                            ? async () => {
                                await delMut.mutateAsync(m.id);
                              }
                            : undefined
                        }
                      />
                    </div>
                  );
                }
                const isJumpHighlighted = m.id === highlightedId;
                return (
                  <div
                    key={m.id}
                    data-testid="message-row"
                    data-index={vi.index}
                    // S30 fix-forward (M2): 검색 점프 대상 행에 짧은 강조 펄스.
                    // DS --mention-bg 토큰만 사용(raw hex/px 금지). 펄스가 끝나면
                    // highlightedId 가 null 로 풀려 배경이 사라진다.
                    data-jump-highlight={isJumpHighlighted ? 'true' : undefined}
                    ref={virtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${vi.start}px)`,
                      ...(isJumpHighlighted
                        ? {
                            backgroundColor: 'var(--mention-bg)',
                            // S35 fix-forward (DS 토큰화): raw `ease-out` → DS easing 토큰.
                            transition: 'background-color var(--dur-base) var(--ease-standard)',
                          }
                        : {
                            transition: 'background-color var(--dur-base) var(--ease-standard)',
                          }),
                    }}
                  >
                    {dayDivider}
                    <MessageItem
                      msg={m}
                      isMine={m.authorId === user?.id}
                      editRequestNonce={editReq?.id === m.id ? editReq.nonce : undefined}
                      // S37 (FR-MSG-08): 편집 이력 팝오버가 워크스페이스 스코프
                      // history 엔드포인트를 호출하기 위한 wsId. DM(null)이면
                      // 팝오버가 fetch 를 비활성한다.
                      workspaceId={workspaceId}
                      isContinuation={isContinuation}
                      authorName={nameById.get(m.authorId) ?? extraNames?.get(m.authorId)}
                      authorRole={roleById.get(m.authorId) ?? null}
                      mentions={mentionLookup}
                      viewerRole={viewerRole}
                      // S51 (FR-PS-05): 채널 핀 권한 토글. false 면 MEMBER 의
                      // 핀 메뉴를 숨긴다(서버 게이트와 정합 — 기본 true).
                      memberCanPin={channelMeta?.memberCanPin ?? true}
                      resolveName={resolveReplyName}
                      pickerQuickReactions={pickerQuickReactions}
                      pickerRecentEmojis={pickerData?.recentEmojis}
                      pickerDefaultSkinTone={pickerData?.defaultSkinTone}
                      onEditSave={async (content) => {
                        // S05 (FR-MSG-06): 편집창 오픈 시점의 version 을 낙관적
                        // 잠금 기대값으로 동봉. 서버 version 과 불일치 시 409 →
                        // 훅 onError 가 캐시를 서버 최신 DTO 로 롤백 + 토스트.
                        await updMut.mutateAsync({
                          msgId: m.id,
                          content,
                          expectedVersion: m.version ?? 0,
                        });
                      }}
                      onDelete={async () => {
                        await delMut.mutateAsync(m.id);
                      }}
                      onToggleReaction={(emoji, byMe) => {
                        if (m.id.startsWith('tmp-')) return;
                        reactMut.toggle({ messageId: m.id, emoji, currentlyByMe: byMe });
                      }}
                      onOpenThread={
                        onOpenThread && !m.id.startsWith('tmp-')
                          ? (rootId) => onOpenThread(rootId)
                          : undefined
                      }
                      onPin={
                        // task-045 iter1: DM (wsId=null) + tmp 메시지는
                        // pin 불가. OWNER/ADMIN gate 는 MessageItem 안.
                        workspaceId && !m.id.startsWith('tmp-') && !m.pinnedAt
                          ? async () => {
                              await pinMut.mutateAsync(m.id);
                            }
                          : undefined
                      }
                      onUnpin={
                        workspaceId && !m.id.startsWith('tmp-') && !!m.pinnedAt
                          ? async () => {
                              await unpinMut.mutateAsync(m.id);
                            }
                          : undefined
                      }
                      // S51 (FR-PS-07/13): 개인 저장 토글. tmp(낙관적 send) 행은
                      // 서버 id 가 없어 비노출. saved 여부는 토글 캐시에서 읽는다.
                      onToggleSave={
                        !m.id.startsWith('tmp-')
                          ? (currentlySaved) => saveMut.mutate({ messageId: m.id, currentlySaved })
                          : undefined
                      }
                      isSaved={qc.getQueryData<boolean>(savedKeys.status(m.id)) === true}
                      // S03 (FR-MSG-05): retry a failed optimistic send with the
                      // SAME clientNonce (encoded in the row id).
                      onRetry={
                        (m as MessageDto & { sendState?: 'pending' | 'failed' }).sendState ===
                        'failed'
                          ? () => retry(m.id, m.content ?? '')
                          : undefined
                      }
                      // S24 (FR-RS-08): 수동 미읽 — workspace 채널(unread-summary
                      // 존재) + 비-tmp 행에서만 노출. 이 메시지 직전으로 後進.
                      onMarkUnread={
                        workspaceId && !m.id.startsWith('tmp-')
                          ? async () => {
                              await markUnreadMut.mutateAsync({
                                channelId,
                                messageId: m.id,
                              });
                            }
                          : undefined
                      }
                      // S64 (FR-RM11): 워크스페이스 채널 + 타인 메시지 + 비-tmp 행에서만
                      // 신고 메뉴를 노출한다(DM·본인 메시지는 undefined → hide).
                      onReport={
                        workspaceId &&
                        m.authorId !== user?.id &&
                        !m.id.startsWith('tmp-') &&
                        !m.deleted
                          ? () => setReportTargetId(m.id)
                          : undefined
                      }
                    />
                  </div>
                );
              })}
            </div>
          )}
        </Scrollable>
      </div>
      {workspaceId && reportTargetId ? (
        <ReportModal
          workspaceId={workspaceId}
          channelId={channelId}
          messageId={reportTargetId}
          onClose={() => setReportTargetId(null)}
        />
      ) : null}
    </CustomEmojiProvider>
  );
}

/**
 * S06 (FR-MSG-22) — 빈 채널 상태 보강.
 *
 * 기존 generic 카피 대신 채널명·생성일·채널 타입별 안내를 보여 줍니다. DS 정본
 * `.qf-empty` / `.qf-empty__title` / `.qf-empty__body` 를 그대로 사용합니다
 * (FR 명칭 `qf-channel-empty-state` 는 DS 미존재 → DS 의 `.qf-empty` 채택).
 *
 * Channel DTO 에는 name/type/topic/createdAt 만 있고 createdBy(생성자)·
 * description 필드가 없어, 생성자 표기는 생략하고 설명은 topic 으로 대체합니다.
 * 채널 메타를 못 찾거나(DM·로딩 중) channel 이 undefined 면 generic 으로 폴백.
 */
function ChannelEmptyState({
  channel,
  creatorCta,
}: {
  channel: Channel | undefined;
  // S71 (FR-W09a): 생성자(OWNER) CTA. 제공되면 empty state 하단에 렌더한다.
  creatorCta?: ReactNode;
}): JSX.Element {
  const focusComposer = (): void => {
    // task-047 iter5 (O1): CTA — composer 에 포커스. composer 가 channel 헤더
    // 아래 mounted 라 composer-focus event 로 dispatch(search 와 동일 패턴).
    window.dispatchEvent(new CustomEvent('qufox.composer.focus'));
  };

  if (!channel) {
    // DM / 로딩 중 / 미발견 → 기존 generic 카피 유지(회귀 방지).
    return (
      <div className="qf-empty" data-testid="channel-empty">
        <h2 className="qf-empty__title m-0">채널이 한산하네요</h2>
        <div className="qf-empty__body">
          아래에서 첫 메시지를 보내 대화를 시작하세요. <kbd className="qf-menu__kbd">Enter</kbd> 로
          전송할 수 있습니다.
        </div>
        <button
          type="button"
          data-testid="channel-empty-cta"
          className="qf-btn qf-btn--primary"
          onClick={focusComposer}
        >
          첫 메시지 작성하기
        </button>
      </div>
    );
  }

  const isAnnouncement = channel.type === 'ANNOUNCEMENT';
  return (
    <div className="qf-empty" data-testid="channel-empty">
      <h2 className="qf-empty__title m-0" data-testid="channel-empty-title">
        #{channel.name} 채널에 오신 것을 환영합니다
      </h2>
      <div className="qf-empty__body">
        {isAnnouncement
          ? '공지 채널입니다. 중요한 소식을 이곳에 게시해 멤버에게 전달하세요.'
          : `#${channel.name} 채널의 시작이에요. 아래에서 첫 메시지를 보내 대화를 시작하세요.`}
        {channel.topic ? (
          <p
            className="mb-0 mt-[var(--s-3)] text-[length:var(--fs-13)]"
            data-testid="channel-empty-topic"
          >
            {channel.topic}
          </p>
        ) : null}
        <p className="mb-0 mt-[var(--s-2)] text-[length:var(--fs-11)] text-text-muted">
          <time dateTime={localDayKey(channel.createdAt)}>
            {formatDayDivider(channel.createdAt)}
          </time>
          에 생성됨
        </p>
      </div>
      <button
        type="button"
        data-testid="channel-empty-cta"
        className="qf-btn qf-btn--primary"
        onClick={focusComposer}
      >
        첫 메시지 작성하기
      </button>
      {creatorCta}
    </div>
  );
}

/**
 * S23 (FR-RS-06) — NEW MESSAGES 구분선. DS 4 파일의 데스크톱 클래스에는
 * unread-divider 전용 클래스가 없고(모바일 `.qf-m-unread-divider` 만 존재),
 * 신규 DS 클래스 추가는 금지이므로 모바일과 동일한 DS 토큰
 * (--unread-divider-accent / --badge-unread-bg / --text-onAccent / --fs-11)만
 * Tailwind arbitrary 로 page-scoped 사용한다(raw hex/px 금지). 양옆 accent 1px
 * 선 + 좌측 라벨 + 우측 작은 pill — 모바일 unread-divider 와 시각 정합.
 */
function NewMessagesDivider(): JSX.Element {
  return (
    <div
      role="separator"
      // S23 a11y M-1 fix: 가시 텍스트와 aria-label 불일치 제거. 종전 가시 텍스트
      // "새 메시지" ≠ aria-label "여기부터 새 메시지입니다" 라 SR 이 짧은 DOM
      // 텍스트만 읽었다. 가시 텍스트를 "여기부터 새 메시지" 로 풀어 라벨과 정합.
      aria-label="여기부터 새 메시지"
      data-testid="new-messages-divider"
      className="flex items-center gap-[var(--s-3)] px-[var(--s-7)] py-[var(--s-2)] text-[color:var(--unread-divider-accent)]"
    >
      <span aria-hidden="true" className="h-px flex-1 bg-[var(--unread-divider-accent)]" />
      <span className="text-[length:var(--fs-11)] font-semibold uppercase tracking-[var(--tracking-caps)]">
        여기부터 새 메시지
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-[var(--unread-divider-accent)]" />
    </div>
  );
}

/**
 * S06 (FR-MSG-11) — 채널 날짜 구분선. DS 4 파일에는 채널용 day-divider 전용
 * 클래스가 없고(`.qf-thread-divider` 는 thread 패널 전용) 이므로, DS 토큰
 * (--divider / --fs-11 / --s-4)을 Tailwind arbitrary 로만 사용해 구성합니다
 * (raw hex/px 금지). 가운데 라벨('YYYY년 MM월 DD일') + 양옆 1px 선.
 */
function DayDivider({ iso }: { iso: string }): JSX.Element {
  return (
    <div
      role="separator"
      // a11y(S06 review): separator 가 텍스트 자식을 건너뛰어도 날짜 전환을
      // 읽도록 컨테이너에 aria-label, 라벨은 기계 판독 가능한 <time> 으로.
      aria-label={formatDayDivider(iso)}
      data-testid={`day-divider-${localDayKey(iso)}`}
      className="flex items-center gap-[var(--s-3)] px-[var(--s-7)] py-[var(--s-4)]"
    >
      <span aria-hidden="true" className="h-px flex-1 bg-[var(--divider)]" />
      <time
        dateTime={localDayKey(iso)}
        className="text-[length:var(--fs-11)] font-medium text-text-muted"
      >
        {formatDayDivider(iso)}
      </time>
      <span aria-hidden="true" className="h-px flex-1 bg-[var(--divider)]" />
    </div>
  );
}
