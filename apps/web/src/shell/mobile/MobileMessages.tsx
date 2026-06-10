import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type TouchEvent,
} from 'react';
import { isSystemMessageType, type MessageDto, type WorkspaceRole } from '@qufox/shared-types';
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
import { useQueryClient } from '@tanstack/react-query';
import { qk } from '../../lib/query-keys';
import {
  useMarkChannelRead,
  useUnreadSummary,
  zeroOutChannelUnread,
  type UnreadChannelSummary,
} from '../../features/channels/useUnread';
// 071-M1 D6: 첫 미읽 위치(count 역산)·점프 pill 판정 — 데스크톱 순수 함수 공유.
import { computeFirstUnreadIndex } from '../../features/messages/newMessages';
import { useSearchParams } from 'react-router-dom';
import { useNotifications } from '../../stores/notification-store';
import { useCompose } from '../../stores/compose-store';
import { renderMessageContent } from '../../features/messages/parseContent';
// 071-M1 D1: 데스크톱과 동일한 렌더 코어를 공유한다 — 그루핑 규칙·날짜 구분선·
// ReDoS-안전 AST 렌더러(멘션 pill/스포일러/헤딩)·점보 이모지·시스템 행·스레드 chip.
import { isContinuation } from '../../features/messages/grouping';
import { isSameLocalDay } from '../../features/messages/formatMessageTime';
import { DayDivider } from '../../features/messages/DayDivider';
import { SystemMessage } from '../../features/messages/SystemMessage';
import { renderAst, type MentionLookup } from '../../features/messages/renderAst';
import { isJumboEmoji } from '../../features/messages/jumboEmoji';
import { threadChipVisible } from '../../features/messages/threadActionGate';
import { useCustomEmojis } from '../../features/emojis/useCustomEmojis';
import type { CustomEmoji } from '../../features/emojis/api';
// 071-M1 D2: 리액션 칩 행 — 데스크톱 ReactionBar 재사용(칩 토글 + 피커).
import { ReactionBar } from '../../features/reactions/ReactionBar';
// 071-M1 D7(FR-P07/RT-08·09): 타이핑 — 표시는 공유 TypingIndicator, 발행은 TypingEmitter
// (스로틀/idle-stop 내장). emit 시점마다 소켓 재조회(재연결 안전 — 데스크톱과 동일).
import { TypingIndicator } from '../../features/typing/TypingIndicator';
import { TypingEmitter } from '../../features/typing/typingEmitter';
import { getSocket } from '../../lib/socket';
import { WS_EVENTS } from '@qufox/shared-types';
import { Avatar, Icon } from '../../design-system/primitives';
import { MobileMessageSheet } from './MobileMessageSheet';
import { MobileEditSheet } from './MobileEditSheet';
import { ThreadPanel } from '../../features/threads/ThreadPanel';
import { cn } from '../../lib/cn';

