import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Avatar,
  Icon,
  DropdownRoot,
  DropdownTrigger,
  DropdownContent,
  DropdownItem,
} from '../design-system/primitives';
import { useDmPresence } from '../features/realtime/useDmPresence';
import { useDmCreated } from '../features/dms/useDmCreated';
import { useAuth } from '../features/auth/AuthProvider';
import { useMyWorkspaces } from '../features/workspaces/useWorkspaces';
import { useNotificationPreferences } from '../features/notifications/useNotificationPreferences';
import {
  useDmList,
  useCreateOrGetDm,
  useDmByUser,
  useSetDmMute,
  useRemoveDmMute,
  type DmListItem,
} from '../features/dms/useDms';
import { useMutedChannelIds } from '../features/channels/useMutes';
import { isContextMenuKey } from '../features/channels/unreadsA11y';
import { deriveDmBadgeCount, dmBadgeText } from '../features/dms/dmRowBadge';
import { useFriendsList } from '../features/friends/useFriends';
import type { PresenceStatus } from '../features/presence/presenceStatus';
import { WorkspaceNav } from './WorkspaceNav';
import { BottomBar } from './BottomBar';
import { MessageColumn } from './MessageColumn';
import { cn } from '../lib/cn';

/**
 * task-033-C/D + follow: desktop Global DM surface. Three-column layout
 * mirroring Shell's (rail + list + message column). Route shape is
 * workspace-free — `/dm` for the list, `/dm/:userId` for a selected
 * conversation. The old `/w/:slug/dm[/:userId]` URLs redirect into here.
 *
 * Selecting a friend/DM row updates the `:userId` param in place; the
 * right column swaps from the DM list to `MessageColumn` without a
 * full-page navigate, so the left rail + friends pane stay mounted.
 */
/**
 * FR-DM-15: DM 사이드바 1행. 미읽/멘션 배지(dmRowBadge: 비뮤트→unread / 뮤트→
 * mention)와 뮤트 토글 컨텍스트 메뉴(우클릭 / Shift+F10 / ⋯ 버튼)를 담는다.
 * 뮤트 DM 은 ChannelList(FR-CH-17) 와 동일하게 회색(--text-muted) + bell-off
 * 아이콘으로 표시하고, data-muted 로 회귀 고정한다. 뮤트 상태는 메뉴 항목 + SR
 * aria-label 로 전달한다(carryover C-3: 뮤트 상태 SR 미전달 보완).
 */
