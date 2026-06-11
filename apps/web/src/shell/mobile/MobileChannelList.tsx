import { useMemo, useRef, useState, type TouchEvent } from 'react';
import { Link } from 'react-router-dom';
import type { Workspace } from '@qufox/shared-types';
import { useChannelList } from '../../features/channels/useChannels';
// 071-M5 H18 (감사 B-63): 레일 멘션/미읽 뱃지 — 데스크톱 WorkspaceNav 정본 소스 재사용
// (badgeStore 우선 + unreadTotals 폴백, 뮤트 제외 서버 진실값 + 순수 파생 함수).
import { useWorkspaceUnreadTotals } from '../../features/workspaces/useUnreadTotals';
import { useBadgeStore } from '../../features/notifications/badgeStore';
import {
  deriveServerButtonBadge,
  serverButtonBadgeText,
  serverButtonBadgeAria,
  type ServerButtonBadge,
} from '../../features/workspaces/serverButtonBadge';
// H18: DM 슬롯 합계 — dmRowBadge 정본 규칙(FR-DM-15)을 DM 별 적용 후 합산.
import { useDmList } from '../../features/dms/useDms';
// 071-M3 F4 (FR-RS-18 모바일 / 감사 B-60): 모두 읽음 + Undo — 데스크톱 UnreadsView 정본.
import {
  useUnreadSummary,
  useMarkAllRead,
  useUndoMarkAllRead,
  // 071-M4 (FR-RS-09): 채널 단위 '읽음으로 표시' — 데스크톱 우클릭 메뉴 동등.
  useMarkChannelRead,
} from '../../features/channels/useUnread';
import { useNotifications } from '../../stores/notification-store';
// 071-M3 F5: 채널 롱프레스 시트(뮤트) — 뮤트 상태 표시/배지 억제 포함.
import {
  useMutedChannelIds,
  useSetChannelMute,
  useRemoveChannelMute,
  type MuteDurationKey,
} from '../../features/channels/useMutes';
import { MobileChannelSheet } from './MobileChannelSheet';
import { PANEL_EDGE_PX } from './MobilePanels';
import { Icon, Avatar } from '../../design-system/primitives';
import { cn } from '../../lib/cn';

/**
 * Mobile left drawer content (task-026-G DS parity applied): workspace
 * selector (small avatar rail), qf-m-search for filter, qf-m-section
 * per category with __action slot, qf-m-row rows with __primary /
 * __secondary / __aside / __time / --unread.
 */
