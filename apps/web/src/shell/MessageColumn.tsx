import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMembers, useWorkspace } from '../features/workspaces/useWorkspaces';
import { CreatorEmptyStateCta } from '../features/onboarding/CreatorEmptyStateCta';
import { useUI } from '../stores/ui-store';
import {
  useMarkChannelRead,
  useAckChannelRead,
  zeroOutChannelUnread,
} from '../features/channels/useUnread';
import { AckScheduler, type AckFlush } from '../features/messages/ackScheduler';
import { MessageList } from '../features/messages/MessageList';
import { MessageComposer } from '../features/messages/MessageComposer';
import { EphemeralList } from '../features/messages/slashCommands/EphemeralList';
import { GiphyPreviewSlot } from '../features/messages/slashCommands/GiphyPreviewSlot';
import { useDropZone } from '../features/attachments/useDropZone';
import { DropZoneOverlay } from '../features/attachments/DropZoneOverlay';
import { PinPanel } from '../features/messages/PinPanel';
import { usePinCount } from '../features/messages/useMessages';
import { ThreadPanel } from '../features/threads/ThreadPanel';
import { CustomEmojiProvider } from '../features/emojis/CustomEmojiContext';
import { useLiveMessages } from '../features/realtime/useLiveMessages';
import { useReadState } from '../features/realtime/readStateStore';
import { captureUnreadSnapshot } from '../features/messages/newMessages';
import { TypingIndicator } from '../features/typing/TypingIndicator';
import { useAuth } from '../features/auth/AuthProvider';
import { useSearchParams } from 'react-router-dom';
import { Icon, Tooltip } from '../design-system/primitives';
import { SearchInput } from '../features/search/SearchInput';
import { useActivityUnread } from '../features/activity/useActivity';
import { useBadgeStore } from '../features/notifications/badgeStore';
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
  // S50 (D10 · FR-PS-03): 핀 패널 토글 상태 + 채널 헤더 핀 카운트 배지.
  const pinPanelOpen = useUI((s) => s.pinPanelOpen);
  const togglePinPanel = useUI((s) => s.togglePinPanel);
  const setPinPanelOpen = useUI((s) => s.setPinPanelOpen);
  // S69 (FR-W10 · Fork C): 멤버 디렉터리 토글(모든 멤버 진입점).
  const memberDirectoryOpen = useUI((s) => s.memberDirectoryOpen);
  const toggleMemberDirectory = useUI((s) => s.toggleMemberDirectory);
  // S50 review (a11y A-PP-03): 패널 닫힘(닫기 버튼/Esc) 시 포커스를 트리거 핀
  // 버튼으로 되돌린다. 비모달이라 mount 시 포커스 이동은 안 하지만(A-PP-01),
  // 명시적 닫힘 후 포커스 미아 방지.
  const pinTriggerRef = useRef<HTMLButtonElement>(null);
  const closePinPanel = useCallback(() => {
    setPinPanelOpen(false);
    pinTriggerRef.current?.focus();
  }, [setPinPanelOpen]);
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
  // S71 (FR-W09a · Fork-B): 생성자(OWNER) 빈 채널 CTA. 기본 채널 + OWNER 일 때만 구성한다.
  // 초대 0개 조건은 CreatorEmptyStateCta 가 useInvites 로 자체 판정한다(empty state 진입 =
  // 채널 비어 있음 보장). 채널이 기본 채널인지 비교에 워크스페이스 상세를 읽는다(캐시 hit).
  const { data: wsDetail } = useWorkspace(workspaceId ?? undefined);
  const isDefaultChannel = !isDm && wsDetail?.defaultChannelId === channelId;
  const creatorCta =
    !isDm && workspaceId !== null && myRole === 'OWNER' && isDefaultChannel ? (
      <CreatorEmptyStateCta workspaceId={workspaceId} isOwner />
    ) : undefined;

  // S56 (D11 / FR-AM-01/21): 채팅 컬럼 드래그앤드롭 + 붙여넣기 진입점. 드롭/붙여넣기로
  // 받은 파일은 qufox.composer.addFiles 이벤트로 MessageComposer 에 전달한다(composer 가
  // 클램프 + 3단계 업로드 트레이를 소유). DM(wsId=null)은 채널 nested 첨부 미지원,
  // 게시 제한 채널은 비활성. window 이벤트는 composer 의 focus 패턴과 동일.
  const attachmentsEnabled = !isDm && !postingRestricted;
  const { isDragging, dragHandlers } = useDropZone({
    disabled: !attachmentsEnabled,
    onFiles: useCallback(
      (files: File[]) => {
        window.dispatchEvent(
          new CustomEvent('qufox.composer.addFiles', { detail: { channelId, files } }),
        );
      },
      [channelId],
    ),
  });
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

  // S30 fix-forward (BLOCKER 기능 M2): 검색 결과 클릭 → `/w/{slug}/{ch}?msg={id}`.
  // 여기서 `?msg=` 를 읽어 MessageList 에 점프 대상으로 넘기고(around 로드 +
  // scrollIntoView + 하이라이트), MessageList 가 소비를 알리면 파라미터를
  // replace 로 제거합니다(재진입/뒤로가기 루프 방지). UUID 형식만 허용 —
  // `around` 서버 파라미터가 uuid 만 받기 때문입니다.
  const [searchParams, setSearchParams] = useSearchParams();
  const rawMsg = searchParams.get('msg');
  const jumpMessageId =
    rawMsg && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawMsg)
      ? rawMsg
      : null;
  const clearJumpParam = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('msg');
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  // S50 (D10 · FR-PS-03): 핀 패널 항목 클릭 → 현재 채널 URL 에 `?msg=` 를 실어
  // MessageColumn 의 around 로드 + scrollIntoView + 하이라이트를 트리거한다(검색
  // 결과 점프와 동일 메커니즘 — 같은 채널이라 navigate 없이 search param 만 갱신).
  const jumpToMessage = useCallback(
    (messageId: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('msg', messageId);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // S50 (D10 · FR-PS-03): 채널 헤더 핀 카운트 배지. DM(wsId=null)은 핀 미지원이라
  // 비활성(usePinCount 가 enabled=false 로 폴백). channel:pin_added/removed 가
  // 캐시를 invalidate 해 실시간 갱신된다.
  const { data: pinCountData } = usePinCount(workspaceId, channelId);
  const pinCount = pinCountData?.used ?? 0;

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
      // S50 (D10): 채널 전환 시 핀 패널도 닫는다(이전 채널 핀이 잔류하지 않도록).
      setPinPanelOpen(false);
    }
  }, [channelId, setActiveThread, setPinPanelOpen]);

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
        // S56 (D11 / FR-AM-01): relative — DropZoneOverlay 가 absolute inset 으로
        // 이 컬럼 위에 뜬다. 드래그 핸들러는 attachmentsEnabled 일 때만 동작(disabled
        // 가드는 useDropZone 내부에서 no-op 처리).
        className="relative flex min-w-0 flex-1 flex-col bg-chat"
        {...dragHandlers}
      >
        {isDragging ? <DropZoneOverlay channelName={channelName} /> : null}
        {/* S56 fix-forward (a11y B-03): DropZoneOverlay 는 aria-hidden 이라 드래그
            진입을 스크린리더가 인지하지 못했다. 항상 마운트된 sr-only live region
            으로 드래그 시작/종료를 통지한다(false 시 빈 문자열로 되돌려 다음
            진입에서 다시 읽히게 한다). 오버레이의 aria-hidden 은 유지. */}
        <span className="sr-only" aria-live="polite" data-testid="dropzone-live">
          {isDragging ? `${channelName}에 파일을 끌어다 놓을 수 있습니다` : ''}
        </span>
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
            {/* S50 (D10 · FR-PS-03): 고정된 메시지 패널 토글 + 핀 카운트 배지.
                DM 채널은 핀 미지원이라 버튼을 노출하지 않는다. */}
            {!isDm && workspaceId ? (
              <Tooltip
                label={pinPanelOpen ? '고정된 메시지 숨기기' : '고정된 메시지'}
                side="bottom"
              >
                <button
                  type="button"
                  data-testid="topbar-pin"
                  ref={pinTriggerRef}
                  // S50 review (a11y A-MC-01/02/04): 디스클로저 트리거이므로
                  // aria-expanded + aria-controls(=pin-panel id)로 패널 관계를 노출
                  // 한다(ActivityBellButton 선례). 핀 0개면 "(0)" 없이 읽는다.
                  aria-label={pinCount > 0 ? `고정된 메시지 (${pinCount})` : '고정된 메시지'}
                  aria-expanded={pinPanelOpen}
                  aria-controls="pin-panel"
                  onClick={() => togglePinPanel()}
                  className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm relative"
                >
                  <Icon name="pin" size="sm" />
                  {pinCount > 0 ? (
                    <span
                      data-testid="topbar-pin-badge"
                      aria-hidden="true"
                      className="qf-badge qf-badge--count absolute right-[calc(-1*var(--s-2))] top-[calc(-1*var(--s-2))]"
                    >
                      {pinCount > 99 ? '99+' : pinCount}
                    </span>
                  ) : null}
                </button>
              </Tooltip>
            ) : null}
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
            {/* S69 (FR-W10 · Fork C): 멤버 디렉터리 진입점(모든 멤버 열람). 설정 오버레이
                밖의 멤버-접근 진입점이라 채널 헤더에 둔다. */}
            <Tooltip label="멤버 디렉터리" side="bottom">
              <button
                type="button"
                data-testid="topbar-directory-toggle"
                aria-label="멤버 디렉터리 열기"
                // S69 fix-forward (a11y H-01 / ui): 디렉터리는 토글 패널(슬롯)이므로
                // aria-expanded + aria-controls 로 펼침/대상 관계를 노출한다(aria-pressed
                // 대신). 아이콘도 '검색(search)' → '멤버(users)' 계열로 교체해 의미를 맞춘다.
                aria-expanded={memberDirectoryOpen}
                aria-controls="member-directory-panel"
                onClick={toggleMemberDirectory}
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
          // S30 fix-forward (M2): 검색 결과 점프 대상 + 소비 후 URL 정리 콜백.
          jumpMessageId={jumpMessageId}
          onJumpConsumed={clearJumpParam}
          // S71 (FR-W09a): 생성자(OWNER) 빈 채널 CTA(기본 채널 한정).
          creatorCta={creatorCta}
        />
        <TypingIndicator
          channelId={channelId}
          viewerId={user?.id ?? null}
          nameByUserId={nameByUserId}
        />
        {/* S80 (FR-SC-05): EPHEMERAL 슬래시 응답(발신자 전용 인라인 시스템 메시지). */}
        <EphemeralList channelId={channelId} />
        {/* S81b (FR-SC-07): /giphy 발신자 전용 GIF 프리뷰(Shuffle/Send/Cancel). */}
        {workspaceId ? <GiphyPreviewSlot workspaceId={workspaceId} channelId={channelId} /> : null}
        <MessageComposer
          workspaceId={workspaceId}
          channelId={channelId}
          channelName={channelName}
          postingRestricted={postingRestricted}
        />
      </main>
      {activeThread && !isDm && workspaceId ? (
        // 072-N0 리뷰 MEDIUM: ThreadPanel 은 MessageList(내부 provider)의 형제라
        // 커스텀 이모지 컨텍스트 밖이었다 — 여기서 감싸 루트/답글 :slug: 가 메인
        // 타임라인과 동일하게 <img> 로 렌더된다(동일 쿼리키라 추가 요청 없음).
        <CustomEmojiProvider workspaceId={workspaceId}>
          <ThreadPanel
            workspaceId={workspaceId}
            channelId={channelId}
            channelName={channelName}
            rootId={activeThread}
            onClose={() => setActiveThread(null)}
          />
        </CustomEmojiProvider>
      ) : null}
      {/* S50 (D10 · FR-PS-03): 고정된 메시지 슬라이드인 패널. 스레드 패널이 열려
          있지 않을 때만 우측 슬롯을 점유한다(같은 캔버스 폭 공유 — PRD 디자인 모델). */}
      {pinPanelOpen && !activeThread && !isDm && workspaceId ? (
        <PinPanel
          workspaceId={workspaceId}
          channelId={channelId}
          nameByUserId={nameByUserId}
          onClose={closePinPanel}
          onJump={(messageId) => {
            jumpToMessage(messageId);
            setPinPanelOpen(false);
          }}
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

/**
 * S47 fix-forward (BLOCKER-1 · FR-MN-13): 토픽바 알림 벨 → Activity Inbox 패널
 * 토글. 종전엔 `/activity` 전체화면으로 navigate 해 우측 슬롯의 ActivityInboxPanel
 * 이 영영 마운트되지 않는 死코드였다. 이제 `toggleActivityInbox` 로 우측 슬롯을
 * Inbox 패널로 열고/닫는다(aria-expanded 로 상태 노출). 배지는 미읽 멘션 수
 * (badgeStore.totalMention — 서버 진실값·뮤트 제외)를 우선하고, 없으면 활동
 * unread-counts 합계로 폴백한다(채널 컨텍스트 외에서도 합리적 근사).
 */
export function ActivityBellButton(): JSX.Element {
  const { data } = useActivityUnread();
  const activityInboxOpen = useUI((s) => s.activityInboxOpen);
  const toggleActivityInbox = useUI((s) => s.toggleActivityInbox);
  const mentionCount = useBadgeStore((s) =>
    Object.values(s.byWorkspace).reduce((acc, e) => acc + e.mentionCount, 0),
  );
  const count = mentionCount > 0 ? mentionCount : (data?.total ?? 0);
  return (
    <Tooltip label="알림" side="bottom">
      <button
        type="button"
        data-testid="topbar-activity-bell"
        aria-label={`알림 (${count})`}
        aria-expanded={activityInboxOpen}
        aria-controls="activity-inbox-panel"
        onClick={() => toggleActivityInbox()}
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
