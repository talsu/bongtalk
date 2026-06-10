import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type TouchEvent,
} from 'react';
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
import { useQueryClient } from '@tanstack/react-query';
import { qk } from '../../lib/query-keys';
import {
  useMarkChannelRead,
  zeroOutChannelUnread,
  type UnreadChannelSummary,
} from '../../features/channels/useUnread';
import { useCompose } from '../../stores/compose-store';
import { renderMessageContent } from '../../features/messages/parseContent';
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
  const { send } = useSendMessage(workspaceId, channelId);
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

  const roleById = useMemo(() => {
    const m = new Map<string, WorkspaceRole>();
    for (const x of members?.members ?? []) m.set(x.userId, x.role);
    return m;
  }, [members]);
  void roleById;

  useScrollFetch(scrollRef, () => {
    if (history.hasNextPage && !history.isFetchingNextPage) void history.fetchNextPage();
  });

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

  return (
    <article
      data-testid={`mobile-msg-${msg.id}`}
      data-mine={isMine ? 'true' : 'false'}
      // S05 verify: DS 정본은 `qf-m-msg`(+__avatar/__meta/__author/__time/__body).
      // 기존 `qf-m-message*` 는 DS 미등록이라 스타일이 안 먹었다. `__bubble` 래퍼는
      // DS 에 없고 grid(40px 1fr)를 깨므로 제거 — avatar/meta/body 를 직접 자식으로.
      className={cn('qf-m-msg')}
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
        name={authorName ?? msg.authorId.slice(0, 2)}
        size="sm"
        className="qf-m-msg__avatar"
      />
      <div className="qf-m-msg__meta">
        <span className="qf-m-msg__author">{authorName ?? 'unknown'}</span>
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
      <div className="qf-m-msg__body">{renderMessageContent(msg.content ?? '')}</div>
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
