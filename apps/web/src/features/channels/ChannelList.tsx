import { Link } from 'react-router-dom';
import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { arrayMove, SortableContext, useSortable } from '@dnd-kit/sortable';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Channel } from '@qufox/shared-types';
import { useChannelList, useMoveCategory, useMoveChannel } from './useChannels';
import { useUnreadSummary, useMarkChannelRead } from './useUnread';
import {
  useMutedChannelIds,
  useRemoveChannelMute,
  useSetChannelMute,
  type MuteDurationKey,
} from './useMutes';
import { useAddFavorite, useFavoriteChannelIds, useRemoveFavorite } from './useFavorites';
import { deriveSidebarRowState } from './sidebarRowState';
import { isCategoryCollapsed, setCategoryCollapsed } from './categoryCollapse';
import { isContextMenuKey } from './unreadsA11y';
import { FavoritesSection } from './FavoritesSection';
import { SidebarSections } from './SidebarSections';
import { useAssignedChannelIds, useCreateSidebarSection } from './useSidebarSections';
import { CreateChannelModal } from './CreateChannelModal';
import {
  Icon,
  DropdownRoot,
  DropdownTrigger,
  DropdownContent,
  DropdownItem,
  DropdownSeparator,
  Dialog,
} from '../../design-system/primitives';
import { ChannelNotifSettings } from '../notifications/ChannelNotifSettings';
import { useGlobalNotificationSettings } from '../notifications/useNotifLevels';
import { cn } from '../../lib/cn';

type Props = {
  workspaceId: string;
  workspaceSlug: string;
  canManage: boolean;
  activeChannelName: string | null;
};

/**
 * Discord-style channel list (task-020).
 *
 * - Uncategorized channels live under a synthesized "채널" group at the
 *   top. Treated like a category for drop + `+` button purposes but
 *   NOT draggable (always first, `categoryId: null` at the API edge).
 * - Every section header (default + real categories) has a right-
 *   aligned `+` that opens the channel-create modal scoped to that
 *   section's categoryId.
 * - Category creation moved to the workspace dropdown (see
 *   ChannelColumn) — no bottom + button here any more.
 *
 * Drag-and-drop (task-020-follow, user request 2026-04-21):
 * 1. Channels / categories drag within + across sections.
 * 2. Permission gate: when canManage=false, useSortable/useDroppable
 *    are `disabled` so a drag literally can't start. No handle, no
 *    hover styling, no API noise.
 * 3. Visual feedback unified as a **thin insertion-line** (splitter)
 *    shown at the drop point instead of ring/background/pre-shuffle.
 *    - `dragOverId` (DndContext.onDragOver) tracks the current target.
 *    - Strategy is `() => null` so siblings don't pre-shuffle.
 *    - Active row's transform is discarded so it stays dimmed in
 *      place — the line is the only motion.
 *    - Line above a channel row → insert before that row.
 *    - Line below a section body → drop at the end of the section
 *      (cross-section move / empty category).
 * 4. Categories drag-reorder via POST /categories/:id/move. Default
 *    "채널" is always first and not part of the sortable list.
 *
 * `active.data.current.type` distinguishes 'channel' vs 'category' so
 * drag-end routes to the correct mutation.
 */

const ROOT_CATEGORY_ID = '__root__';

