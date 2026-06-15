import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Avatar,
  Icon,
  Dialog,
  DropdownRoot,
  DropdownTrigger,
  DropdownContent,
  DropdownItem,
  DropdownSeparator,
  DropdownSub,
  DropdownSubTrigger,
  DropdownSubContent,
} from '../design-system/primitives';
import { useDmPresence } from '../features/realtime/useDmPresence';
import { useDmCreated } from '../features/dms/useDmCreated';
import { useAuth } from '../features/auth/AuthProvider';
import { useMyWorkspaces } from '../features/workspaces/useWorkspaces';
import { useNotificationPreferences } from '../features/notifications/useNotificationPreferences';
import {
  useDmList,
  useDmGroupList,
  useDmGroupMembers,
  useCreateOrGetDm,
  useCreateGroupDm,
  useDmByUser,
  useRemoveDmMute,
  useSetDmVisibility,
  useLeaveGroupDm,
  useSetDmMuteUntil,
} from '../features/dms/useDms';
import {
  buildDmRows,
  MUTE_DURATION_OPTIONS,
  muteUntilIso,
  type UnifiedDmRow,
} from '../features/dms/dmRows';
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
 * task-033-C/D + 072-N1: desktop Global DM surface. Three-column layout
 * mirroring Shell's (rail + list + message column). Route shape is
 * workspace-free — `/dm` for the list, `/dm/:userId` for a 1:1 conversation,
 * `/dm/g/:groupId` for a group conversation (channelId-keyed — group DMs
 * have no single peer userId).
 *
 * 072-N1: 종전엔 1:1 DM(useDmList)만 렌더하고 그룹(useDmGroupList)은 dormant
 * 였다. 이번 슬라이스가 그룹 행·생성 모달·숨기기/나가기/뮤트기간 메뉴·서버
 * 검색(q)을 모두 배선해 데스크톱 DM 셸을 PRD 수준으로 끌어올린다.
 */

/**
 * 072-N1-3: DM 행 컨텍스트 메뉴 내용(숨기기 / [그룹]나가기 / 뮤트 기간 서브메뉴
 * 또는 뮤트 해제). 1:1·그룹 행이 공유한다. testid 는 행 title 로 키잉한다.
 */
function DmRowMenu({
  row,
  muted,
  onHide,
  onLeave,
  onSetMuteUntil,
  onRemoveMute,
}: {
  row: UnifiedDmRow;
  muted: boolean;
  onHide: () => void;
  onLeave: () => void;
  onSetMuteUntil: (_minutes: number | null) => void;
  onRemoveMute: () => void;
}): JSX.Element {
  const key = row.title;
  return (
    <DropdownContent align="start">
      <DropdownItem onSelect={onHide}>
        <span data-testid={`dm-shell-hide-${key}`} aria-label="대화 숨기기">
          대화 숨기기
        </span>
      </DropdownItem>
      {row.kind === 'group' ? (
        <DropdownItem danger onSelect={onLeave}>
          <span data-testid={`dm-shell-leave-${key}`} aria-label="그룹 나가기">
            그룹 나가기
          </span>
        </DropdownItem>
      ) : null}
      <DropdownSeparator />
      {muted ? (
        <DropdownItem onSelect={onRemoveMute}>
          <span data-testid={`dm-shell-unmute-${key}`} aria-label="뮤트 해제">
            뮤트 해제
          </span>
        </DropdownItem>
      ) : (
        // 072-N1-3 (FR-DM-11): 뮤트 기간 서브메뉴. 트리거 testid 는 종전 회귀고정과
        // 호환되게 dm-shell-mute-${key}, 각 기간 항목은 -${opt.key} 접미사.
        <DropdownSub>
          <DropdownSubTrigger>
            <span data-testid={`dm-shell-mute-${key}`} className="flex w-full items-center">
              <span className="flex-1">뮤트</span>
              <Icon name="chevron-right" size="sm" aria-hidden />
            </span>
          </DropdownSubTrigger>
          <DropdownSubContent>
            {MUTE_DURATION_OPTIONS.map((opt) => (
              <DropdownItem key={opt.key} onSelect={() => onSetMuteUntil(opt.minutes)}>
                <span data-testid={`dm-shell-mute-${key}-${opt.key}`}>{opt.label}</span>
              </DropdownItem>
            ))}
          </DropdownSubContent>
        </DropdownSub>
      )}
    </DropdownContent>
  );
}