/**
 * Mobile chat screen — scrolling qf-m-msg list + qf-m-composer
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
  extraNames,
}: {
  /** null for Global DM channels — routes through /me/dms/:ch/messages. */
  workspaceId: string | null;
  workspaceSlug: string | null;
  channelId: string;
  channelName: string;
  /**
   * DM callers pass {userId→username} so authors who don't share a
   * workspace with the viewer still render with their real name.
   */
  extraNames?: Map<string, string>;
}): JSX.Element {
  const { user } = useAuth();
  const { data: members } = useMembers(workspaceId ?? undefined);
  const history = useMessageHistory(workspaceId, channelId);
  const delMut = useDeleteMessage(workspaceId, channelId);
  const updMut = useUpdateMessage(workspaceId, channelId);
  const reactMut = useToggleReaction(workspaceId, channelId);
  // 071-M1 D5(FR-MSG-04/05): retry 는 동일 clientNonce 로 실패 낙관 행을 재전송한다.
  const { send, retry } = useSendMessage(workspaceId, channelId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<HTMLInputElement>(null);
  const [sheetMsg, setSheetMsg] = useState<MessageDto | null>(null);
  // S103 (FR-MSG-06 모바일): 편집 중인 메시지(시트에서 '메시지 편집' 선택 시 세팅).
  // 비-null 이면 MobileEditSheet 오버레이를 띄운다.
  const [editingMsg, setEditingMsg] = useState<MessageDto | null>(null);
  // S35 (FR-TH-05): 모바일 전체화면 스레드 패널 상태. 시트의 '스레드에서 답글'
  // 액션이 루트 messageId 를 세팅한다. 워크스페이스 채널에서만 연다(DM 스레드는
  // 데스크톱과 동일하게 비범위 — workspaceId 가 null 인 DM 은 열지 않는다).
  const [threadRootId, setThreadRootId] = useState<string | null>(null);
  // S35 fix-forward (a11y BLOCKER): 모바일 스레드 dialog 를 닫을 때 포커스를
  // 패널을 연 트리거로 되돌리기 위해, 패널 오픈 직전의 활성 요소를 보관한다.
  // dialog 닫힘 시 이 요소로 focus 를 복귀시켜 키보드/스크린리더 컨텍스트가
  // 배경으로 튀지 않게 한다(WAI-ARIA dialog 패턴).
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const setReplyTarget = useCompose((s) => s.setReplyTarget);

  // suppress unused warnings (workspaceSlug 은 시그니처 호환용 미사용 prop).
  void workspaceSlug;

  const messages = useMemo<MessageDto[]>(() => {
    const pages = history.data?.pages ?? [];
    return [...pages.flatMap((p) => p.items)].reverse();
  }, [history.data]);

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const x of members?.members ?? []) m.set(x.userId, x.user.username);
    if (extraNames) for (const [k, v] of extraNames) if (!m.has(k)) m.set(k, v);
    return m;
  }, [members, extraNames]);

  // 071-M1 D1: AST 멘션 pill 의 표시명 resolver(데스크톱 mentionLookup 과 동일 소스).
  const mentionLookup = useMemo<MentionLookup>(
    () => ({ userName: (userId: string) => nameById.get(userId) }),
    [nameById],
  );
  // 커스텀 이모지 byName(+별칭) — CustomEmojiProvider 가 모바일 트리에 없으므로
  // 프로바이더와 동일 로직으로 직접 구성(DM=workspace 없음 → 빈 맵, 리터럴 유지).
  const { data: customEmojiData } = useCustomEmojis(workspaceId ?? null);
  const customEmojiByName = useMemo(() => {
    const byName = new Map<string, CustomEmoji>();
    for (const ce of customEmojiData?.items ?? []) {
      byName.set(ce.name, ce);
      for (const alias of ce.aliases ?? []) if (!byName.has(alias)) byName.set(alias, ce);
    }
    return byName;
  }, [customEmojiData?.items]);

  const roleById = useMemo(() => {
    const m = new Map<string, WorkspaceRole>();
    for (const x of members?.members ?? []) m.set(x.userId, x.role);
    return m;
  }, [members]);
  void roleById;

  useScrollFetch(scrollRef, () => {
    if (history.hasNextPage && !history.isFetchingNextPage) void history.fetchNextPage();
  });

  // 071-M1 D6(FR-RS-06): 첫 미읽 구분선 입력 스냅샷. 아래 zero-out 효과가 캐시를
  // 0 으로 누르기 *전에* 채널 진입 시점의 unreadCount 를 고정한다(효과 선언 순서로
  // 보장 — 이 효과가 먼저 실행됨). summary 에 lastReadMessageId 가 없으므로
  // computeFirstUnreadIndex 의 count 역산 폴백을 쓴다.
  const { data: unreadSummary } = useUnreadSummary(workspaceId ?? undefined);
  const unreadSnapRef = useRef<{ channelId: string; unreadCount: number } | null>(null);
  if (unreadSnapRef.current && unreadSnapRef.current.channelId !== channelId) {
    unreadSnapRef.current = null; // 채널 전환 — 새 채널에서 재스냅.
  }
  if (unreadSnapRef.current === null && unreadSummary) {
    const row = unreadSummary.channels.find((c) => c.channelId === channelId);
    unreadSnapRef.current = { channelId, unreadCount: row?.unreadCount ?? 0 };
  }
  const firstUnreadIndex = useMemo(() => {
    const snap = unreadSnapRef.current;
    if (!snap || snap.channelId !== channelId) return null;
    return computeFirstUnreadIndex({
      messageIds: messages.map((m) => m.id),
      lastReadMessageId: null,
      unreadCount: snap.unreadCount,
    });
    // unreadSnapRef 는 ref 지만 messages 변경 시 재계산되면 충분(스냅은 불변).
  }, [messages, channelId]);

  // A-4(071-M0 C10): 모바일은 읽음 ACK 를 전혀 보내지 않아 모바일로 읽어도 미읽음/멘션
  // 배지가 영구 잔존했다 — 데스크톱 MessageColumn 의 채널-open 패턴(낙관적 zero-out +
  // POST read-ack)을 동일 적용한다. DM(workspaceId=null)은 데스크톱과 같은 이유로 스킵,
  // 커서 기반 정밀 ACK(FR-RS-02 AckScheduler)는 M1 범위.
  const qc = useQueryClient();
  const markRead = useMarkChannelRead(workspaceId ?? undefined);
  useEffect(() => {
    if (workspaceId === null) return;
    qc.setQueryData<{ channels: UnreadChannelSummary[] }>(
      qk.channels.unreadSummary(workspaceId),
      (old) => zeroOutChannelUnread(old, channelId),
    );
    markRead.mutate(channelId);
    // markRead 는 useMutation 의 안정 참조 — 채널 변경 시에만 재발화한다.
  }, [channelId, workspaceId, qc]);

  // Auto-scroll to bottom on mount + new incoming. task-025 follow-4:
  // history prepend grows messages.length while isFetchingNextPage is
  // true and wasAtBottomRef stays true, so without a gate the old code
  // snapped the view to the bottom mid-fetch and threw the user off
  // the history they had just requested.
  const wasAtBottomRef = useRef(true);
  const hasAnchoredRef = useRef(false);
  const prevScrollHeightRef = useRef(0);
  // 071-M1 D6(FR-RS-07 모바일 단순화): 하단 이탈 중 도착한 새 메시지 수 — jump 버튼 배지.
  const prevLastIdRef = useRef<string | null>(null);
  const prevLenRef = useRef(0);
  const [newWhileAway, setNewWhileAway] = useState(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || messages.length === 0) return;
    const lastId = messages[messages.length - 1]?.id ?? null;
    if (!hasAnchoredRef.current) {
      el.scrollTop = el.scrollHeight;
      hasAnchoredRef.current = true;
      prevScrollHeightRef.current = el.scrollHeight;
      prevLastIdRef.current = lastId;
      prevLenRef.current = messages.length;
      return;
    }
    if (history.isFetchingNextPage) {
      // Mid-prepend: preserve the user's anchor by shifting scrollTop
      // by however much the list grew upward.
      const delta = el.scrollHeight - prevScrollHeightRef.current;
      if (delta > 0) el.scrollTop = el.scrollTop + delta;
      prevScrollHeightRef.current = el.scrollHeight;
      prevLastIdRef.current = lastId;
      prevLenRef.current = messages.length;
      return;
    }
    // append(마지막 id 변경) 인데 하단 이탈 상태 → jump 배지 카운트 누적.
    if (lastId !== prevLastIdRef.current && !wasAtBottomRef.current) {
      const appended = Math.max(1, messages.length - prevLenRef.current);
      setNewWhileAway((n) => n + appended);
    }
    if (wasAtBottomRef.current) el.scrollTop = el.scrollHeight;
    prevScrollHeightRef.current = el.scrollHeight;
    prevLastIdRef.current = lastId;
    prevLenRef.current = messages.length;
  }, [messages.length, history.isFetchingNextPage, messages]);

  // 071-M1 D6: `?msg=` 점프 — 리스트에 있으면 스크롤+2초 강조 후 파라미터 제거,
  // 히스토리를 다 불러왔는데도 없으면 토스트 1회(around 로드는 M1 범위 외 — 071 문서).
  const [sp, setSp] = useSearchParams();
  const pushToast = useNotifications((s) => s.push);
  const rawJump = sp.get('msg');
  const jumpId =
    rawJump && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawJump)
      ? rawJump
      : null;
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const jumpHandledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!jumpId || jumpHandledRef.current === jumpId) return;
    const clearParam = (): void =>
      setSp(
        (prevParams) => {
          const next = new URLSearchParams(prevParams);
          next.delete('msg');
          next.delete('thread');
          return next;
        },
        { replace: true },
      );
    if (messages.some((m) => m.id === jumpId)) {
      jumpHandledRef.current = jumpId;
      const el = document.querySelector(`[data-testid="mobile-msg-${jumpId}"]`);
      el?.scrollIntoView({ block: 'center' });
      wasAtBottomRef.current = false;
      setHighlightId(jumpId);
      window.setTimeout(() => setHighlightId(null), 2000);
      clearParam();
      return;
    }
    if (!history.hasNextPage && !history.isFetchingNextPage && messages.length > 0) {
      jumpHandledRef.current = jumpId;
      pushToast({ variant: 'warning', title: '메시지를 찾을 수 없습니다', ttlMs: 4000 });
      clearParam();
    }
  }, [jumpId, messages, history.hasNextPage, history.isFetchingNextPage, setSp, pushToast]);

  return (
    <>
      <div
        ref={scrollRef}
        data-testid="mobile-message-list"
        className="flex-1 overflow-y-auto px-[var(--s-3)] py-[var(--s-3)] min-h-0"
        onScroll={(e) => {
          const el = e.currentTarget;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          wasAtBottomRef.current = near;
          // D6: 하단 복귀 시 jump 배지 해제.
          if (near) setNewWhileAway(0);
        }}
      >
        {/* 071-M1 D1: 날짜 구분선 + 그루핑(--head/--cont) + 시스템 행 + 스레드 chip —
            데스크톱과 동일 순수 모듈(isContinuation/isSameLocalDay/SystemMessage)을 공유. */}
        {messages.map((m, i) => {
          const prev = i > 0 ? messages[i - 1] : null;
          const dayDivider =
            !prev || !isSameLocalDay(m.createdAt, prev.createdAt) ? (
              <DayDivider iso={m.createdAt} />
            ) : null;
          {/* D6(FR-RS-06): 첫 미읽 메시지 위에 NEW MESSAGES 경계(DS qf-m-unread-divider). */}
          const unreadDivider =
            firstUnreadIndex === i ? (
              <div className="qf-m-unread-divider" data-testid="mobile-unread-divider">
                <span className="qf-m-unread-divider__label">새 메시지</span>
                <span className="qf-m-unread-divider__pill">
                  {unreadSnapRef.current?.unreadCount ?? ''}
                </span>
              </div>
            ) : null;
          if (isSystemMessageType(m.type)) {
            return (
              <div key={m.id}>
                {dayDivider}
                {unreadDivider}
                <SystemMessage
                  msg={m}
                  onOpenThread={
                    workspaceId ? (rootId) => setThreadRootId(rootId) : undefined
                  }
                />
              </div>
            );
          }
          const chipVisible =
            workspaceId !== null && threadChipVisible(m, m.thread, true) && !m.id.startsWith('tmp-');
          return (
            <div key={m.id}>
              {dayDivider}
              {unreadDivider}
              <MobileMessageRow
                msg={m}
                cont={isContinuation(m, prev)}
                isMine={m.authorId === user?.id}
                highlighted={highlightId === m.id}
                mentionsMe={astMentionsViewer(m.contentAst, user?.id)}
                authorName={nameById.get(m.authorId)}
                customEmojiByName={customEmojiByName}
                mentions={mentionLookup}
                onLongPress={() => setSheetMsg(m)}
                onSwipeReply={() => {
                  setReplyTarget(channelId, {
                    messageId: m.id,
                    authorName: nameById.get(m.authorId) ?? 'unknown',
                  });
                  composerInputRef.current?.focus();
                }}
                onToggleReaction={
                  m.id.startsWith('tmp-')
                    ? undefined
                    : (emoji, byMe) =>
                        reactMut.toggle({ messageId: m.id, emoji, currentlyByMe: byMe })
                }
                customEmojiList={customEmojiData?.items ?? []}
                onRetry={() => retry(m.id, m.content ?? '')}
              />
              {chipVisible && m.thread ? (
                <button
                  type="button"
                  data-testid={`mobile-thread-chip-${m.id}`}
                  className="qf-thread-chip ml-[calc(var(--m-gutter)+40px+12px)]"
                  aria-label={`${m.thread.replyCount}개 답글 보기`}
                  onClick={() => {
                    previousFocusRef.current = document.activeElement as HTMLElement | null;
                    setThreadRootId(m.id);
                  }}
                >
                  <span className="qf-thread-chip__count">{m.thread.replyCount}개 답글</span>
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {/* D6(FR-RS-07 모바일): 하단 이탈 중 새 메시지 도착 — DS qf-m-jump-btn(+배지). */}
      {newWhileAway > 0 ? (
        <button
          type="button"
          data-testid="mobile-jump-btn"
          className="qf-m-jump-btn"
          aria-label={`새 메시지 ${newWhileAway}개 — 최신으로 이동`}
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
            wasAtBottomRef.current = true;
            setNewWhileAway(0);
          }}
        >
          <Icon name="chevron-down" size="sm" />
          <span className="qf-m-jump-btn__badge">
            {newWhileAway > 99 ? '99+' : newWhileAway}
          </span>
        </button>
      ) : null}
      {/* D7: 타이핑 인디케이터 — 리스트와 컴포저 사이(데스크톱과 동일 위치). */}
      <TypingIndicator channelId={channelId} viewerId={user?.id ?? null} nameByUserId={nameById} />
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
          onReply={() => {
            setReplyTarget(channelId, {
              messageId: sheetMsg.id,
              authorName: nameById.get(sheetMsg.authorId) ?? 'unknown',
            });
            setSheetMsg(null);
            composerInputRef.current?.focus();
          }}
          onReact={(emoji) => {
            if (!sheetMsg.id.startsWith('tmp-')) {
              reactMut.toggle({
                messageId: sheetMsg.id,
                emoji,
                currentlyByMe: sheetMsg.reactions?.find((r) => r.emoji === emoji)?.byMe ?? false,
              });
            }
            setSheetMsg(null);
          }}
          // S103 (FR-MSG-06 모바일): 내 메시지만 편집. 낙관적(tmp-) 행은 서버 id·
          // version 이 없어 PATCH 불가, 삭제된 행은 본문이 없으므로 숨긴다(데스크톱
          // editRequestNonce 게이트와 동일 정책). 편집 시트로 전환한다.
          onEdit={
            sheetMsg.authorId === user?.id &&
            !sheetMsg.id.startsWith('tmp-') &&
            !sheetMsg.deleted
              ? () => {
                  setEditingMsg(sheetMsg);
                  setSheetMsg(null);
                }
              : undefined
          }
          // S35 (FR-TH-05): 워크스페이스 채널에서만 스레드 진입(DM 비범위).
          // 답글(parentMessageId 보유)을 탭하면 그 루트의 스레드를 연다.
          // 낙관적(tmp-) 행은 서버 id 가 없어 스레드를 열 수 없으므로 숨긴다.
          onOpenThread={
            workspaceId && !sheetMsg.id.startsWith('tmp-')
              ? () => {
                  // dialog 오픈 직전 포커스를 보관(닫힐 때 복귀 대상). 시트는
                  // 곧 닫히므로, 시트를 띄운 원본 메시지 행으로 폴백한다.
                  previousFocusRef.current =
                    (document.activeElement as HTMLElement | null) ??
                    document.querySelector<HTMLElement>(
                      `[data-testid="mobile-msg-${sheetMsg.id}"]`,
                    );
                  setThreadRootId(sheetMsg.parentMessageId ?? sheetMsg.id);
                  setSheetMsg(null);
                }
              : undefined
          }
        />
      ) : null}
      {/* S103 (FR-MSG-06 모바일): 메시지 편집 바텀시트. 저장 시 낙관적 잠금
          PATCH(updMut) — 성공하면 editingMsg 를 풀어 닫고, 충돌/검증 실패는 훅이
          토스트로 안내하며 시트를 유지한다(MobileEditSheet 내부에서 reject 흡수). */}
      {editingMsg ? (
        <MobileEditSheet
          msg={editingMsg}
          onCancel={() => setEditingMsg(null)}
          onSave={async (content) => {
            // S103 리뷰 HIGH-1: 편집 시트가 열린 사이 다른 클라가 같은 메시지를
            // 수정하면 낙관잠금 409 → 훅(applyEditConflict)이 캐시를 최신 version 으로
            // 갱신한다. expectedVersion 을 editingMsg(시트 오픈 스냅샷) 대신 *현재
            // 캐시*(messages memo)의 최신 version 으로 재도출해야, 충돌 후 재시도가
            // 새 version 으로 성공한다(stale version 무한 409 데드엔드 방지 — 데스크톱
            // MessageList onEditSave 가 매 렌더 m.version 을 재읽는 것과 동일 효과).
            // 캐시 밖(페이지네이션) 이면 스냅샷 version 으로 폴백.
            const live = messages.find((m) => m.id === editingMsg.id);
            await updMut.mutateAsync({
              msgId: editingMsg.id,
              content,
              expectedVersion: live?.version ?? editingMsg.version,
            });
            setEditingMsg(null);
          }}
        />
      ) : null}
      {/* S35 (FR-TH-05): 모바일 전체화면 스레드 패널. ThreadPanel 의 모든 로직을
          재사용하고 mobile 플래그로 app-layer 전체화면 레이아웃을 입힌다(DS 무수정).
          워크스페이스 채널에서만 연다(workspaceId 보장). */}
      {threadRootId && workspaceId ? (
        <ThreadPanel
          mobile
          workspaceId={workspaceId}
          channelId={channelId}
          channelName={channelName}
          rootId={threadRootId}
          onClose={() => {
            setThreadRootId(null);
            // dialog 닫힘 → 트리거(또는 원본 메시지 행)로 포커스 복귀.
            const prev = previousFocusRef.current;
            previousFocusRef.current = null;
            // 행이 여전히 포커스 가능하도록 다음 프레임에 복귀(언마운트 후).
            requestAnimationFrame(() => prev?.focus?.());
          }}
        />
      ) : null}
    </>
  );
}

/**
 * 071-M1 D1: 뷰어 멘션 판정 — contentAst 를 1회 순회해 mention_user(내 id)가
 * 있으면 true. AST 스키마에 의존하지 않는 관대한 워커(노드 모양 변화에 안전).
 */
function astMentionsViewer(ast: unknown, meId: string | undefined): boolean {
  if (!ast || !meId) return false;
  const stack: unknown[] = [ast];
  let guard = 0;
  while (stack.length > 0 && guard < 5_000) {
    guard += 1;
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const child of node) stack.push(child);
      continue;
    }
    if (typeof node !== 'object' || node === null) continue;
    const rec = node as Record<string, unknown>;
    if (rec.type === 'mention_user' && rec.userId === meId) return true;
    for (const v of Object.values(rec)) {
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return false;
}

function MobileMessageRow({
  msg,
  cont,
  isMine,
  highlighted,
  mentionsMe,
  authorName,
  customEmojiByName,
  mentions,
  onLongPress,
  onSwipeReply,
  onToggleReaction,
  customEmojiList,
  onRetry,
}: {
  msg: MessageDto;
  /** 그루핑 continuation — 아바타/메타 숨김(qf-m-msg--cont). */
  cont: boolean;
  isMine: boolean;
  /** `?msg=` 점프 직후 2초 강조. */
  highlighted: boolean;
  /** 본문에 내 멘션 포함 — 행 배경 강조(--mention-bg). */
  mentionsMe: boolean;
  authorName?: string;
  customEmojiByName: Map<string, CustomEmoji>;
  mentions: MentionLookup;
  onLongPress: () => void;
  onSwipeReply: () => void;
  /** undefined = 낙관적(tmp-) 행 — 칩 토글 비활성. */
  onToggleReaction?: (emoji: string, currentlyByMe: boolean) => void;
  customEmojiList: CustomEmoji[];
  /** 전송 실패(sendState='failed') 행의 동일 clientNonce 재시도. */
  onRetry: () => void;
}): JSX.Element {
  const pressTimer = useRef<number | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const [swipeOffset, setSwipeOffset] = useState(0);
  // 071-M0 C12: 커밋 판정을 state 클로저로 읽으면 같은 태스크에서 연속 발화하는 터치
  // 시퀀스(합성 이벤트·고주사율 기기)에서 touchend 가 항상 초기값 0 을 봐 스와이프가
  // 절대 커밋되지 않는다 — 판정은 ref, state 는 시각 transform 전용으로 분리한다.
  const swipeOffsetRef = useRef(0);

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
    if (dx > 0 && Math.abs(dy) < 30) {
      const v = Math.min(dx, 120);
      swipeOffsetRef.current = v;
      setSwipeOffset(v);
    }
  };
  const onTouchEnd = (): void => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
    if (swipeOffsetRef.current >= SWIPE_THRESHOLD_PX) {
      // task-025 follow-2: swipe-right bypasses the sheet and enters
      // reply-mode directly (sets replyTarget + focuses composer).
      onSwipeReply();
    }
    swipeOffsetRef.current = 0;
    setSwipeOffset(0);
    touchStart.current = null;
  };

  if (msg.deleted) {
    // S05 verify: DS 미등록 `qf-m-message` 그리드 클래스(40px 1fr)를 tombstone
    // 에 붙이면 텍스트가 40px 첫 컬럼에 끼인다. 데스크톱 tombstone(MessageItem)
    // 처럼 DS 토큰 기반 패딩만 쓰고 그리드는 피한다.
    return (
      <div
        data-testid={`mobile-msg-deleted-${msg.id}`}
        role="note"
        aria-label="삭제된 메시지"
        className="px-[var(--m-gutter)] py-[var(--s-2)] text-[length:var(--fs-15)] italic text-text-muted"
      >
        (삭제된 메시지)
      </div>
    );
  }

  // 071-M1 D1: BOT 메시지(FR-RC11)는 botUsername override + 'BOT' 뱃지. 점보 이모지
  // (FR-RC15)는 fs-32 확대. 본문은 데스크톱과 동일하게 contentAst→renderAst(멘션 pill/
  // 스포일러/헤딩/커스텀 이모지), legacy(content)→renderMessageContent 폴백.
  const isBot = msg.authorType === 'BOT';
  const effectiveAuthorName = isBot ? (msg.botUsername ?? authorName) : authorName;
  const jumbo = isJumboEmoji(msg.contentAst);
  // 071-M1 D5(FR-MSG-04/05): 낙관 행 전송 상태 — pending=흐림, failed=경고+재시도.
  const sendState = (msg as MessageDto & { sendState?: 'pending' | 'failed' }).sendState;

  return (
    <article
      data-testid={`mobile-msg-${msg.id}`}
      data-mine={isMine ? 'true' : 'false'}
      // S05 verify: DS 정본은 `qf-m-msg`(+__avatar/__meta/__author/__time/__body).
      // 071-M1 D1: 그루핑 변형(--head/--cont — DS 가 cont 의 아바타/메타를 숨김) +
      // 내 멘션 행 배경 강조(--mention-bg 토큰, PRD D01 모바일 멘션 행).
      data-send-state={sendState}
      data-jump-highlight={highlighted ? 'true' : undefined}
      className={cn(
        'qf-m-msg',
        cont ? 'qf-m-msg--cont' : 'qf-m-msg--head',
        (mentionsMe || highlighted) && 'bg-[var(--mention-bg)]',
        sendState === 'pending' && 'opacity-60',
      )}
      style={{
        transform: `translateX(${swipeOffset}px)`,
        // S35 fix-forward (DS 토큰화): raw 120ms → DS duration 토큰(--dur-fast=140ms).
        transition: swipeOffset === 0 ? 'transform var(--dur-fast)' : undefined,
      }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <Avatar
        name={effectiveAuthorName ?? msg.authorId.slice(0, 2)}
        size="sm"
        className="qf-m-msg__avatar"
      />
      <div className="qf-m-msg__meta">
        <span className="qf-m-msg__author">{effectiveAuthorName ?? 'unknown'}</span>
        {isBot ? (
          <span data-testid={`mobile-msg-bot-${msg.id}`} className="qf-badge qf-badge--accent">
            BOT
          </span>
        ) : null}
        <time className="qf-m-msg__time">
          {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </time>
        {msg.edited ? (
          // S05 (FR-MSG-07) 모바일 parity: (수정됨) 뱃지. 데스크톱 MessageItem
          // 과 동일하게 시각 토큰(qf-m-msg__time)을 재사용하고 editedAt 을 title 로.
          <span
            data-testid={`mobile-msg-edited-${msg.id}`}
            className="qf-m-msg__time"
            title={msg.editedAt ? new Date(msg.editedAt).toLocaleString() : undefined}
          >
            (수정됨)
          </span>
        ) : null}
      </div>
      <div
        className={cn(
          'qf-m-msg__body',
          jumbo && 'text-[length:var(--fs-32)] leading-[var(--lh-tight)]',
        )}
        data-jumbo={jumbo ? 'true' : undefined}
      >
        {msg.contentAst
          ? renderAst(msg.contentAst, customEmojiByName, mentions)
          : renderMessageContent(msg.content ?? '', customEmojiByName)}
        {sendState === 'failed' ? (
          <div
            data-testid={`mobile-msg-send-failed-${msg.id}`}
            className="mt-1 flex items-center gap-[var(--s-2)] text-[length:var(--fs-12)]"
          >
            <span role="alert" className="text-[color:var(--danger-400)]">
              전송 실패
            </span>
            <button
              type="button"
              data-testid={`mobile-msg-retry-${msg.id}`}
              onClick={onRetry}
              className="qf-btn qf-btn--ghost qf-btn--sm"
            >
              다시 시도
            </button>
          </div>
        ) : null}
      </div>
      {/* 071-M1 D2(FR-RE01/02/03): 리액션 칩 행 — 데스크톱 ReactionBar 재사용.
          모바일 44px 터치 플로어는 mobile-touch-target.css 가 .qf-reaction 에 보장. */}
      {onToggleReaction && (msg.reactions?.length ?? 0) > 0 ? (
        <div className="col-start-2">
          <ReactionBar
            reactions={msg.reactions ?? []}
            onToggle={onToggleReaction}
            customEmojis={customEmojiList.map((ce) => ({ id: ce.id, name: ce.name, url: ce.url }))}
          />
        </div>
      ) : null}
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

  // D7(FR-RT-08): 입력 → typing:start(스로틀)/idle-stop. 채널 전환·언마운트 시 stop.
  // emit 시점에 소켓을 재조회하므로 재연결에도 안전(데스크톱 makeTypingEmitter 동일).
  const typingRef = useRef<TypingEmitter | null>(null);
  useEffect(() => {
    const emitter = new TypingEmitter({
      emitStart: () => {
        const socket = getSocket();
        if (socket?.connected) socket.emit(WS_EVENTS.TYPING_START, { channelId });
      },
      emitStop: () => {
        const socket = getSocket();
        if (socket?.connected) socket.emit(WS_EVENTS.TYPING_STOP, { channelId });
      },
    });
    typingRef.current = emitter;
    return () => {
      emitter.stop();
      typingRef.current = null;
    };
  }, [channelId]);

  const submit = (): void => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    send(trimmed);
    clearDraft(channelId);
    setReplyTarget(channelId, null);
    typingRef.current?.stop();
  };

  return (
    <div className="qf-m-safe-bottom">
      {replyTarget ? (
        <div
          data-testid="mobile-reply-banner"
          data-reply-to={replyTarget.messageId}
          className="flex items-center gap-[var(--s-2)] px-[var(--s-4)] py-[var(--s-2)] bg-bg-subtle border-t border-border-subtle text-[length:var(--fs-13)] text-text-muted"
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
          aria-label="메시지 입력"
          className="qf-m-composer__input"
          value={draft}
          onChange={(e) => {
            setDraft(channelId, e.target.value);
            // D7: 비움은 즉시 stop, 입력은 스로틀된 start.
            if (e.target.value.trim() === '') typingRef.current?.stop();
            else typingRef.current?.onInput();
          }}
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
