import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMembers } from '../features/workspaces/useWorkspaces';
import { useUI } from '../stores/ui-store';
import {
  useMarkChannelRead,
  useAckChannelRead,
  zeroOutChannelUnread,
} from '../features/channels/useUnread';
import { AckScheduler, type AckFlush } from '../features/messages/ackScheduler';
import { MessageList } from '../features/messages/MessageList';
import { MessageComposer } from '../features/messages/MessageComposer';
import { ThreadPanel } from '../features/threads/ThreadPanel';
import { useLiveMessages } from '../features/realtime/useLiveMessages';
import { useReadState } from '../features/realtime/readStateStore';
import { captureUnreadSnapshot } from '../features/messages/newMessages';
import { TypingIndicator } from '../features/typing/TypingIndicator';
import { useAuth } from '../features/auth/AuthProvider';
import { useNavigate } from 'react-router-dom';
import { Icon, Tooltip } from '../design-system/primitives';
import { SearchInput } from '../features/search/SearchInput';
import { useActivityUnread } from '../features/activity/useActivity';
import { useQueryClient } from '@tanstack/react-query';
import { qk } from '../lib/query-keys';
import type { UnreadChannelSummary } from '../features/channels/useUnread';

type Props = {
  /** null for Global DM channels — disables workspace-only chrome
      (search, unread mark, member list, thread panel). */
  workspaceId: string | null;
  workspaceSlug: string | null;
  channelId: string;
  channelName: string;
  channelTopic: string | null;
  /**
   * S13 (FR-CH-19): 채널 타입. ANNOUNCEMENT 면 게시 권한이 없는 사용자에게
   * composer 비활성화 + 헤더 배지를 표시한다. DM 은 'DIRECT'.
   */
  channelType: string;
  /**
   * DM callers pass a Map keyed by userId so MessageList can resolve
   * authors who are not members of `workspaceId` (e.g. the other
   * participant in a workspace-less DM). Merged on top of the workspace
   * members fallback inside MessageList.
   */
  extraNames?: Map<string, string>;
};

/**
 * The centre column. Header shows the channel name + a toggle for the
 * member list. Body is the virtualized message list. Footer is the
 * composer.
 */