/**
 * 072-N1: 통합 DM 행(1:1 + 그룹). 1:1 은 단일 아바타+프레즌스 닷+읽지 않음/멘션 배지,
 * 그룹은 아바타 스택(2장 겹침). 072 백로그 S-E 부터 서버 listGroups 가 그룹 unread/
 * mention 을 내려주므로 그룹도 1:1 과 동일하게 읽지 않음/멘션 배지를 단다(종전 0 하드코딩 제거).
 * 뮤트 회색/표식은 UserChannelMute 공유라 channelId 로 양쪽 공통.
 */
function DmUnifiedRow({
  row,
  meId,
  active,
  muted,
  status,
  onOpen,
  onHide,
  onLeave,
  onSetMuteUntil,
  onRemoveMute,
}: {
  row: UnifiedDmRow;
  meId: string | undefined;
  active: boolean;
  muted: boolean;
  status: PresenceStatus;
  onOpen: () => void;
  onHide: () => void;
  onLeave: () => void;
  onSetMuteUntil: (_minutes: number | null) => void;
  onRemoveMute: () => void;
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const isGroup = row.kind === 'group';
  // 비뮤트→unread / 뮤트→mention. 072 백로그 S-E: 그룹 DM 도 서버 listGroups 가
  // unread/mention 을 내려주므로 1:1 과 동일 로직(종전 그룹=0 하드코딩 제거).
  const badge = deriveDmBadgeCount({
    unreadCount: row.unreadCount ?? 0,
    muted,
    mentionCount: row.mentionCount ?? 0,
  });
  const memberCount = row.memberIds?.length ?? 0;
  // 072-N1(리뷰 MEDIUM): 아바타 스택에서 본인 제외(제목 groupDmTitle 과 정합).
  const stackPeers = (row.participants ?? []).filter((p) => p.userId !== meId).slice(0, 2);
  // 072-N1(리뷰 LOW): 메뉴 항목 선택 후 controlled 메뉴를 닫는다(preventDefault 로
  // Radix 자동 닫힘이 막히므로 수동).
  const close = (fn: () => void) => () => {
    fn();
    setMenuOpen(false);
  };
  const closeArg = (fn: (_m: number | null) => void) => (m: number | null) => {
    fn(m);
    setMenuOpen(false);
  };
  return (
    <div
      data-testid={`dm-shell-row-${row.title}`}
      data-kind={row.kind}
      data-muted={muted ? 'true' : 'false'}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
      }}
      className={cn(
        'qf-channel group relative w-full',
        // 072-N1(리뷰 plausible): 그룹 행은 2줄(제목+멤버수)이라 기본 32px 행에서
        // absolute 콘텐츠가 클리핑된다 — spacious(40px)로 높여 둘째 줄을 수용한다.
        isGroup && 'min-h-[var(--h-channel-row-spacious)]',
        active && 'qf-channel--active bg-[var(--bg-selected)] text-[var(--text-strong)]',
        muted && !active && 'text-[color:var(--text-muted)]',
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        onKeyDown={(e) => {
          if (isContextMenuKey(e)) {
            e.preventDefault();
            setMenuOpen(true);
          }
        }}
        aria-current={active ? 'page' : undefined}
        aria-label={`${row.title} 대화 열기${isGroup && memberCount > 0 ? `, 멤버 ${memberCount}명` : ''}${
          muted ? ' (뮤트됨)' : ''
        }${badge > 0 ? (muted ? `, 멘션 ${badge}개` : `, 읽지 않음 ${badge}개`) : ''}`}
        className="absolute inset-0 flex w-full items-center gap-[var(--s-2)] bg-transparent px-[var(--s-3)] text-left"
      >
        {isGroup ? (
          // 그룹 아바타 스택(겹침 2장). DS 토큰 간격만 사용.
          <span
            className="relative inline-flex shrink-0"
            data-testid={`dm-shell-stack-${row.title}`}
          >
            {stackPeers.map((p, i) => (
              <span
                key={p.userId}
                className={cn('inline-flex rounded-full', i > 0 && '-ml-[var(--s-3)]')}
                style={{ zIndex: stackPeers.length - i }}
              >
                <Avatar name={p.username} size="sm" />
              </span>
            ))}
            {stackPeers.length === 0 ? <Avatar name={row.title} size="sm" /> : null}
          </span>
        ) : (
          <Avatar name={row.title} size="sm" status={status} />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{row.title}</span>
          {isGroup ? (
            // aria-hidden: 멤버 수는 위 button aria-label 에 이미 실려 SR 중복 방지(장식).
            <span aria-hidden className="truncate text-[length:var(--fs-12)] text-text-muted">
              {memberCount > 0 ? `멤버 ${memberCount}명` : '그룹'}
            </span>
          ) : null}
        </span>
      </button>
      <span className="pointer-events-none relative ml-auto flex items-center gap-[var(--s-1)]">
        {muted ? (
          <Icon
            name="bell-off"
            size="sm"
            aria-hidden
            data-testid={`dm-shell-muted-${row.title}`}
            className="qf-icon--muted shrink-0"
          />
        ) : null}
        {badge > 0 ? (
          <span
            data-testid={`dm-shell-badge-${row.title}`}
            aria-hidden
            className="qf-badge qf-badge--count"
          >
            {dmBadgeText(badge)}
          </span>
        ) : null}
        <DropdownRoot open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownTrigger asChild>
            <button
              type="button"
              data-testid={`dm-shell-ctx-trigger-${row.title}`}
              aria-label={`${row.title} 대화 옵션`}
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
          <DmRowMenu
            row={row}
            muted={muted}
            onHide={close(onHide)}
            onLeave={close(onLeave)}
            onSetMuteUntil={closeArg(onSetMuteUntil)}
            onRemoveMute={close(onRemoveMute)}
          />
        </DropdownRoot>
      </span>
    </div>
  );
}

/**
 * 072-N1-2 (FR-DM-01/02): 새 DM/그룹 생성 모달. 친구 목록에서 받는 사람을
 * 멀티셀렉트한다. 1명 → useCreateOrGetDm(1:1), 2명+ → useCreateGroupDm(그룹).
 */
function NewConversationModal({
  open,
  onOpenChange,
  candidates,
  getStatus,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (_open: boolean) => void;
  candidates: { otherUserId: string; otherUsername: string }[];
  getStatus: (_userId: string) => PresenceStatus;
  onCreated: (
    _target: { kind: 'direct'; userId: string } | { kind: 'group'; channelId: string },
  ) => void;
}): JSX.Element {
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const createDm = useCreateOrGetDm(undefined);
  const createGroup = useCreateGroupDm(undefined);
  const pending = createDm.isPending || createGroup.isPending;

  // 모달 닫힐 때 상태 리셋(다음 열림에 잔상 방지).
  useEffect(() => {
    if (!open) {
      setSelected([]);
      setFilter('');
      setError(null);
    }
  }, [open]);

  const norm = filter.trim().toLowerCase();
  const shown = candidates.filter((c) => !norm || c.otherUsername.toLowerCase().includes(norm));
  const byId = useMemo(
    () => new Map(candidates.map((c) => [c.otherUserId, c.otherUsername])),
    [candidates],
  );

  const toggle = (userId: string): void => {
    setError(null);
    setSelected((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId],
    );
  };

  const submit = async (): Promise<void> => {
    // 072-N1(리뷰 LOW): 함수 내 pending 가드 — 빠른 더블클릭 이중 제출 방지(버튼
    // disabled 의 UI 레벨 의존 보완).
    if (selected.length === 0 || pending) return;
    setError(null);
    try {
      if (selected.length === 1) {
        const res = await createDm.mutateAsync({ userId: selected[0] });
        onCreated({ kind: 'direct', userId: selected[0] });
        void res;
      } else {
        const res = await createGroup.mutateAsync({ memberIds: selected });
        onCreated({ kind: 'group', channelId: res.channelId });
      }
      onOpenChange(false);
    } catch {
      setError('대화를 시작하지 못했습니다. 잠시 후 다시 시도해주세요.');
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="새 메시지"
      description="친구를 선택해 1:1 또는 그룹 대화를 시작하세요."
      className="w-[min(92vw,28rem)]"
    >
      <div data-testid="dm-new-modal" className="flex flex-col gap-[var(--s-3)]">
        <input
          type="search"
          data-testid="dm-new-filter"
          aria-label="받는 사람 검색"
          placeholder="친구 검색"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="qf-input w-full"
          autoFocus
        />
        {selected.length > 0 ? (
          <div className="flex flex-wrap gap-[var(--s-1)]" data-testid="dm-new-selected">
            {selected.map((id) => (
              <span
                key={id}
                className="inline-flex items-center gap-[var(--s-1)] rounded-full bg-[var(--bg-selected)] px-[var(--s-2)] py-[var(--s-1)] text-[length:var(--fs-12)]"
              >
                {byId.get(id) ?? id}
                <button
                  type="button"
                  aria-label={`${byId.get(id) ?? id} 제거`}
                  onClick={() => toggle(id)}
                  className="qf-row-iconbtn"
                >
                  <Icon name="x" size="sm" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <ul role="list" className="max-h-[40vh] min-h-0 overflow-y-auto">
          {shown.length === 0 ? (
            <li className="qf-empty">
              <div className="qf-empty__body">
                {candidates.length === 0
                  ? '친구가 없습니다. /friends 에서 추가하세요.'
                  : '일치하는 친구가 없습니다.'}
              </div>
            </li>
          ) : (
            shown.map((c) => {
              const checked = selected.includes(c.otherUserId);
              return (
                <li key={c.otherUserId}>
                  <button
                    type="button"
                    data-testid={`dm-new-candidate-${c.otherUsername}`}
                    aria-pressed={checked}
                    onClick={() => toggle(c.otherUserId)}
                    className={cn(
                      'qf-channel w-full text-left',
                      checked && 'bg-[var(--bg-selected)] text-[var(--text-strong)]',
                    )}
                  >
                    <Avatar name={c.otherUsername} size="sm" status={getStatus(c.otherUserId)} />
                    <span className="flex-1 truncate">{c.otherUsername}</span>
                    {checked ? <Icon name="check" size="sm" aria-hidden /> : null}
                  </button>
                </li>
              );
            })
          )}
        </ul>
        {error ? (
          <div role="alert" className="text-[length:var(--fs-12)] text-[color:var(--danger)]">
            {error}
          </div>
        ) : null}
        <div className="flex justify-end gap-[var(--s-2)]">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="qf-btn qf-btn--ghost"
          >
            취소
          </button>
          <button
            type="button"
            data-testid="dm-new-submit"
            disabled={selected.length === 0 || pending}
            onClick={() => void submit()}
            className="qf-btn qf-btn--primary"
          >
            {selected.length > 1 ? `그룹 만들기 (${selected.length})` : '대화 시작'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

export function DmShell(): JSX.Element {
  const { userId: routeUserId, groupId: routeGroupId } = useParams<{
    userId?: string;
    groupId?: string;
  }>();
  const navigate = useNavigate();
  const { user: me } = useAuth();
  const { data: mine } = useMyWorkspaces();
  const workspaces = useMemo(() => mine?.workspaces ?? [], [mine]);

  // 072-N1-4 (FR-DM-04): 검색어를 디바운스해 서버 q 로 전달(1:1+그룹 동일 q).
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 250);
    return () => clearTimeout(t);
  }, [query]);

  const { data: dms } = useDmList(undefined, debouncedQuery);
  const { data: groups } = useDmGroupList(undefined, debouncedQuery);
  const mutedChannelIds = useMutedChannelIds();
  const { data: friends } = useFriendsList('accepted');

  const removeDmMute = useRemoveDmMute(undefined);
  const setVisibility = useSetDmVisibility(undefined);
  const leaveGroup = useLeaveGroupDm(undefined);
  const setMuteUntil = useSetDmMuteUntil(undefined);

  const [newOpen, setNewOpen] = useState(false);

  useNotificationPreferences();
  useDmCreated();
  const { getStatus } = useDmPresence();

  // 1:1 선택 채널 해석(라우트 :userId). 그룹은 channelId 가 라우트에 직접 있다.
  // 072-N1(적대 리뷰 MEDIUM): /dm/g(groupId 누락)는 React Router 가 /dm/:userId
  // 에 userId='g' 로 폴백 매칭 → by-user 가 비-UUID 로 400 → 무한 로딩. UUID 형태가
  // 아닌 routeUserId 는 무효로 보고 빈 상태로 떨어뜨린다.
  const validUserId =
    routeUserId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(routeUserId)
      ? routeUserId
      : undefined;
  const { data: byUser } = useDmByUser(undefined, validUserId);
  const createDm = useCreateOrGetDm(undefined);
  const selectedDirectChannelId = byUser?.channelId ?? null;

  // 072-N1(e2e 발견): createDm 폭주 가드. useMutation 객체는 매 렌더 새 정체성이라
  // effect deps 로 두면 by-user 가 channelId 로 해소되기 전까지 매 렌더 createOrGet 을
  // 재발사한다(idempotent 라 201 폭주 + createOrGet 이 hiddenAt 을 복원해 '숨기기'를
  // 무력화). userId 당 1회만 시도하도록 ref 로 고정한다(에러 시 해제·재시도 허용).
  const createAttemptedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!validUserId || selectedDirectChannelId || byUser === undefined) return;
    if (createAttemptedFor.current === validUserId) return;
    createAttemptedFor.current = validUserId;
    void createDm.mutateAsync({ userId: validUserId }).catch(() => {
      createAttemptedFor.current = null;
    });
  }, [validUserId, selectedDirectChannelId, byUser, createDm]);

  // 072-N1-1: 1:1 + 그룹 통합 정렬 행.
  const rows = useMemo(
    () => buildDmRows(dms?.items ?? [], groups?.items ?? [], me?.id),
    [dms, groups, me],
  );

  // 072-N1(리뷰 MEDIUM·critic): 열린 대화의 표시명이 검색어 입력으로 q-필터된
  // 목록에서 빠질 때 '…'/멤버명나열로 퇴화하지 않게, 본 적 있는 라벨을 누적 캐시한다
  // (u:userId→username, g:channelId→displayName). 검색 중에도 헤더/제목이 안정적.
  const labelCacheRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    for (const d of dms?.items ?? [])
      labelCacheRef.current.set(`u:${d.otherUserId}`, d.otherUsername);
    for (const g of groups?.items ?? []) {
      const dn = g.displayName?.trim();
      if (dn) labelCacheRef.current.set(`g:${g.channelId}`, dn);
    }
  }, [dms, groups]);

  const selectedFriend = useMemo(() => {
    if (!validUserId) return null;
    const fromFriends = (friends?.items ?? []).find((f) => f.otherUserId === validUserId);
    if (fromFriends) return { userId: validUserId, username: fromFriends.otherUsername };
    const fromDms = (dms?.items ?? []).find((d) => d.otherUserId === validUserId);
    if (fromDms) return { userId: validUserId, username: fromDms.otherUsername };
    // q-필터로 목록에서 빠진 비친구 DM 파트너 → 캐시된 마지막 username 사용.
    const cached = labelCacheRef.current.get(`u:${validUserId}`);
    return { userId: validUserId, username: cached ?? '' };
  }, [validUserId, friends, dms]);

  // 072-N1(적대 리뷰 HIGH): 열린 그룹을 q-필터/가시성-필터된 목록이 아니라 멤버
  // 엔드포인트로 독립 해석한다 — 검색 입력 중·숨긴 그룹 딥링크에도 대화가 사라지지
  // 않는다(1:1 의 useDmByUser 와 대칭). 목록 항목은 displayName 표시명에만 쓴다.
  const { data: groupMembers, isError: groupMembersError } = useDmGroupMembers(routeGroupId);
  const groupListEntry = useMemo(
    () => (routeGroupId ? (groups?.items ?? []).find((g) => g.channelId === routeGroupId) : null),
    [routeGroupId, groups],
  );
  const groupReady = !!routeGroupId && groupMembers !== undefined;

  // DM 작성자 이름 맵: 1:1 은 본인+상대, 그룹은 본인+전 참여자(멤버 엔드포인트).
  const extraNames = useMemo(() => {
    const m = new Map<string, string>();
    if (me?.id && me?.username) m.set(me.id, me.username);
    if (routeGroupId && groupMembers) {
      for (const p of groupMembers.items) m.set(p.userId, p.username);
    } else if (selectedFriend?.userId && selectedFriend.username) {
      m.set(selectedFriend.userId, selectedFriend.username);
    }
    return m;
  }, [me, selectedFriend, routeGroupId, groupMembers]);

  const groupTitle = useMemo(() => {
    // displayName 우선: 목록 항목 → (검색으로 빠졌으면) 캐시 → 멤버명 나열.
    const named =
      groupListEntry?.displayName?.trim() ||
      (routeGroupId ? labelCacheRef.current.get(`g:${routeGroupId}`) : undefined);
    if (named) return named;
    const others = (groupMembers?.items ?? [])
      .filter((p) => p.userId !== me?.id)
      .map((p) => p.username)
      .filter((u) => u.length > 0);
    return others.length > 0 ? others.join(', ') : '그룹 대화';
  }, [groupListEntry, groupMembers, me, routeGroupId]);

  const openRow = (row: UnifiedDmRow): void => {
    if (row.kind === 'group') navigate(`/dm/g/${row.channelId}`);
    else if (row.otherUserId) navigate(`/dm/${row.otherUserId}`);
  };

  const friendCandidates = (friends?.items ?? []).map((f) => ({
    otherUserId: f.otherUserId,
    otherUsername: f.otherUsername,
  }));

  // 072-N1(리뷰 critic): DM 행은 서버 q 로 필터되는데 친구 섹션은 안 돼 검색 중
  // 비일관(친구만 그대로 노출)이었다. 같은 검색어로 친구 섹션도 클라 필터한다.
  const friendNorm = query.trim().toLowerCase();
  const shownFriends = (friends?.items ?? []).filter(
    (f) => !friendNorm || f.otherUsername.toLowerCase().includes(friendNorm),
  );

  const nowMs = () => new Date().getTime();

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
              {/* 072-N1-2: 새 DM/그룹 생성 진입점. */}
              <button
                type="button"
                data-testid="dm-new-trigger"
                aria-label="새 메시지"
                onClick={() => setNewOpen(true)}
                className="qf-row-iconbtn ml-auto"
              >
                <Icon name="edit" size="sm" />
              </button>
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
              {rows.length > 0 ? (
                <div className="qf-section">
                  <div className="qf-section__title">대화 목록</div>
                </div>
              ) : null}
              {rows.map((row) => {
                const isActive =
                  row.kind === 'group'
                    ? row.channelId === routeGroupId
                    : row.otherUserId === routeUserId;
                return (
                  <DmUnifiedRow
                    key={row.channelId}
                    row={row}
                    meId={me?.id}
                    active={isActive}
                    muted={mutedChannelIds.has(row.channelId)}
                    status={row.otherUserId ? getStatus(row.otherUserId) : 'offline'}
                    onOpen={() => openRow(row)}
                    onHide={() => {
                      setVisibility.mutate({ channelId: row.channelId, visibility: 'HIDDEN' });
                      // 072-N1(리뷰 LOW): 열려있는 대화를 숨기면 우측 컬럼에 남지 않게 목록으로.
                      if (isActive) navigate('/dm');
                    }}
                    onLeave={() => {
                      leaveGroup.mutate(row.channelId);
                      if (isActive) navigate('/dm');
                    }}
                    onSetMuteUntil={(minutes) =>
                      setMuteUntil.mutate({
                        channelId: row.channelId,
                        mutedUntil: muteUntilIso(minutes, nowMs()),
                      })
                    }
                    onRemoveMute={() => removeDmMute.mutate(row.channelId)}
                  />
                );
              })}
              {shownFriends.length > 0 ? (
                <div className="qf-section">
                  <div className="qf-section__title">친구</div>
                </div>
              ) : null}
              {shownFriends.map((f) => (
                <button
                  key={f.otherUserId}
                  type="button"
                  data-testid={`dm-side-friend-${f.otherUsername}`}
                  onClick={() => navigate(`/dm/${f.otherUserId}`)}
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

      {/* 그룹 대화(채널 id 라우트) — 멤버 엔드포인트로 독립 해석. */}
      {routeGroupId && groupMembersError ? (
        // 비멤버 딥링크 등 멤버 조회 실패 → 무한 로딩 대신 not-found.
        <main className="qf-empty flex-1" data-testid="dm-shell-group-notfound">
          <div className="qf-empty__title">대화를 찾을 수 없습니다</div>
          <div className="qf-empty__body">이 그룹의 멤버가 아니거나 대화가 삭제되었습니다.</div>
        </main>
      ) : routeGroupId && groupReady ? (
        <MessageColumn
          workspaceId={null}
          workspaceSlug={null}
          channelId={routeGroupId}
          channelName={groupTitle}
          channelTopic={null}
          channelType="DIRECT"
          extraNames={extraNames}
        />
      ) : routeGroupId ? (
        <main className="qf-empty flex-1" data-testid="dm-shell-loading">
          <div className="qf-empty__title">대화를 준비 중…</div>
        </main>
      ) : validUserId && selectedDirectChannelId ? (
        <MessageColumn
          workspaceId={null}
          workspaceSlug={null}
          channelId={selectedDirectChannelId}
          channelName={selectedFriend?.username || '…'}
          channelTopic={null}
          channelType="DIRECT"
          extraNames={extraNames}
        />
      ) : validUserId ? (
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

      <NewConversationModal
        open={newOpen}
        onOpenChange={setNewOpen}
        candidates={friendCandidates}
        getStatus={getStatus}
        onCreated={(target) => {
          if (target.kind === 'direct') navigate(`/dm/${target.userId}`);
          else navigate(`/dm/g/${target.channelId}`);
        }}
      />
    </div>
  );
}