function MentionBadge({ count }: { count: number }): JSX.Element | null {
  if (count <= 0) return null;
  // S22 (FR-RS-04): 행 우측 멘션 숫자 뱃지. DS `qf-badge qf-badge--count`
  // (신규 클래스 도입 없음). unread bold/pill 은 행 컨테이너(qf-channel--unread)
  // 가 담당하고, 이 뱃지는 **멘션 건수**만 표기한다(2계층의 두 번째 계층).
  return (
    <span
      data-testid="unread-pill-mention"
      aria-label={`읽지 않은 멘션 ${count}개`}
      className="qf-badge qf-badge--count"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

function DropLine(): JSX.Element {
  return <div data-testid="dnd-dropline" aria-hidden="true" className="qf-dropline" />;
}

// S43 (FR-CH-17): 뮤트 지속시간 선택지(PRD 정본 순서). 컨텍스트 메뉴에 평탄
// 항목으로 펼친다(신규 DS 서브메뉴 primitive 도입 없이 기존 qf-menu 재사용).
// a11y BLOCKER-4: 시각상 그룹 헤더("채널 뮤트")가 항목과 분리돼 SR 이 맥락을
// 잃으므로, 각 항목에 "뮤트 N" 형태의 ariaLabel 을 부여해 항목 단독으로도
// 의미가 통하게 한다(무기한은 "무기한 뮤트").
// 071-M3 F5: 모바일 채널 시트가 동일 선택지를 재사용한다(export — 단일 출처).
export const MUTE_DURATIONS: ReadonlyArray<{
  key: MuteDurationKey;
  label: string;
  ariaLabel: string;
}> = [
  { key: '15m', label: '15분', ariaLabel: '뮤트 15분' },
  { key: '1h', label: '1시간', ariaLabel: '뮤트 1시간' },
  { key: '3h', label: '3시간', ariaLabel: '뮤트 3시간' },
  { key: '8h', label: '8시간', ariaLabel: '뮤트 8시간' },
  { key: '24h', label: '24시간', ariaLabel: '뮤트 24시간' },
  { key: 'forever', label: '무기한', ariaLabel: '무기한 뮤트' },
];

// S43 (FR-CH-14): 접기/펼치기 화살표. chevron-down 아이콘을 collapsed 면 -90도
// 회전시킨다. DS 모션 토큰(--dur-fast/--ease-standard)을 arbitrary class 로 참조해
// raw 값 없이 전환한다. aria-hidden — 상태는 헤더 버튼의 aria-expanded 가 전한다.
function CollapseArrow({ collapsed }: { collapsed: boolean }): JSX.Element {
  return (
    <Icon
      name="chevron-down"
      size="sm"
      aria-hidden
      className={cn(
        'qf-icon--muted shrink-0 transition-transform [transition-duration:var(--dur-fast)] [transition-timing-function:var(--ease-standard)]',
        collapsed && '-rotate-90',
      )}
    />
  );
}

function DraggableChannelRow({
  channel,
  workspaceId,
  workspaceSlug,
  active,
  showUnreadStyle,
  mentionBadgeCount,
  muted,
  isFavorite,
  canManage,
  isDropTarget,
  hasUnread,
  globalDesktop,
  globalMobile,
  onMarkRead,
  onToggleFavorite,
  onSetMute,
  onRemoveMute,
  draggable = true,
}: {
  channel: Channel;
  // S87 (FR-MN-18): 채널 알림 설정 모달에 워크스페이스 스코프를 전달하기 위한 wsId.
  // 워크스페이스 채널일 때만 존재(undefined 면 알림 설정 항목 비노출).
  workspaceId?: string;
  workspaceSlug: string;
  active: boolean;
  showUnreadStyle: boolean;
  mentionBadgeCount: number;
  // S43 (FR-CH-17): 뮤트 상태 — 회색 표시 + bell-off 아이콘 + 메뉴 해제 항목.
  muted: boolean;
  // S43 (FR-CH-15): 즐겨찾기 여부 — 컨텍스트 메뉴 토글 라벨 결정.
  isFavorite: boolean;
  canManage: boolean;
  isDropTarget: boolean;
  // S24 (FR-RS-09): 우클릭 컨텍스트 메뉴 "읽음으로 표시" 노출 여부 + 핸들러.
  hasUnread: boolean;
  // S87 (FR-MN-18): 글로벌 push 설정(채널 알림 모달의 상속 effective 표시용).
  globalDesktop?: boolean;
  globalMobile?: boolean;
  onMarkRead: (channelId: string) => void;
  onToggleFavorite: (channelId: string, isFavorite: boolean) => void;
  onSetMute: (channelId: string, duration: MuteDurationKey) => void;
  onRemoveMute: (channelId: string) => void;
  // S43 (FR-CH-15): 즐겨찾기 섹션 행은 채널 reorder useSortable 을 쓰지 않으므로
  // 채널 드래그 핸들/리스너를 끈다(즐겨찾기 재정렬은 섹션이 자체 DnD 로 담당).
  draggable?: boolean;
}): JSX.Element {
  // S24 (FR-RS-09): 채널 우클릭 컨텍스트 메뉴. 신규 라이브러리 도입 없이 기존
  // Radix DropdownMenu(DS qf-menu 클래스)를 controlled 로 쓰고, 행의
  // onContextMenu 가 메뉴를 연다(트리거는 행 안의 0-size 앵커).
  const [menuOpen, setMenuOpen] = useState(false);
  // S87 (FR-MN-18): 채널 알림(데스크톱/모바일 push) 설정 모달 열림 상태. 메뉴의
  // "알림 설정" 항목이 연다. role="switch" 컨트롤을 메뉴 안에 직접 넣으면 Radix
  // 메뉴의 roving/typeahead 와 충돌하므로, 별도 DS Dialog 로 분리해 회귀를 막는다.
  const [notifOpen, setNotifOpen] = useState(false);
  // user request 2026-04-21:
  //  - `disabled: !canManage` stops the sortable from reacting to
  //    pointer events for non-managers (no drag starts at all).
  //  - Drag handle removed; listeners now spread on the whole row.
  //    PointerSensor `activationConstraint: { distance: 4 }` (set
  //    on the outer DndContext) ensures a plain click still routes
  //    to the <Link> for navigation.
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({
    id: channel.id,
    data: { type: 'channel', channelId: channel.id, categoryId: channel.categoryId },
    // S43 (FR-CH-15): 즐겨찾기 섹션(draggable=false)에서는 채널 reorder 드래그를
    // 끈다 — 즐겨찾기 순서는 섹션이 별도 DnD 로 관리한다.
    disabled: !canManage || !draggable,
  });
  const dragEnabled = canManage && draggable;
  // Sibling pre-shuffle is disabled via the parent SortableContext
  // strategy (() => null). Active row keeps its place but dims; the
  // dropline alone indicates the insertion point.
  const style = {
    opacity: isDragging ? 0.4 : 1,
  };
  return (
    <>
      {isDropTarget ? <DropLine /> : null}
      <li
        ref={setNodeRef}
        {...(dragEnabled ? { ...attributes, ...listeners } : {})}
        style={style}
        // a11y(S22 review #4): `aria-selected` 는 listitem role 에 비허용 속성
        // → `aria-current="page"` 로 교정. DS 의 활성 배경 셀렉터
        // (`.qf-channel[aria-selected="true"]`)는 DS 4파일이라 못 고치므로,
        // 활성 시각표시(배경/글자색)는 DS 토큰을 참조하는 arbitrary 클래스로
        // 직접 보강해 회귀를 막는다(raw hex/px 금지, var() 토큰만 사용).
        aria-current={active ? 'page' : undefined}
        data-active={active ? 'true' : undefined}
        onContextMenu={(e) => {
          // S24 (FR-RS-09): 우클릭 → 컨텍스트 메뉴 오픈(브라우저 기본 메뉴 차단).
          e.preventDefault();
          setMenuOpen(true);
        }}
        onKeyDown={(e) => {
          // a11y BLOCKER #4: 키보드 컨텍스트 메뉴. ContextMenu 키 또는 Shift+F10 으로
          // 마우스 우클릭과 동일하게 메뉴를 연다(키보드 사용자 배제 해소). Radix 가
          // 포커스/Esc/방향키를 담당하므로 여기서는 open 만 트리거한다.
          if (isContextMenuKey(e)) {
            e.preventDefault();
            setMenuOpen(true);
          }
        }}
        className={cn(
          'qf-channel group relative',
          active && 'bg-[var(--bg-selected)] text-[var(--text-strong)]',
          // S22 (FR-RS-04/05): 비뮤트 + unread 일 때만 bold + 좌측 pill.
          // 뮤트 채널은 showUnreadStyle=false 로 억제된다(FR-RS-05).
          showUnreadStyle && !active && 'qf-channel--unread',
          // S43 (FR-CH-17): 뮤트 채널은 회색 표시(텍스트를 --text-muted 토큰으로
          // 눌러 비활성감을 준다). 활성 채널은 가독성을 위해 회색 처리 제외.
          muted && !active && 'text-[color:var(--text-muted)]',
          isDragging ? 'cursor-grabbing' : dragEnabled ? 'cursor-grab' : 'cursor-pointer',
        )}
        data-testid={`channel-${channel.name}`}
        data-unread={showUnreadStyle ? 'true' : 'false'}
        data-mention={mentionBadgeCount > 0 ? 'true' : 'false'}
        data-muted={muted ? 'true' : 'false'}
      >
        {/* Full-row navigation overlay. Renders as absolute(inset:0) so
            the entire hover-highlighted rectangle is the click target —
            users shouldn't have to aim at the text. The prefix + name
            are marked pointer-events-none so clicks fall through; the
            suffix (settings button + unread pill) is raised above the
            overlay with z-10 + pointer-events-auto so its own
            interactive children still receive pointer events. */}
        <Link
          to={`/w/${workspaceSlug}/${channel.name}`}
          tabIndex={-1}
          aria-label={`# ${channel.name} 채널 열기`}
          className="absolute inset-0"
        />
        {/* 072-N3-4 (FR-CH prefix): 비공개→lock · 공지→megaphone · 그 외→#. */}
        <span className="qf-channel__prefix pointer-events-none relative flex items-center">
          {channel.isPrivate ? (
            <Icon name="lock" size="sm" aria-hidden />
          ) : channel.type === 'ANNOUNCEMENT' ? (
            <Icon name="megaphone" size="sm" aria-hidden />
          ) : (
            '#'
          )}
        </span>
        <span className="pointer-events-none relative flex-1 truncate">&nbsp;{channel.name}</span>
        <span className="qf-channel__suffix pointer-events-auto relative z-10">
          {canManage ? (
            <Link
              to={`/w/${workspaceSlug}/${channel.name}/settings`}
              data-testid={`channel-settings-btn-${channel.name}`}
              aria-label={`# ${channel.name} 설정`}
              title="채널 설정"
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              className={cn(
                'qf-row-iconbtn',
                'transition-opacity',
                active
                  ? 'opacity-100'
                  : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
              )}
            >
              <Icon name="settings" size="sm" />
            </Link>
          ) : null}
          {/* S43 (FR-CH-17): 뮤트 채널 표식 — bell-off 아이콘(icons.svg 보유).
              aria-label 로 SR 에 뮤트 상태를 알린다. */}
          {muted ? (
            <Icon
              name="bell-off"
              size="sm"
              aria-label="뮤트됨"
              data-testid={`channel-muted-${channel.name}`}
              className="qf-icon--muted relative shrink-0"
            />
          ) : null}
          <MentionBadge count={mentionBadgeCount} />
          {/* a11y BLOCKER #4: 키보드 접근 가능한 정식 "채널 옵션" 더보기 버튼을
              DropdownTrigger 로 둔다(종전 0-size aria-hidden 앵커 = 키보드 배제
              제거). Tab 으로 포커스 가능하고, 행 onContextMenu/Shift+F10 도 같은
              controlled Dropdown 을 연다. Radix 가 role/포커스/Esc 를 담당한다. */}
          <DropdownRoot open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownTrigger asChild>
              <button
                type="button"
                data-testid={`channel-ctx-trigger-${channel.name}`}
                aria-label="채널 옵션"
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                className={cn(
                  'qf-row-iconbtn',
                  'transition-opacity',
                  active || menuOpen
                    ? 'opacity-100'
                    : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                )}
              >
                <Icon name="more" size="sm" />
              </button>
            </DropdownTrigger>
            <DropdownContent align="start">
              <DropdownItem
                disabled={!hasUnread}
                onSelect={() => {
                  if (hasUnread) onMarkRead(channel.id);
                }}
              >
                <span data-testid={`channel-mark-read-${channel.name}`}>읽음으로 표시</span>
              </DropdownItem>
              <DropdownSeparator />
              {/* S43 (FR-CH-15): 즐겨찾기 추가/해제 토글. */}
              <DropdownItem onSelect={() => onToggleFavorite(channel.id, isFavorite)}>
                <span data-testid={`channel-favorite-toggle-${channel.name}`}>
                  {isFavorite ? '즐겨찾기 해제' : '즐겨찾기 추가'}
                </span>
              </DropdownItem>
              {/* S87 (FR-MN-18): 채널별 데스크톱/모바일 push 알림 설정 진입점. 워크스페이스
                  채널(wsId 존재)만 노출한다 — DM/전역 채널은 워크스페이스 스코프 prefs 가
                  없다. 항목 선택 시 메뉴를 닫고 별도 DS Dialog 로 토글 UI 를 연다(메뉴
                  안에 switch 를 직접 두지 않아 roving/typeahead 회귀를 막는다). */}
              {workspaceId ? (
                <DropdownItem onSelect={() => setNotifOpen(true)} preventDefault={false}>
                  <span data-testid={`channel-notif-settings-open-${channel.name}`}>알림 설정</span>
                </DropdownItem>
              ) : null}
              <DropdownSeparator />
              {/* S43 (FR-CH-17): 채널 뮤트 — duration 평탄 항목 + 해제(현재 뮤트 시).
                  신규 서브메뉴 primitive 없이 기존 qf-menu 항목을 그대로 쓴다. */}
              {muted ? (
                <DropdownItem onSelect={() => onRemoveMute(channel.id)}>
                  <span data-testid={`channel-unmute-${channel.name}`}>뮤트 해제</span>
                </DropdownItem>
              ) : (
                <>
                  {/* a11y BLOCKER-4 + DS MED: 그룹 헤더는 시각적으로 약하게(매직넘버
                      opacity-50 제거 → DS --text-muted 토큰) 표시하되, 각 duration
                      항목 자체에 aria-label("뮤트 15분" 등)을 붙여 SR 이 "무엇의
                      선택지"인지 항목 단독으로도 알 수 있게 한다(헤더는 aria-hidden). */}
                  <div
                    className="qf-menu__item text-[color:var(--text-muted)]"
                    aria-hidden
                    role="presentation"
                  >
                    채널 뮤트
                  </div>
                  {MUTE_DURATIONS.map((d) => (
                    <DropdownItem key={d.key} onSelect={() => onSetMute(channel.id, d.key)}>
                      <span
                        data-testid={`channel-mute-${d.key}-${channel.name}`}
                        aria-label={d.ariaLabel}
                      >
                        {d.label}
                      </span>
                    </DropdownItem>
                  ))}
                </>
              )}
            </DropdownContent>
          </DropdownRoot>
        </span>
      </li>
      {/* S87 (FR-MN-18): 채널 알림 설정 모달. 워크스페이스 채널일 때만 렌더한다.
          ChannelNotifSettings 가 useChannelNotificationPref 로 자체 fetch 하며, 글로벌
          push 설정을 상속 effective 표시용으로 주입한다. */}
      {workspaceId ? (
        <Dialog
          open={notifOpen}
          onOpenChange={setNotifOpen}
          title={`# ${channel.name} 알림 설정`}
          description="이 채널의 데스크톱·모바일 알림을 따로 설정합니다."
        >
          <ChannelNotifSettings
            workspaceId={workspaceId}
            channelId={channel.id}
            globalDesktop={globalDesktop}
            globalMobile={globalMobile}
          />
        </Dialog>
      ) : null}
    </>
  );
}

function DefaultSectionHeader({
  onAddChannel,
  canManage,
}: {
  onAddChannel: () => void;
  canManage: boolean;
}): JSX.Element {
  return (
    <div className="qf-category flex items-center justify-between pr-[var(--s-2)]">
      {/* a11y MINOR-1 + DS LOW: 유니코드 글리프 `▾` 대신 DS chevron-down 아이콘을
          쓴다(시각 일관성·폰트 의존 제거). 기본 섹션은 접기 불가이므로 정적
          아이콘이며 aria-hidden 으로 SR 에서 숨긴다(섹션 의미는 aria-label 이 전함). */}
      <span className="flex min-w-0 items-center truncate">
        <Icon name="chevron-down" size="sm" aria-hidden className="qf-icon--muted shrink-0" />
        <span className="truncate pl-[var(--s-1)]">채널</span>
      </span>
      {canManage ? (
        <button
          type="button"
          onClick={onAddChannel}
          data-testid="channel-default-add"
          aria-label="채널에 채널 추가"
          className="qf-row-iconbtn"
        >
          <Icon name="plus" size="sm" />
        </button>
      ) : null}
    </div>
  );
}

function SortableCategorySection({
  category,
  channels,
  workspaceId,
  workspaceSlug,
  activeChannelName,
  unreadByChannel,
  mutedChannelIds,
  favoriteChannelIds,
  canManage,
  onAddChannel,
  dragOverId,
  activeType,
  isCategoryDropTarget,
  globalDesktop,
  globalMobile,
  onMarkRead,
  onToggleFavorite,
  onSetMute,
  onRemoveMute,
  collapsed,
  onToggleCollapse,
}: {
  category: { id: string; name: string };
  channels: Channel[];
  workspaceId: string;
  workspaceSlug: string;
  activeChannelName: string | null;
  unreadByChannel: Map<string, { count: number; mentionCount: number }>;
  mutedChannelIds: Set<string>;
  favoriteChannelIds: Set<string>;
  canManage: boolean;
  onAddChannel: () => void;
  dragOverId: string | null;
  activeType: 'channel' | 'category' | null;
  isCategoryDropTarget: boolean;
  // S87 (FR-MN-18): 채널 알림 설정 모달의 상속 effective 표시용 글로벌 push 설정.
  globalDesktop?: boolean;
  globalMobile?: boolean;
  onMarkRead: (channelId: string) => void;
  onToggleFavorite: (channelId: string, isFavorite: boolean) => void;
  onSetMute: (channelId: string, duration: MuteDurationKey) => void;
  onRemoveMute: (channelId: string) => void;
  // S43 (FR-CH-14): 카테고리 접힘 상태 + 토글 핸들러(localStorage 영속).
  collapsed: boolean;
  onToggleCollapse: () => void;
}): JSX.Element {
  // Sortable for category reordering.
  const {
    attributes,
    listeners,
    setNodeRef: setSortableRef,
    isDragging: isCategoryDragging,
  } = useSortable({
    id: category.id,
    data: { type: 'category', categoryId: category.id },
    disabled: !canManage,
  });
  // Separate droppable for catching channel drops on the whole section
  // (header + empty-body area). Uses the same id so over.id === category.id.
  const { setNodeRef: setDroppableRef } = useDroppable({
    id: category.id,
    data: { type: 'section', categoryId: category.id },
    disabled: !canManage,
  });

  // Compose both refs (sortable + droppable) onto the outer section.
  const composedRef = (node: HTMLElement | null): void => {
    setSortableRef(node);
    setDroppableRef(node);
  };

  // Show a dropline at the end of this section's channel list when a
  // channel is being dragged over the section wrapper (not onto a
  // specific row). Matches the "insert at end" semantics in
  // handleDragEnd's cross-section branch.
  const sectionDropLine = activeType === 'channel' && dragOverId === category.id;
  const sectionStyle = { opacity: isCategoryDragging ? 0.4 : 1 };
  return (
    <>
      {isCategoryDropTarget ? <DropLine /> : null}
      <section
        ref={composedRef}
        style={sectionStyle}
        data-testid={`channel-cat-${category.name}-section`}
        data-section-id={category.id}
        aria-label={category.name}
        className="rounded-[var(--r-md)]"
      >
        <div className="qf-category flex items-center justify-between pr-[var(--s-2)]">
          {/* S43 (FR-CH-14): 카테고리 헤더를 접기/펼치기 토글 버튼으로. aria-expanded
              로 상태를 SR 에 노출하고, 화살표를 collapsed 면 -90deg 회전시킨다
              (DS 토큰 --dur-fast/--ease-standard transition, raw px/hex 금지). 드래그
              핸들(canManage 시)은 별도 span 으로 분리해 토글 클릭과 충돌하지 않게 한다. */}
          {canManage ? (
            <span
              {...attributes}
              {...listeners}
              data-testid={`category-drag-${category.name}`}
              aria-label={`카테고리 ${category.name} 드래그`}
              className="cursor-grab pl-[var(--s-1)]"
            >
              <Icon name="grid" size="sm" className="qf-icon--muted" aria-hidden />
            </span>
          ) : null}
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-expanded={!collapsed}
            aria-controls={`channels-cat-${category.id}`}
            data-testid={`category-collapse-${category.name}`}
            aria-label={`카테고리 ${category.name} ${collapsed ? '펼치기' : '접기'}`}
            className="flex min-w-0 flex-1 items-center truncate bg-transparent pl-[var(--s-1)] text-left"
          >
            {/* a11y MINOR-1: CollapseArrow 를 토글 버튼의 첫 자식으로 둬 시각-DOM
                순서를 일치시킨다(pointer-events-none·aria-hidden 으로 시각 전용). */}
            <span className="pointer-events-none flex shrink-0 items-center">
              <CollapseArrow collapsed={collapsed} />
            </span>
            <span className="truncate pl-[var(--s-1)]">{category.name}</span>
          </button>
          {canManage ? (
            <button
              type="button"
              onClick={onAddChannel}
              data-testid={`channel-cat-${category.name}-add`}
              aria-label={`${category.name}에 채널 추가`}
              className="qf-row-iconbtn"
            >
              <Icon name="plus" size="sm" />
            </button>
          ) : null}
        </div>
        {/* S43 (FR-CH-14): collapsed 면 채널 목록을 미렌더(드래그 컨텍스트는 유지). */}
        {collapsed ? null : (
          <SortableContext items={channels.map((c) => c.id)} strategy={() => null}>
            {/* a11y MODERATE-1: 토글 버튼의 aria-controls 가 가리키는 채널 목록 id. */}
            <ul id={`channels-cat-${category.id}`} className="mt-1 min-h-[var(--s-5)]">
              {channels.map((ch) => {
                const u = unreadByChannel.get(ch.id);
                const isActive = activeChannelName === ch.name;
                const rowState = deriveSidebarRowState({
                  unreadCount: isActive ? 0 : (u?.count ?? 0),
                  mentionCount: isActive ? 0 : (u?.mentionCount ?? 0),
                  muted: mutedChannelIds.has(ch.id),
                });
                return (
                  <DraggableChannelRow
                    key={ch.id}
                    channel={ch}
                    workspaceId={workspaceId}
                    workspaceSlug={workspaceSlug}
                    active={isActive}
                    showUnreadStyle={rowState.showUnreadStyle}
                    mentionBadgeCount={rowState.mentionBadgeCount}
                    muted={mutedChannelIds.has(ch.id)}
                    isFavorite={favoriteChannelIds.has(ch.id)}
                    canManage={canManage}
                    isDropTarget={activeType === 'channel' && dragOverId === ch.id}
                    hasUnread={(u?.count ?? 0) > 0}
                    globalDesktop={globalDesktop}
                    globalMobile={globalMobile}
                    onMarkRead={onMarkRead}
                    onToggleFavorite={onToggleFavorite}
                    onSetMute={onSetMute}
                    onRemoveMute={onRemoveMute}
                  />
                );
              })}
              {sectionDropLine ? <DropLine /> : null}
            </ul>
          </SortableContext>
        )}
      </section>
    </>
  );
}

function DefaultSection({
  channels,
  workspaceId,
  workspaceSlug,
  activeChannelName,
  unreadByChannel,
  mutedChannelIds,
  favoriteChannelIds,
  canManage,
  onAddChannel,
  dragOverId,
  activeType,
  globalDesktop,
  globalMobile,
  onMarkRead,
  onToggleFavorite,
  onSetMute,
  onRemoveMute,
}: {
  channels: Channel[];
  workspaceId: string;
  workspaceSlug: string;
  activeChannelName: string | null;
  unreadByChannel: Map<string, { count: number; mentionCount: number }>;
  mutedChannelIds: Set<string>;
  favoriteChannelIds: Set<string>;
  canManage: boolean;
  onAddChannel: () => void;
  dragOverId: string | null;
  activeType: 'channel' | 'category' | null;
  // S87 (FR-MN-18): 채널 알림 설정 모달의 상속 effective 표시용 글로벌 push 설정.
  globalDesktop?: boolean;
  globalMobile?: boolean;
  onMarkRead: (channelId: string) => void;
  onToggleFavorite: (channelId: string, isFavorite: boolean) => void;
  onSetMute: (channelId: string, duration: MuteDurationKey) => void;
  onRemoveMute: (channelId: string) => void;
}): JSX.Element {
  const { setNodeRef } = useDroppable({
    id: ROOT_CATEGORY_ID,
    data: { type: 'section', categoryId: null },
    disabled: !canManage,
  });
  const sectionDropLine = activeType === 'channel' && dragOverId === ROOT_CATEGORY_ID;
  return (
    <section
      ref={setNodeRef}
      data-testid="channel-default-section"
      data-section-id={ROOT_CATEGORY_ID}
      aria-label="채널"
      className="rounded-[var(--r-md)]"
    >
      <DefaultSectionHeader onAddChannel={onAddChannel} canManage={canManage} />
      <SortableContext items={channels.map((c) => c.id)} strategy={() => null}>
        <ul className="mt-1 min-h-[var(--s-5)]">
          {channels.map((ch) => {
            const u = unreadByChannel.get(ch.id);
            const isActive = activeChannelName === ch.name;
            const rowState = deriveSidebarRowState({
              unreadCount: isActive ? 0 : (u?.count ?? 0),
              mentionCount: isActive ? 0 : (u?.mentionCount ?? 0),
              muted: mutedChannelIds.has(ch.id),
            });
            return (
              <DraggableChannelRow
                key={ch.id}
                channel={ch}
                workspaceId={workspaceId}
                workspaceSlug={workspaceSlug}
                active={isActive}
                showUnreadStyle={rowState.showUnreadStyle}
                mentionBadgeCount={rowState.mentionBadgeCount}
                muted={mutedChannelIds.has(ch.id)}
                isFavorite={favoriteChannelIds.has(ch.id)}
                canManage={canManage}
                isDropTarget={activeType === 'channel' && dragOverId === ch.id}
                hasUnread={(u?.count ?? 0) > 0}
                globalDesktop={globalDesktop}
                globalMobile={globalMobile}
                onMarkRead={onMarkRead}
                onToggleFavorite={onToggleFavorite}
                onSetMute={onSetMute}
                onRemoveMute={onRemoveMute}
              />
            );
          })}
          {sectionDropLine ? <DropLine /> : null}
        </ul>
      </SortableContext>
    </section>
  );
}

export function ChannelList({
  workspaceId,
  workspaceSlug,
  canManage,
  activeChannelName,
}: Props): JSX.Element {
  const { data } = useChannelList(workspaceId);
  const { data: unread } = useUnreadSummary(workspaceId);
  // S87 (FR-MN-18): 글로벌 데스크톱/모바일 push 설정. 채널 알림 설정 모달이 상속(null)
  // 상태일 때 effective 값을 스위치에 반영하도록 전달한다(죽은 컨트롤 방지). 미로드면
  // ChannelNotifSettings 기본값(true)으로 떨어진다.
  const { data: globalNotif } = useGlobalNotificationSettings();
  // S22 (FR-RS-05): 뮤트 채널 id 집합. unread bold/pill 억제에 사용.
  const mutedChannelIds = useMutedChannelIds();
  // S43 (FR-CH-15): 즐겨찾기 channelId 집합(컨텍스트 메뉴 토글 라벨 결정용).
  const favoriteChannelIds = useFavoriteChannelIds();
  // S85 (FR-CH-16): 개인 섹션에 할당된 channelId 집합. 카테고리 기본 위치에서 제외해
  // 같은 채널이 섹션·기본 위치에 중복 노출되지 않게 한다.
  const assignedChannelIds = useAssignedChannelIds(workspaceId);
  // S85 (FR-CH-16): 새 섹션 생성(인라인 입력). 성공 시 sidebar-sections 무효화는 훅 내부.
  const createSectionMut = useCreateSidebarSection(workspaceId);
  const [creatingSection, setCreatingSection] = useState(false);
  const [newSectionName, setNewSectionName] = useState('');
  // S24 (FR-RS-09): 우클릭 컨텍스트 메뉴 "읽음으로 표시" — 채널 최신까지 ACK 전진
  // (기존 markRead 재사용, monotonic 전진).
  const markReadMut = useMarkChannelRead(workspaceId);
  const onMarkRead = (channelId: string): void => {
    markReadMut.mutate(channelId);
  };
  // S43 (FR-CH-17): 뮤트 설정/해제 mutation. 성공 시 me/mutes 무효화는 훅 내부.
  const setMuteMut = useSetChannelMute();
  const removeMuteMut = useRemoveChannelMute();
  const onSetMute = (channelId: string, duration: MuteDurationKey): void => {
    setMuteMut.mutate({ channelId, duration });
  };
  const onRemoveMute = (channelId: string): void => {
    removeMuteMut.mutate(channelId);
  };
  // S43 (FR-CH-15): 즐겨찾기 추가/해제 토글.
  const addFavoriteMut = useAddFavorite(workspaceId);
  const removeFavoriteMut = useRemoveFavorite(workspaceId);
  const onToggleFavorite = (channelId: string, isFavorite: boolean): void => {
    if (isFavorite) removeFavoriteMut.mutate(channelId);
    else addFavoriteMut.mutate(channelId);
  };
  const moveChannelMut = useMoveChannel(workspaceId);
  const moveCategoryMut = useMoveCategory(workspaceId);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const [activeDragType, setActiveDragType] = useState<'channel' | 'category' | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [channelModal, setChannelModal] = useState<null | {
    categoryId: string | null;
    categoryLabel: string;
  }>(null);

  // S43 (FR-CH-14): 카테고리 접힘 상태. localStorage 가 단일 출처지만 토글 시
  // 즉시 리렌더가 필요하므로 collapsed id Set 을 state 로 둔다. 카테고리 목록이
  // 바뀌면(추가/삭제) 저장소에서 다시 끌어와 동기화한다.
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const categoryIdsKey = useMemo(() => (data?.categories ?? []).map((c) => c.id).join(','), [data]);
  useEffect(() => {
    const next = new Set<string>();
    for (const cat of data?.categories ?? []) {
      if (isCategoryCollapsed(workspaceId, cat.id)) next.add(cat.id);
    }
    setCollapsedIds(next);
    // deps: categoryIdsKey 로 카테고리 집합 변경만 추적한다(매 렌더 재계산 방지).
    // data.categories 는 categoryIdsKey 가 대표하므로 deps 에서 생략한다. 이 repo 는
    // react-hooks/exhaustive-deps 룰을 설치하지 않아 경고가 없다(useDmPresence 동일).
  }, [workspaceId, categoryIdsKey]);
  const onToggleCollapse = useCallback(
    (categoryId: string): void => {
      setCollapsedIds((prev) => {
        const next = new Set(prev);
        const willCollapse = !next.has(categoryId);
        if (willCollapse) next.add(categoryId);
        else next.delete(categoryId);
        setCategoryCollapsed(workspaceId, categoryId, willCollapse);
        return next;
      });
    },
    [workspaceId],
  );

  // S85 (FR-CH-16): 개인 섹션에 할당된 채널은 카테고리 기본 위치에서 제외한다(섹션에서
  // 표시). channelsById(전체)는 섹션이 채널 메타를 끌어오는 데 쓰이므로 별도로 둔다.
  const uncategorized = useMemo(
    () => (data?.uncategorized ?? []).filter((c) => !assignedChannelIds.has(c.id)),
    [data, assignedChannelIds],
  );
  const categories = useMemo(
    () =>
      (data?.categories ?? []).map((cat) => ({
        ...cat,
        channels: cat.channels.filter((c) => !assignedChannelIds.has(c.id)),
      })),
    [data, assignedChannelIds],
  );

  const sectionOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of uncategorized) m.set(c.id, ROOT_CATEGORY_ID);
    for (const cat of categories) {
      for (const c of cat.channels) m.set(c.id, cat.id);
    }
    return m;
  }, [uncategorized, categories]);

  const channelsBySection = useMemo(() => {
    const m = new Map<string, Channel[]>();
    m.set(ROOT_CATEGORY_ID, uncategorized);
    for (const cat of categories) m.set(cat.id, cat.channels);
    return m;
  }, [uncategorized, categories]);

  // S43 (FR-CH-15): 즐겨찾기 섹션이 channelId 로 채널 메타(name/categoryId)를
  // 끌어오기 위한 평탄 맵. 현재 워크스페이스 채널만 담으므로, 다른 워크스페이스
  // 즐겨찾기는 섹션에서 자연히 누락(렌더 제외)된다.
  // S85 (FR-CH-16): 전체 채널 맵(할당 채널 포함 — 섹션이 채널 메타를 끌어옴). 필터된
  // uncategorized/categories 가 아니라 raw data 에서 만든다.
  const channelsById = useMemo(() => {
    const m = new Map<string, Channel>();
    for (const c of data?.uncategorized ?? []) m.set(c.id, c);
    for (const cat of data?.categories ?? []) for (const c of cat.channels) m.set(c.id, c);
    return m;
  }, [data]);

  const unreadByChannel = useMemo(() => {
    const m = new Map<string, { count: number; mentionCount: number }>();
    for (const u of unread?.channels ?? []) {
      m.set(u.channelId, { count: u.unreadCount, mentionCount: u.mentionCount });
    }
    return m;
  }, [unread]);

  const handleDragStart = (evt: DragStartEvent): void => {
    const t = (evt.active.data.current as { type?: string } | undefined)?.type;
    if (t === 'channel' || t === 'category') setActiveDragType(t);
  };

  const handleDragOver = (evt: DragOverEvent): void => {
    setDragOverId(evt.over ? (evt.over.id as string) : null);
  };

  const handleDragCancel = (): void => {
    setActiveDragType(null);
    setDragOverId(null);
  };

  async function handleDragEnd(evt: DragEndEvent): Promise<void> {
    setActiveDragType(null);
    setDragOverId(null);
    const { active, over } = evt;
    if (!over) return;
    const activeId = active.id as string;
    const overId = over.id as string;
    if (activeId === overId) return;

    const type = (active.data.current as { type?: string } | undefined)?.type;

    if (type === 'category') {
      // Categories reorder — only real categories participate (default
      // section not in the sortable list).
      const ids = categories.map((c) => c.id);
      const fromIdx = ids.indexOf(activeId);
      const toIdx = ids.indexOf(overId);
      if (fromIdx < 0 || toIdx < 0) return;
      const newOrder = arrayMove(ids, fromIdx, toIdx);
      const newIndex = newOrder.indexOf(activeId);
      const before = newOrder[newIndex + 1];
      const after = newOrder[newIndex - 1];
      await moveCategoryMut
        .mutateAsync({
          id: activeId,
          input: before ? { beforeId: before } : after ? { afterId: after } : {},
        })
        .catch(() => undefined);
      return;
    }

    // type === 'channel' (default)
    const fromSection = sectionOf.get(activeId);
    if (!fromSection) return;

    // Resolve destination: overId may be (a) another channel's id OR (b)
    // a section id (category uuid or ROOT_CATEGORY_ID) when the drop
    // lands on the section wrapper / empty area / header row.
    let toSection = sectionOf.get(overId);
    if (!toSection && channelsBySection.has(overId)) {
      toSection = overId;
    }
    if (!toSection) return;

    const sourceList = (channelsBySection.get(fromSection) ?? []).slice();
    const targetList = (channelsBySection.get(toSection) ?? []).slice();

    let newOrder: Channel[];
    let newIndex: number;
    if (fromSection === toSection) {
      const fromIdx = sourceList.findIndex((c) => c.id === activeId);
      const toIdx = sourceList.findIndex((c) => c.id === overId);
      if (fromIdx < 0) return;
      if (toIdx < 0) {
        // Dropping onto the section wrapper (no specific channel hit) —
        // keep in place. Caller can still move via a specific channel.
        return;
      }
      newOrder = arrayMove(sourceList, fromIdx, toIdx);
      newIndex = newOrder.findIndex((c) => c.id === activeId);
    } else {
      const moved = sourceList.find((c) => c.id === activeId);
      if (!moved) return;
      const overIdx = targetList.findIndex((c) => c.id === overId);
      // If the drop fell on the section wrapper (no specific channel),
      // append to the end of the target list.
      const insertAt = overIdx >= 0 ? overIdx : targetList.length;
      newOrder = [...targetList.slice(0, insertAt), moved, ...targetList.slice(insertAt)];
      newIndex = insertAt;
    }

    const before = newOrder[newIndex + 1]?.id;
    const after = newOrder[newIndex - 1]?.id;

    await moveChannelMut
      .mutateAsync({
        id: activeId,
        input: {
          categoryId: toSection === ROOT_CATEGORY_ID ? null : toSection,
          ...(before ? { beforeId: before } : after ? { afterId: after } : {}),
        },
      })
      .catch(() => undefined);
  }

  const openChannelCreate = (categoryId: string | null, categoryLabel: string): void => {
    setChannelModal({ categoryId, categoryLabel });
  };

  return (
    <>
      {/* S43 (FR-CH-15): 사이드바 최상단 즐겨찾기 섹션. 자체 DnD 컨텍스트를 가지므로
          채널 DndContext 밖(위)에 둔다 — 두 드래그 컨텍스트가 섞이지 않게 한다. */}
      <FavoritesSection
        workspaceId={workspaceId}
        workspaceSlug={workspaceSlug}
        channelsById={channelsById}
        activeChannelName={activeChannelName}
        unreadByChannel={unreadByChannel}
        mutedChannelIds={mutedChannelIds}
      />
      {/* S85 (FR-CH-16): 개인 섹션 영역(Favorites 아래·카테고리 위). 자체 DnD 컨텍스트를
          가지므로 채널 DndContext 밖(위)에 둔다. */}
      <SidebarSections
        workspaceId={workspaceId}
        workspaceSlug={workspaceSlug}
        channelsById={channelsById}
        activeChannelName={activeChannelName}
        unreadByChannel={unreadByChannel}
        mutedChannelIds={mutedChannelIds}
      />
      {/* S85 (FR-CH-16): 새 개인 섹션 생성(인라인 입력). 멤버 누구나 자기 사이드바를
          정리할 수 있으므로 canManage 게이트 없이 노출한다. */}
      {creatingSection ? (
        <input
          autoFocus
          aria-label="새 섹션 이름"
          data-testid="sidebar-section-create-input"
          maxLength={100}
          placeholder="새 섹션 이름"
          value={newSectionName}
          onChange={(e) => setNewSectionName(e.target.value)}
          onBlur={() => {
            const name = newSectionName.trim();
            setCreatingSection(false);
            setNewSectionName('');
            if (name.length > 0) createSectionMut.mutate({ name });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              setNewSectionName('');
              setCreatingSection(false);
            }
          }}
          className="qf-input my-[var(--s-1)] w-full"
        />
      ) : (
        <button
          type="button"
          onClick={() => setCreatingSection(true)}
          data-testid="sidebar-section-create"
          aria-label="새 개인 섹션 추가"
          className="qf-category flex w-full items-center pr-[var(--s-2)] text-left"
        >
          <Icon name="plus" size="sm" aria-hidden className="qf-icon--muted shrink-0" />
          <span className="truncate pl-[var(--s-1)]">새 섹션</span>
        </button>
      )}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <nav className="flex flex-col" data-testid="channel-sidebar" aria-label="채널">
          <DefaultSection
            channels={uncategorized}
            workspaceId={workspaceId}
            workspaceSlug={workspaceSlug}
            activeChannelName={activeChannelName}
            unreadByChannel={unreadByChannel}
            mutedChannelIds={mutedChannelIds}
            favoriteChannelIds={favoriteChannelIds}
            canManage={canManage}
            onAddChannel={() => openChannelCreate(null, '채널')}
            dragOverId={dragOverId}
            activeType={activeDragType}
            globalDesktop={globalNotif?.notifDesktop}
            globalMobile={globalNotif?.notifMobile}
            onMarkRead={onMarkRead}
            onToggleFavorite={onToggleFavorite}
            onSetMute={onSetMute}
            onRemoveMute={onRemoveMute}
          />
          <SortableContext items={categories.map((c) => c.id)} strategy={() => null}>
            {categories.map((cat) => (
              <SortableCategorySection
                key={cat.id}
                category={cat}
                channels={cat.channels}
                workspaceId={workspaceId}
                workspaceSlug={workspaceSlug}
                activeChannelName={activeChannelName}
                unreadByChannel={unreadByChannel}
                mutedChannelIds={mutedChannelIds}
                favoriteChannelIds={favoriteChannelIds}
                canManage={canManage}
                onAddChannel={() => openChannelCreate(cat.id, cat.name)}
                dragOverId={dragOverId}
                activeType={activeDragType}
                isCategoryDropTarget={activeDragType === 'category' && dragOverId === cat.id}
                globalDesktop={globalNotif?.notifDesktop}
                globalMobile={globalNotif?.notifMobile}
                onMarkRead={onMarkRead}
                onToggleFavorite={onToggleFavorite}
                onSetMute={onSetMute}
                onRemoveMute={onRemoveMute}
                collapsed={collapsedIds.has(cat.id)}
                onToggleCollapse={() => onToggleCollapse(cat.id)}
              />
            ))}
          </SortableContext>
        </nav>
      </DndContext>

      <CreateChannelModal
        workspaceId={workspaceId}
        categoryId={channelModal?.categoryId ?? null}
        categoryLabel={channelModal?.categoryLabel ?? '채널'}
        open={channelModal !== null}
        onClose={() => setChannelModal(null)}
      />
    </>
  );
}