function DmRow({
  dm,
  active,
  muted,
  status,
  onOpen,
  onSetMute,
  onRemoveMute,
}: {
  dm: DmListItem;
  active: boolean;
  muted: boolean;
  status: PresenceStatus;
  onOpen: () => void;
  onSetMute: (channelId: string) => void;
  onRemoveMute: (channelId: string) => void;
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  // FR-DM-15: 비뮤트→unreadCount / 뮤트→mentionCount(서버 점진 롤아웃 대비 `?? 0`).
  const badge = deriveDmBadgeCount({
    unreadCount: dm.unreadCount,
    muted,
    mentionCount: dm.mentionCount ?? 0,
  });
  // 행 컨테이너는 div(role 없음) — 내부에 메인 네비 button + 메뉴 트리거 button 을
  // 둔다(button 중첩 HTML 위반 회피, ChannelList li+overlay 패턴과 동일 취지).
  return (
    <div
      data-testid={`dm-shell-row-${dm.otherUsername}`}
      data-muted={muted ? 'true' : 'false'}
      onContextMenu={(e) => {
        // FR-DM-15: 우클릭 → 뮤트 토글 컨텍스트 메뉴(브라우저 기본 메뉴 차단).
        e.preventDefault();
        setMenuOpen(true);
      }}
      className={cn(
        'qf-channel group relative w-full',
        active && 'qf-channel--active bg-[var(--bg-selected)] text-[var(--text-strong)]',
        // FR-DM-15: 뮤트 DM 은 회색 표시(ChannelList FR-CH-17 와 동일 토큰). 활성
        // 행은 가독성을 위해 회색 처리 제외.
        muted && !active && 'text-[color:var(--text-muted)]',
      )}
    >
      {/* 메인 네비게이션 영역(전체 행 클릭 타깃). 우측 메뉴 트리거는 z-10 으로
          위에 띄워 자체 클릭을 받는다(absolute overlay 패턴). */}
      <button
        type="button"
        onClick={onOpen}
        onKeyDown={(e) => {
          // a11y: ContextMenu 키 / Shift+F10 으로도 메뉴를 연다(키보드 포함).
          if (isContextMenuKey(e)) {
            e.preventDefault();
            setMenuOpen(true);
          }
        }}
        // a11y(S22 review #4): button role 에 `aria-selected` 비허용 → `aria-current`.
        aria-current={active ? 'page' : undefined}
        // a11y(FR-DM-15 리뷰): 포커스되는 버튼 하나에 상태(뮤트·미읽/멘션 건수)를 모두 실어
        // Tab 탐색만으로 SR 이 배지 정보를 듣게 한다. 배지/bell-off 시각요소는 aria-hidden(장식).
        aria-label={`${dm.otherUsername} 대화 열기${muted ? ' (뮤트됨)' : ''}${
          badge > 0 ? (muted ? `, 멘션 ${badge}개` : `, 읽지 않음 ${badge}개`) : ''
        }`}
        className="absolute inset-0 flex w-full items-center gap-[var(--s-2)] bg-transparent px-[var(--s-3)] text-left"
      >
        <Avatar name={dm.otherUsername} size="sm" status={status} />
        <span className="flex-1 truncate">{dm.otherUsername}</span>
      </button>
      {/* 시각 레이어(아바타+이름)는 button 안에 그렸으므로, 여기서는 우측 액션만
          z-10 으로 띄운다. 배지/뮤트표식/메뉴는 포인터 이벤트를 자체 처리한다. */}
      <span className="pointer-events-none relative ml-auto flex items-center gap-[var(--s-1)]">
        {/* FR-DM-15: 뮤트 표식 — bell-off 아이콘. SR 에 뮤트 상태를 전달한다. */}
        {muted ? (
          <Icon
            name="bell-off"
            size="sm"
            aria-hidden
            data-testid={`dm-shell-muted-${dm.otherUsername}`}
            className="qf-icon--muted shrink-0"
          />
        ) : null}
        {badge > 0 ? (
          <span
            data-testid={`dm-shell-badge-${dm.otherUsername}`}
            aria-hidden
            className="qf-badge qf-badge--count"
          >
            {dmBadgeText(badge)}
          </span>
        ) : null}
        {/* FR-DM-15: 뮤트 토글 더보기 버튼 + 컨텍스트 메뉴(Radix DropdownMenu·DS
            qf-menu). 행 onContextMenu/Shift+F10 도 같은 controlled 메뉴를 연다. */}
        <DropdownRoot open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownTrigger asChild>
            <button
              type="button"
              data-testid={`dm-shell-ctx-trigger-${dm.otherUsername}`}
              aria-label="DM 옵션"
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              className={cn(
                'qf-row-iconbtn pointer-events-auto relative z-10 transition-opacity',
                menuOpen
                  ? 'opacity-100'
                  : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
              )}
            >
              <Icon name="more" size="sm" />
            </button>
          </DropdownTrigger>
          <DropdownContent align="start">
            {muted ? (
              <DropdownItem onSelect={() => onRemoveMute(dm.channelId)}>
                <span data-testid={`dm-shell-unmute-${dm.otherUsername}`} aria-label="뮤트 해제">
                  뮤트 해제
                </span>
              </DropdownItem>
            ) : (
              <DropdownItem onSelect={() => onSetMute(dm.channelId)}>
                <span data-testid={`dm-shell-mute-${dm.otherUsername}`} aria-label="뮤트">
                  뮤트
                </span>
              </DropdownItem>
            )}
          </DropdownContent>
        </DropdownRoot>
      </span>
    </div>
  );
}

export function DmShell(): JSX.Element {
  const { userId: routeUserId } = useParams<{ userId?: string }>();
  const navigate = useNavigate();
  const { user: me } = useAuth();
  const { data: mine } = useMyWorkspaces();
  const workspaces = useMemo(() => mine?.workspaces ?? [], [mine]);
  // DM is workspace-free end to end now — list / by-user / create
  // mutate `/me/dms/*`, and MessageColumn below routes messages
  // through `/me/dms/:channelId/messages` regardless of whether the
  // caller has any workspace membership.
  const { data: dms } = useDmList(undefined);
  // S22 (FR-DM-15): 뮤트 DM 은 unread 배지를 억제(멘션만). DM 채널도 동일한
  // UserChannelMute 테이블을 쓰므로 GET /me/mutes 의 channelId 집합을 공유한다.
  const mutedChannelIds = useMutedChannelIds();
  const { data: friends } = useFriendsList('accepted');
  const createDm = useCreateOrGetDm(undefined);
  // FR-DM-15: DM 뮤트/뮤트해제 — 성공 시 me/mutes + dm 목록 무효화는 훅 내부.
  const setDmMute = useSetDmMute(undefined);
  const removeDmMute = useRemoveDmMute(undefined);
  const onSetMute = (channelId: string): void => {
    setDmMute.mutate(channelId);
  };
  const onRemoveMute = (channelId: string): void => {
    removeDmMute.mutate(channelId);
  };
  const [query, setQuery] = useState('');
  // task-040 R3 + reviewer H1: realtime now App-level.
  useNotificationPreferences();
  // S99 (S16 carryover · MED): dm:created WS 이벤트를 DM Shell 에서 소비한다.
  // 다른 기기/상대가 새 DM·그룹 DM 을 개설하면 서버가 user:{userId} 룸으로 push 하고,
  // 이 훅이 ['dm','list']/['dm','groups'] 캐시를 무효화해 사이드바 목록이 즉시
  // 새 대화를 띄운다. 훅은 존재했으나 어떤 Shell 에도 배선돼 있지 않아 dormant 였다.
  // DmShell 은 /dm 과 /dm/:userId 양쪽에서 마운트되므로 여기서 1회 opt-in 한다.
  useDmCreated();
  // task-041 A-3: aggregate workspace presence so DM list rows show
  // online/dnd/offline dots even though DMs are workspaceless.
  const { getStatus } = useDmPresence();

  // Resolve the DM channel for the selected :userId. The /me/dms POST
  // is idempotent — safe to call on every route change that lands on a
  // user without a known channelId.
  const { data: byUser } = useDmByUser(undefined, routeUserId);
  const selectedChannelId = byUser?.channelId ?? null;

  useEffect(() => {
    // If the user picked a friend who has never been DM'd, reserve the
    // channel now so MessageColumn has a channelId to render against.
    if (!routeUserId || selectedChannelId || byUser === undefined) return;
    void createDm.mutateAsync({ userId: routeUserId }).catch(() => undefined);
    // mutation invalidation will refresh byUser via queryKey side-effect
  }, [routeUserId, selectedChannelId, byUser, createDm]);

  const norm = query.trim().toLowerCase();
  const filtered = (dms?.items ?? []).filter(
    (d) => !norm || d.otherUsername.toLowerCase().includes(norm),
  );

  const selectedFriend = useMemo(() => {
    if (!routeUserId) return null;
    const fromFriends = (friends?.items ?? []).find((f) => f.otherUserId === routeUserId);
    if (fromFriends) return { userId: routeUserId, username: fromFriends.otherUsername };
    const fromDms = (dms?.items ?? []).find((d) => d.otherUserId === routeUserId);
    if (fromDms) return { userId: routeUserId, username: fromDms.otherUsername };
    return { userId: routeUserId, username: '' };
  }, [routeUserId, friends, dms]);

  // DM author map: MessageList falls back to `useMembers(primary.id)`
  // which never sees the other participant when they belong to a
  // different workspace (or no workspace at all). Supply the pair
  // here so MessageItem stops rendering the other side as "unknown".
  const extraNames = useMemo(() => {
    const m = new Map<string, string>();
    if (me?.id && me?.username) m.set(me.id, me.username);
    if (selectedFriend?.userId && selectedFriend.username)
      m.set(selectedFriend.userId, selectedFriend.username);
    return m;
  }, [me, selectedFriend]);

  const openDm = (userId: string): void => {
    navigate(`/dm/${userId}`);
  };

  return (
    <div data-testid="dm-shell-root" className="flex h-full bg-background text-foreground">
      <div className="flex min-h-0 flex-col">
        <div className="flex min-h-0 flex-1">
          <WorkspaceNav workspaces={workspaces} activeSlug={null} />
          <aside
            className="qf-channellist flex flex-col"
            style={{ width: 'var(--w-channellist)', background: 'var(--bg-panel)' }}
            data-testid="dm-side-friends"
          >
            <header className="qf-topbar">
              <h2 className="qf-topbar__title">다이렉트 메시지</h2>
            </header>
            <div className="px-[var(--s-3)] py-[var(--s-2)]">
              <input
                type="search"
                data-testid="dm-shell-search"
                aria-label="다이렉트 메시지 검색"
                placeholder="이름으로 검색"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="qf-input w-full"
              />
            </div>
            <nav className="flex-1 overflow-y-auto" aria-label="DM + 친구 목록">
              <Link to="/friends" data-testid="dm-side-friends-link" className="qf-channel">
                <Icon name="users" size="sm" className="text-text-muted" />
                <span className="flex-1">친구 관리</span>
              </Link>
              {filtered.length > 0 ? (
                <div className="qf-section">
                  <div className="qf-section__title">대화 목록</div>
                </div>
              ) : null}
              {filtered.map((d) => (
                <DmRow
                  key={d.channelId}
                  dm={d}
                  active={d.otherUserId === routeUserId}
                  muted={mutedChannelIds.has(d.channelId)}
                  status={getStatus(d.otherUserId)}
                  onOpen={() => openDm(d.otherUserId)}
                  onSetMute={onSetMute}
                  onRemoveMute={onRemoveMute}
                />
              ))}
              {(friends?.items ?? []).length > 0 ? (
                <div className="qf-section">
                  <div className="qf-section__title">친구</div>
                </div>
              ) : null}
              {(friends?.items ?? []).map((f) => (
                <button
                  key={f.otherUserId}
                  type="button"
                  data-testid={`dm-side-friend-${f.otherUsername}`}
                  onClick={() => openDm(f.otherUserId)}
                  // a11y(S22 review #4): button role → `aria-current="page"`.
                  aria-current={f.otherUserId === routeUserId ? 'page' : undefined}
                  className={cn(
                    'qf-channel w-full text-left',
                    f.otherUserId === routeUserId &&
                      'qf-channel--active bg-[var(--bg-selected)] text-[var(--text-strong)]',
                  )}
                >
                  <Avatar name={f.otherUsername} size="sm" status={getStatus(f.otherUserId)} />
                  <span className="flex-1 truncate">{f.otherUsername}</span>
                </button>
              ))}
            </nav>
          </aside>
        </div>
        <BottomBar />
      </div>
      {routeUserId && selectedChannelId ? (
        <MessageColumn
          workspaceId={null}
          workspaceSlug={null}
          channelId={selectedChannelId}
          channelName={selectedFriend?.username || '…'}
          channelTopic={null}
          channelType="DIRECT"
          extraNames={extraNames}
        />
      ) : routeUserId ? (
        <main className="qf-empty flex-1" data-testid="dm-shell-loading">
          <div className="qf-empty__title">대화를 준비 중…</div>
        </main>
      ) : (
        <main className="qf-empty flex-1" data-testid="dm-shell-empty">
          <div className="qf-empty__title">
            {(friends?.items ?? []).length === 0
              ? '먼저 친구를 추가해보세요'
              : '대화할 친구를 선택하세요'}
          </div>
          <div className="qf-empty__body">
            {(friends?.items ?? []).length === 0
              ? '친구 목록에서 추가하거나, 공개 워크스페이스를 둘러보세요.'
              : '좌측 목록에서 친구 또는 기존 대화를 클릭하세요.'}
          </div>
          {/* task-047 iter5 (O2): 명시 CTA 버튼 */}
          {(friends?.items ?? []).length === 0 ? (
            <div className="flex gap-[var(--s-2)]">
              <Link
                to="/friends"
                data-testid="dm-empty-cta-friends"
                className="qf-btn qf-btn--primary"
              >
                친구 추가
              </Link>
              <Link
                to="/discover"
                data-testid="dm-empty-cta-discover"
                className="qf-btn qf-btn--ghost"
              >
                워크스페이스 찾기
              </Link>
            </div>
          ) : null}
        </main>
      )}
    </div>
  );
}