export function MobileChannelList({
  workspace,
  workspaces,
  activeChannelName,
  onPick,
  onBrowse,
  onMenu,
}: {
  workspace: Pick<Workspace, 'id' | 'name' | 'slug'>;
  workspaces: Pick<Workspace, 'id' | 'name' | 'slug'>[];
  activeChannelName: string | null;
  onPick: () => void;
  /** 071-M2 E5 (FR-IA-MOB-03): server-header 의 + 액션 — 채널 둘러보기 오픈. */
  onBrowse?: () => void;
  /** 071-M3 F2: server-header 본체 탭 — 서버 메뉴 시트 오픈(DS 의도). */
  onMenu?: () => void;
}): JSX.Element {
  const { data } = useChannelList(workspace.id);
  const { data: unread } = useUnreadSummary(workspace.id);
  const markAllMut = useMarkAllRead(workspace.id);
  const undoMut = useUndoMarkAllRead(workspace.id);
  const markOneRead = useMarkChannelRead(workspace.id);
  const notify = useNotifications((st) => st.push);
  // F4: UnreadsView.onMarkAll 정본 복제 — 0건 가드·8s Undo 토스트.
  const onMarkAll = (): void => {
    markAllMut.mutate(undefined, {
      onSuccess: (res) => {
        if (!res || res.channelsRead === 0) return;
        notify({
          variant: 'info',
          title: '모든 채널을 읽음 처리했어요',
          body: `${res.channelsRead}개 채널`,
          ttlMs: 8000,
          action: { label: '실행 취소', onClick: () => undoMut.mutate(res.snapshotId) },
        });
      },
    });
  };
  const [filter, setFilter] = useState('');
  // F5: 뮤트 상태/뮤테이션 + 롱프레스 시트 대상.
  const mutedIds = useMutedChannelIds();
  const setMute = useSetChannelMute();
  const removeMute = useRemoveChannelMute();
  const [sheetChannel, setSheetChannel] = useState<{ id: string; name: string } | null>(null);
  // 071-M5 H18 (감사 B-63): 워크스페이스 레일 뱃지 소스 — WorkspaceNav 와 동일하게
  // badgeStore 항목이 있으면(연결 후 재동기화) 그 값을, 없으면 unreadTotals 폴백.
  // 진행 노트: 탭바는 인박스 합계 단일 임계(PRD M4 FR-MN-14 '현 구현' 명문화)라 B-45
  // 슬라이스 합류 전까지 레일의 멘션/미읽 분리 신호와 의미 체계가 일시 공존한다.
  const { data: totals } = useWorkspaceUnreadTotals();
  const badgeByWs = useBadgeStore((s) => s.byWorkspace);
  const unreadByWs = useMemo(() => {
    const m = new Map<string, { unreadCount: number; mentionCount: number }>();
    for (const t of totals ?? [])
      m.set(t.workspaceId, { unreadCount: t.unreadCount, mentionCount: t.mentionCount });
    for (const [wsId, b] of Object.entries(badgeByWs))
      m.set(wsId, { unreadCount: b.unreadCount, mentionCount: b.mentionCount });
    return m;
  }, [totals, badgeByWs]);
  // H18: DM 슬롯 합계 — 비뮤트 DM 은 unread, 멘션은 뮤트 바이패스(FR-RS-05/FR-DM-15
  // 정본 규칙과 동일 의미)로 합산해 deriveServerButtonBadge 에 흘린다.
  const { data: dms } = useDmList(undefined);
  const dmBadge = useMemo(() => {
    let unreadSum = 0;
    let mentionSum = 0;
    for (const d of dms?.items ?? []) {
      mentionSum += d.mentionCount ?? 0;
      if (!mutedIds.has(d.channelId)) unreadSum += d.unreadCount;
    }
    return deriveServerButtonBadge({ unreadCount: unreadSum, mentionCount: mentionSum });
  }, [dms, mutedIds]);
  const dmBadgeAria = serverButtonBadgeAria(dmBadge);
  const dmAriaLabel = dmBadgeAria ? `다이렉트 메시지, ${dmBadgeAria}` : undefined;
  const unreadByChannel = new Map<string, { count: number; mention: boolean }>();
  for (const u of unread?.channels ?? []) {
    unreadByChannel.set(u.channelId, { count: u.unreadCount, mention: u.hasMention });
  }

  const uncategorized = data?.uncategorized ?? [];
  const categories = data?.categories ?? [];
  const norm = filter.trim().toLowerCase();
  const match = (name: string): boolean => !norm || name.toLowerCase().includes(norm);

  return (
    <div>
      {/* 071-M2 E5: DS server-header — 서버명 + 채널 탐색 액션(FR-IA-MOB-03).
          서버 메뉴 시트(초대/설정 등)는 M3 도달성에서 확장. */}
      <div className="qf-m-server-header" data-testid="mobile-server-header">
        {onMenu ? (
          // F2: 헤더 본체(서버명+chevron)를 버튼화 — 탭하면 서버 메뉴 시트.
          <button
            type="button"
            data-testid="mobile-server-menu-trigger"
            className="flex min-w-0 flex-1 items-center gap-[var(--s-2)] bg-transparent text-left"
            aria-haspopup="dialog"
            onClick={onMenu}
          >
            <span className="qf-m-server-header__name">{workspace.name}</span>
            <span className="qf-m-server-header__chevron" aria-hidden>
              <Icon name="chevron-down" size="sm" />
            </span>
          </button>
        ) : (
          <span className="qf-m-server-header__name">{workspace.name}</span>
        )}
        {onBrowse ? (
          <button
            type="button"
            data-testid="mobile-server-browse"
            aria-label="채널 둘러보기"
            className="qf-m-server-header__action"
            onClick={onBrowse}
          >
            <Icon name="plus-circle" size="md" />
          </button>
        ) : null}
      </div>

      {/* 071-M2 E4 (A안): 서버레일은 항상 렌더 — DM 인박스 슬롯 + 워크스페이스들.
          홈 오버레이 모델 폐기 후 DM 진입점은 좌패널 레일의 DM 슬롯이 담당한다
          (PRD: DM 인박스 = '채팅' 탭의 워크스페이스-외 컨텍스트). */}
      <nav
        aria-label="워크스페이스 선택"
        className="px-[var(--s-4)] py-[var(--s-2)] flex gap-[var(--s-2)] overflow-x-auto"
      >
        <Link
          to="/dms"
          onClick={onPick}
          className="inline-flex flex-col items-center gap-1 p-1 rounded-[var(--r-md)]"
          data-testid="mobile-rail-dms"
          // H18 a11y(WorkspaceNav S22 review #2 정본): 뱃지 수치를 접근명에 합성하고
          // 뱃지 span 은 aria-hidden — 중복 통지 방지.
          aria-label={dmAriaLabel}
        >
          <span className="relative">
            <span className="qf-avatar qf-avatar--sm grid place-items-center bg-bg-subtle">
              <Icon name="message" size="sm" />
            </span>
            <RailBadge badge={dmBadge} testId="mobile-rail-dms-badge" />
          </span>
          <span
            style={{ maxWidth: 'var(--s-10)' }}
            className="text-[length:var(--fs-11)] text-text-muted truncate"
          >
            DM
          </span>
        </Link>
        <Link
          to="/w/new"
          onClick={onPick}
          className="inline-flex flex-col items-center gap-1 p-1 rounded-[var(--r-md)]"
          data-testid="mobile-rail-new-ws"
          aria-label="워크스페이스 만들기"
        >
          <span className="qf-avatar qf-avatar--sm grid place-items-center bg-bg-subtle">
            <Icon name="plus" size="sm" />
          </span>
          <span
            style={{ maxWidth: 'var(--s-10)' }}
            className="text-[length:var(--fs-11)] text-text-muted truncate"
          >
            추가
          </span>
        </Link>
        {workspaces.map((w) => {
          // H18 (감사 B-63): WorkspaceNav 정본 파생 — 멘션 합산>0 → mention 뱃지(숫자=멘션 수),
          // 아니면 일반 unread count 뱃지.
          const u = unreadByWs.get(w.id);
          const badge = deriveServerButtonBadge({
            unreadCount: u?.unreadCount ?? 0,
            mentionCount: u?.mentionCount ?? 0,
          });
          const badgeAria = serverButtonBadgeAria(badge);
          return (
            <Link
              key={w.id}
              to={`/w/${w.slug}`}
              onClick={onPick}
              className={cn(
                'inline-flex flex-col items-center gap-1 p-1 rounded-[var(--r-md)]',
                w.slug === workspace.slug ? 'bg-bg-accent' : '',
              )}
              data-testid={`mobile-ws-${w.slug}`}
              aria-label={badgeAria ? `${w.name}, ${badgeAria}` : undefined}
            >
              <span className="relative">
                <Avatar name={w.name} size="sm" />
                <RailBadge badge={badge} testId={`mobile-ws-badge-${w.slug}`} />
              </span>
              <span
                style={{ maxWidth: 'var(--s-10)' }}
                className="text-[length:var(--fs-11)] text-text-muted truncate"
              >
                {w.name}
              </span>
            </Link>
          );
        })}
      </nav>

      {/* 071-M3 F4: 채널 섹션 헤더 + 모두 읽음 액션. */}
      <div className="qf-m-section flex items-center justify-between">
        <div>채널</div>
        <button
          type="button"
          data-testid="mobile-mark-all-read"
          className="qf-m-section__action"
          disabled={markAllMut.isPending}
          aria-busy={markAllMut.isPending}
          onClick={onMarkAll}
        >
          모두 읽음
        </button>
      </div>

      {/* qf-m-search filter */}
      <div className="px-[var(--s-4)] pb-[var(--s-2)]">
        <div className="qf-m-search" data-testid="mobile-channel-search">
          <Icon name="search" size="sm" />
          <input
            type="search"
            className="qf-m-search__input"
            aria-label="채널 검색"
            placeholder="채널 검색"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            data-testid="mobile-channel-search-input"
          />
        </div>
      </div>

      {uncategorized.length > 0 ? (
        <>
          <div className="qf-m-section">
            <div>채널</div>
          </div>
          <ul role="list">
            {uncategorized
              .filter((c) => match(c.name))
              .map((c) => (
                <ChannelRow
                  key={c.id}
                  slug={workspace.slug}
                  name={c.name}
                  active={c.name === activeChannelName}
                  unread={unreadByChannel.get(c.id)}
                  muted={mutedIds.has(c.id)}
                  onPick={onPick}
                  onLongPress={() => setSheetChannel({ id: c.id, name: c.name })}
                />
              ))}
          </ul>
        </>
      ) : null}

      {categories.map((cat) => {
        const filtered = cat.channels.filter((c) => match(c.name));
        if (filtered.length === 0 && norm) return null;
        return (
          <div key={cat.id}>
            <div className="qf-m-section">
              <div>{cat.name}</div>
            </div>
            <ul role="list">
              {filtered.map((c) => (
                <ChannelRow
                  key={c.id}
                  slug={workspace.slug}
                  name={c.name}
                  active={c.name === activeChannelName}
                  unread={unreadByChannel.get(c.id)}
                  muted={mutedIds.has(c.id)}
                  onPick={onPick}
                  onLongPress={() => setSheetChannel({ id: c.id, name: c.name })}
                />
              ))}
            </ul>
          </div>
        );
      })}

      {/* F5: 채널 롱프레스 시트 — 뮤트 6종/해제 + M4 '읽음으로 표시'(FR-RS-09). */}
      {sheetChannel ? (
        <MobileChannelSheet
          channelName={sheetChannel.name}
          muted={mutedIds.has(sheetChannel.id)}
          hasUnread={(unreadByChannel.get(sheetChannel.id)?.count ?? 0) > 0}
          onClose={() => setSheetChannel(null)}
          onMute={(duration: MuteDurationKey) => {
            setMute.mutate({ channelId: sheetChannel.id, duration });
            setSheetChannel(null);
          }}
          onUnmute={() => {
            removeMute.mutate(sheetChannel.id);
            setSheetChannel(null);
          }}
          onMarkRead={() => {
            markOneRead.mutate(sheetChannel.id);
            setSheetChannel(null);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * 071-M5 H18 (감사 B-63): 레일 아바타 우상단 오버레이 뱃지. 의미 분리는 ChannelRow 뱃지와
 * 동일 — 멘션은 danger 토큰 배경(--badge-mention-bg), 일반 미읽음은 기본 count 뱃지
 * (violet). 접근명은 부모 Link aria-label 에 합성하므로 뱃지 자체는 aria-hidden
 * (데스크톱 WorkspaceNav a11y S22 review #2 정본).
 */
function RailBadge({
  badge,
  testId,
}: {
  badge: ServerButtonBadge;
  testId: string;
}): JSX.Element | null {
  if (badge.variant === 'none') return null;
  return (
    <span
      className="qf-badge qf-badge--count absolute -right-1 -top-1"
      style={badge.variant === 'mention' ? { background: 'var(--badge-mention-bg)' } : undefined}
      data-testid={testId}
      data-variant={badge.variant}
      aria-hidden="true"
    >
      {serverButtonBadgeText(badge.count)}
    </span>
  );
}

function ChannelRow({
  slug,
  name,
  active,
  unread,
  muted = false,
  onPick,
  onLongPress,
}: {
  slug: string;
  name: string;
  active: boolean;
  unread?: { count: number; mention: boolean };
  /** F5: 활성 뮤트 — bell-off + 흐림 + 미읽음 강조/배지 억제(감사 B-12). */
  muted?: boolean;
  onPick: () => void;
  /** F5: 롱프레스(500ms) — 채널 옵션 시트. */
  onLongPress?: () => void;
}): JSX.Element {
  // F5: 뮤트 채널은 미읽음 강조를 억제한다(데스크톱 showUnreadStyle 규칙).
  const hasUnread = (unread?.count ?? 0) > 0 && !muted;
  // ★F11 리뷰 H-3 (FR-RS-05): 멘션 배지는 뮤트를 바이패스한다 — 데스크톱 정본
  // (sidebarRowState.deriveSidebarRowState)은 mute 가 행 스타일만 억제하고
  // mentionBadgeCount 는 뮤트와 무관하게 유지한다. 배지 게이트를 분리.
  const showBadge = (unread?.count ?? 0) > 0 && (!muted || unread?.mention === true);
  // F5: 롱프레스 — Link 행이라 touchend 의 합성 click 이 내비게이션을 발화한다.
  // 발화 시 suppress 플래그로 onClick 을 preventDefault 한다(메시지 행 div 와
  // 다른 점). 좌 엣지 시작은 패널 제스처에 양보(PANEL_EDGE_PX).
  const pressTimer = useRef<number | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickRef = useRef(false);
  const clearPress = (): void => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    pressTimer.current = null;
    startRef.current = null;
  };
  const onTouchStart = (e: TouchEvent): void => {
    if (!onLongPress) return;
    // ★F11 리뷰 H-1: stale suppress 해제는 엣지 양보(early-return)보다 먼저 —
    // 좌측 엣지에서 시작한 다음 탭이 직전 롱프레스의 suppress 에 삼켜지지 않게.
    suppressClickRef.current = false;
    const t = e.touches[0];
    if (t.clientX <= PANEL_EDGE_PX) return;
    startRef.current = { x: t.clientX, y: t.clientY };
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      suppressClickRef.current = true;
      onLongPress();
    }, 500);
  };
  const onTouchMove = (e: TouchEvent): void => {
    if (!startRef.current) return;
    const t = e.touches[0];
    if (
      Math.abs(t.clientX - startRef.current.x) > 8 ||
      Math.abs(t.clientY - startRef.current.y) > 8
    ) {
      clearPress();
    }
  };
  return (
    <li>
      <Link
        to={`/w/${slug}/${name}`}
        onClick={(e) => {
          // 롱프레스가 발화했으면 합성 click 의 내비게이션을 막는다.
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            e.preventDefault();
            return;
          }
          onPick();
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={clearPress}
        onTouchCancel={() => {
          // ★F11 리뷰 H-1: touchcancel 뒤엔 합성 click 이 오지 않는다 — suppress
          // 를 여기서 풀지 않으면 다음 정상 탭이 한 번 조용히 삼켜진다.
          clearPress();
          suppressClickRef.current = false;
        }}
        onContextMenu={(e) => {
          // ★F11 리뷰 H-1: Android Chrome 은 anchor 롱프레스에 네이티브 링크
          // 컨텍스트 메뉴를 띄운다(WebkitTouchCallout 은 iOS 전용) — 뮤트 시트와
          // 겹치거나 시트 자체를 막으므로 차단한다.
          if (onLongPress) e.preventDefault();
        }}
        style={{ WebkitTouchCallout: 'none' } as React.CSSProperties}
        aria-selected={active || undefined}
        data-testid={`mobile-channel-${name}`}
        data-muted={muted ? 'true' : undefined}
        className={cn(
          'qf-m-row',
          hasUnread && !active && 'qf-m-row--unread',
          muted && 'text-text-muted',
        )}
      >
        <Icon name={muted ? 'bell-off' : 'hash'} size="sm" className="text-text-muted" />
        <div className="min-w-0 flex-1">
          <div className="qf-m-row__primary">{name}</div>
        </div>
        <div className="qf-m-row__aside">
          {showBadge ? (
            // 071-M2 E5 (감사 B-43): 뱃지 의미 분리 — 멘션은 danger 토큰 배경
            // (--badge-mention-bg), 일반 미읽음은 기본 count 뱃지(violet).
            <span
              className="qf-badge qf-badge--count"
              style={unread?.mention ? { background: 'var(--badge-mention-bg)' } : undefined}
              data-testid={unread?.mention ? 'mobile-unread-mention' : 'mobile-unread'}
            >
              {unread!.count > 99 ? '99+' : unread!.count}
            </span>
          ) : null}
        </div>
      </Link>
    </li>
  );
}