export function MessageColumn({
  workspaceId,
  workspaceSlug,
  channelId,
  channelName,
  channelTopic,
  channelType,
  extraNames,
}: Props): JSX.Element {
  const memberListOpen = useUI((s) => s.memberListOpen);
  const toggleMemberList = useUI((s) => s.toggleMemberList);
  const setActiveChannelId = useUI((s) => s.setActiveChannelId);
  const { user } = useAuth();
  const isDm = workspaceId === null;
  const { data: members } = useMembers(workspaceId ?? undefined);
  const memberCount = members?.members.length ?? 0;
  // S13 (FR-CH-19): 호출자의 워크스페이스 역할 — 멤버 목록에서 본인 행으로
  // 해석. ANNOUNCEMENT 채널은 OWNER/ADMIN 만 게시 가능, 그 외 게시 제한.
  // 권한 비트 오버라이드(허용역할)는 서버가 최종 판정(403)하며, 여기서는
  // 기본 역할 기준의 UX 게이트만 둔다 — 서버가 단일 진실원.
  const myRole = useMemo(
    () => members?.members.find((mm) => mm.userId === user?.id)?.role ?? null,
    [members, user?.id],
  );
  const isAnnouncement = channelType === 'ANNOUNCEMENT';
  const canManage = myRole === 'OWNER' || myRole === 'ADMIN';
  const postingRestricted = !isDm && isAnnouncement && !canManage;
  const nameByUserId = useMemo(() => {
    const m = new Map<string, string>();
    // Workspace members win when present — their role/role-badge data
    // flows through the same map. DM callers pass `extraNames` so the
    // typing indicator can still label the other participant by name.
    for (const mm of members?.members ?? []) m.set(mm.userId, mm.user.username);
    if (extraNames) for (const [k, v] of extraNames) if (!m.has(k)) m.set(k, v);
    return m;
  }, [members, extraNames]);
  const qc = useQueryClient();

  // task-014-C: thread panel opens via `?thread=<rootId>` query param.
  // Sharing the URL restores the thread on mount; channel switching
  // unmounts this component and strips the param naturally.
  const threadRootId = useCallback((): string | null => {
    const params = new URLSearchParams(window.location.search);
    const v = params.get('thread');
    return v && /^[0-9a-f-]{36}$/i.test(v) ? v : null;
  }, []);
  const [activeThread, setActiveThread] = useThreadQueryState(threadRootId);

  // task-014 reviewer MED-1: if MessageColumn stays mounted across a
  // channel switch (happens on prop-level channel changes) the
  // `?thread=` param has to follow the channel or the panel tries to
  // render a thread from a different channel. Track the previous
  // channelId in a ref so the effect fires only on an actual switch,
  // not on every render.
  const prevChannelRef = useRef(channelId);
  useEffect(() => {
    if (prevChannelRef.current !== channelId) {
      prevChannelRef.current = channelId;
      setActiveThread(null);
    }
  }, [channelId, setActiveThread]);

  useLiveMessages(workspaceId ?? '', channelId);

  // Task-010 reviewer finding-1 fix: announce the active channel to the
  // UI store so the realtime dispatcher skips unread-bumps for messages
  // that arrive on this channel while we're viewing it. Clear on
  // unmount so a subsequent navigation doesn't leak stale state.
  useEffect(() => {
    setActiveChannelId(channelId);
    return () => {
      // Only clear if we're STILL the active channel — avoids a race
      // where MessageColumn unmount/remount (e.g. channelId change)
      // runs cleanup after the new mount has set the new id.
      if (useUI.getState().activeChannelId === channelId) {
        setActiveChannelId(null);
      }
    };
  }, [channelId, setActiveChannelId]);

  // S23 MAJOR fix (cold 캐시 구분선 소실): 채널 open 시 markRead +
  // zeroOutChannelUnread 가 unread-summary 캐시를 0 으로 누르기 *전에* 진입
  // 시점의 (unreadCount, lastReadMessageId) 를 캡처해 MessageList 에 prop 으로
  // 넘긴다. MessageList 가 cold summary(미캐시 / staleTime 만료)를 직접 읽으면
  // zero-out 에 오염돼 구분선이 사라지므로, 부모가 zero-out 직전에 고정한
  // 스냅샷을 단일 출처로 삼는다(FR-RS-06). channelId 단위로 1회 고정.
  const unreadSnapshotRef = useRef<{
    channelId: string;
    unreadCount: number;
    lastReadMessageId: string | null;
  } | null>(null);
  // 채널 전환 시(또는 첫 진입) 스냅샷을 zero-out 이전에 캡처.
  if (
    workspaceId !== null &&
    (unreadSnapshotRef.current === null || unreadSnapshotRef.current.channelId !== channelId)
  ) {
    const summary = qc.getQueryData<{ channels: UnreadChannelSummary[] }>(
      qk.channels.unreadSummary(workspaceId),
    );
    const row = summary?.channels.find((c) => c.channelId === channelId);
    // cold summary(아직 미캐시)면 row 가 undefined → unreadCount 폴백 0, 하지만
    // lastReadMessageId(readStateStore)는 남아 있어 구분선 판정 가능(순수 환산은
    // captureUnreadSnapshot 단일 출처).
    const snap = captureUnreadSnapshot({
      cachedUnreadCount: row?.unreadCount,
      lastReadMessageId: useReadState.getState().getLastRead(channelId),
    });
    unreadSnapshotRef.current = { channelId, ...snap };
  }
  const unreadSnapshot =
    workspaceId !== null && unreadSnapshotRef.current?.channelId === channelId
      ? {
          unreadCount: unreadSnapshotRef.current.unreadCount,
          lastReadMessageId: unreadSnapshotRef.current.lastReadMessageId,
        }
      : undefined;

  // Task-010-B: mark the channel read on open. 낙관적으로 캐시 unread 를 0 으로
  // 눌러 pill 이 즉시 사라지게 하고, 레거시 POST /read(채널 진입 마킹)는 그대로
  // 유지한다. 커서 기반 ACK(FR-RS-02)는 아래 AckScheduler 가 별도로 담당한다.
  const markRead = useMarkChannelRead(workspaceId ?? undefined);
  useEffect(() => {
    // DM channels have no workspace-scoped unread summary; skip the
    // optimistic patch + POST.
    if (workspaceId === null) return;
    // S22 review #5: useMarkChannelRead.onSuccess 와 동일한 zero-out 헬퍼를
    // 공유해 (`mentionCount` 포함) 채널 open 직후 멘션 배지 깜빡임을 막는다.
    // (위 unreadSnapshotRef 가 이 zero-out 이전 값을 이미 고정했다.)
    qc.setQueryData<{ channels: UnreadChannelSummary[] }>(
      qk.channels.unreadSummary(workspaceId),
      (old) => zeroOutChannelUnread(old, channelId),
    );
    markRead.mutate(channelId);
    // markRead is a stable callback reference from useMutation; only
    // re-fire on channel change.
  }, [channelId, workspaceId, qc]);

  // S22 (FR-RS-02): 커서 기반 ACK 스케줄러. 5초 디바운스(일반 스크롤) +
  // scroll-to-bottom 즉시 발화. ACK body 에 clientTimestamp(epoch millis) 동봉.
  // DM 채널(workspaceId=null)은 워크스페이스 스코프 ack 엔드포인트가 없으므로
  // 스케줄러를 가동하지 않는다(legacy DM 읽음 처리는 별도 carryover).
  const ackMut = useAckChannelRead(workspaceId ?? undefined);
  const ackMutRef = useRef(ackMut);
  ackMutRef.current = ackMut;
  const schedulerRef = useRef<AckScheduler | null>(null);
  if (schedulerRef.current === null) {
    schedulerRef.current = new AckScheduler({
      debounceMs: 5000,
      onFlush: (flush: AckFlush) => {
        ackMutRef.current.mutate({
          channelId: flush.channelId,
          lastReadMessageId: flush.lastReadMessageId,
          clientTimestamp: flush.clientTimestamp,
        });
      },
    });
  }
  // 채널 전환/언마운트 시 대기 디바운스를 flush 해 마지막 읽음을 잃지 않는다.
  useEffect(() => {
    const s = schedulerRef.current;
    return () => {
      s?.flushNow();
    };
  }, [channelId]);

  // S23 (FR-RS-11): Esc 단축키가 dispatch 하는 qufox.read.current 를 받았을 때
  // 현재 채널을 "최신까지 읽음" 처리하려면 마지막으로 본 메시지 id 가 필요하다.
  // onReadCursor 가 매번 올려주는 tail id 를 ref 에 보관해 핸들러가 참조한다.
  const lastSeenMessageIdRef = useRef<string | null>(null);

  const onReadCursor = useCallback(
    (cursor: { lastMessageId: string; atBottom: boolean }) => {
      // DM 은 ack 엔드포인트 미존재 → 스킵.
      if (workspaceId === null) return;
      // UUID 가 아닌 낙관적 임시 id(tmp-…)는 ACK 대상이 아니다.
      if (cursor.lastMessageId.startsWith('tmp-')) return;
      lastSeenMessageIdRef.current = cursor.lastMessageId;
      const s = schedulerRef.current;
      if (!s) return;
      if (cursor.atBottom) {
        // scroll-to-bottom + 새 메시지 → 디바운스 없이 즉시 ACK.
        s.flushImmediate(channelId, cursor.lastMessageId);
      } else {
        // 스크롤로 지나친 경우 → 5초 디바운스.
        s.scheduleDebounced(channelId, cursor.lastMessageId);
      }
    },
    [workspaceId, channelId],
  );

  // S23 (FR-RS-11): Esc = 현재 채널 읽음. useGlobalShortcuts 가 입력 필드/모달
  // 충돌을 거른 뒤 qufox.read.current 를 dispatch 하면, 여기서 마지막으로 본
  // 메시지까지 즉시 ACK 한다(monotonic 전진). DM(ack 엔드포인트 미존재) 또는
  // 미관측(tail id 없음) 채널은 no-op.
  useEffect(() => {
    const onReadCurrent = (): void => {
      if (workspaceId === null) return;
      const last = lastSeenMessageIdRef.current;
      const s = schedulerRef.current;
      if (!last || !s) return;
      s.flushImmediate(channelId, last);
    };
    window.addEventListener('qufox.read.current', onReadCurrent);
    return () => window.removeEventListener('qufox.read.current', onReadCurrent);
  }, [workspaceId, channelId]);

  return (
    <div className="flex min-w-0 flex-1">
      <main
        data-testid={`msg-column-${channelName}`}
        className="flex min-w-0 flex-1 flex-col bg-chat"
      >
        <header className="qf-topbar">
          <h2 className="qf-topbar__title">
            <span className="text-text-muted">#</span>
            {channelName}
          </h2>
          {channelTopic ? <div className="qf-topbar__topic">{channelTopic}</div> : null}
          {/* S13 (FR-CH-19): 공지 채널 배지. 게시 권한이 없는 사용자에게는
              "ADMIN 이상만 게시" 안내를 함께 보여준다. DS qf-badge + 토큰만 사용. */}
          {!isDm && isAnnouncement ? (
            <span
              data-testid="topbar-announcement-badge"
              className="qf-badge inline-flex items-center gap-[var(--s-1)]"
            >
              <Icon name="megaphone" size="sm" />
              {postingRestricted ? '공지 채널 — ADMIN 이상만 게시' : '공지 채널'}
            </span>
          ) : null}
          <div className="ml-auto flex items-center gap-[var(--s-3)]">
            {!isDm && workspaceId && workspaceSlug ? (
              <SearchInput workspaceId={workspaceId} workspaceSlug={workspaceSlug} />
            ) : null}
            <ActivityBellButton />
            <Tooltip label="곧 제공 예정" side="bottom">
              <button
                type="button"
                data-testid="topbar-pin"
                disabled
                aria-label="고정된 메시지"
                className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
              >
                <Icon name="pin" size="sm" />
              </button>
            </Tooltip>
            <Tooltip label={memberListOpen ? '멤버 목록 숨기기' : '멤버 목록 보기'} side="bottom">
              <button
                type="button"
                data-testid="topbar-members-toggle"
                aria-label={`멤버 목록 토글 (${memberCount}명)`}
                aria-pressed={memberListOpen}
                onClick={toggleMemberList}
                className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
              >
                <Icon name="users" size="sm" />
              </button>
            </Tooltip>
          </div>
        </header>
        <MessageList
          // S22 review #7: channelId 변경 시 MessageList 를 remount 해 이전
          // 채널의 scrollTop 으로 atBottom 을 오판하는 첫 틱 레이스를 제거한다.
          // (스크롤/앵커 ref 전부 초기 상태로 재시작.)
          key={channelId}
          workspaceId={workspaceId}
          channelId={channelId}
          onOpenThread={(rootId) => setActiveThread(rootId)}
          extraNames={extraNames}
          onReadCursor={onReadCursor}
          // S23 MAJOR fix: 채널 open zero-out 이전에 고정한 구분선 스냅샷.
          unreadSnapshot={unreadSnapshot}
        />
        <TypingIndicator
          channelId={channelId}
          viewerId={user?.id ?? null}
          nameByUserId={nameByUserId}
        />
        <MessageComposer
          workspaceId={workspaceId}
          channelId={channelId}
          channelName={channelName}
          postingRestricted={postingRestricted}
        />
      </main>
      {activeThread && !isDm && workspaceId ? (
        <ThreadPanel
          workspaceId={workspaceId}
          channelId={channelId}
          channelName={channelName}
          rootId={activeThread}
          onClose={() => setActiveThread(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * Task-014-C: thread panel state lives in a `?thread=` URL query param
 * so sharing the URL reopens the panel and browser-back restores it.
 */
function useThreadQueryState(
  readInitial: () => string | null,
): [string | null, (next: string | null) => void] {
  const [rootId, setRootId] = useState<string | null>(readInitial());
  useEffect(() => {
    const onPop = () => setRootId(readInitial());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [readInitial]);
  const set = useCallback((next: string | null) => {
    const url = new URL(window.location.href);
    if (next) url.searchParams.set('thread', next);
    else url.searchParams.delete('thread');
    window.history.pushState({}, '', url.toString());
    setRootId(next);
  }, []);
  return [rootId, set];
}

function ActivityBellButton(): JSX.Element {
  const { data } = useActivityUnread();
  const navigate = useNavigate();
  const count = data?.total ?? 0;
  return (
    <Tooltip label="Activity" side="bottom">
      <button
        type="button"
        data-testid="topbar-activity-bell"
        aria-label={`Activity (${count})`}
        onClick={() => navigate('/activity')}
        className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm relative"
      >
        <Icon name="bell" size="sm" />
        {count > 0 ? (
          <span
            data-testid="topbar-activity-badge"
            // S22 review #6: raw px(-4px) 제거 → DS 간격 토큰(--s-2=4px) 기반
            // arbitrary 로 동일 위치 유지(시각 회귀 없음).
            className="qf-badge qf-badge--count absolute right-[calc(-1*var(--s-2))] top-[calc(-1*var(--s-2))]"
          >
            {count > 99 ? '99+' : count}
          </span>
        ) : null}
      </button>
    </Tooltip>
  );
}
