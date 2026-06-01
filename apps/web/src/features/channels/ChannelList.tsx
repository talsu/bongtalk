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
import { useMemo, useState } from 'react';
import type { Channel } from '@qufox/shared-types';
import { useChannelList, useMoveCategory, useMoveChannel } from './useChannels';
import { useUnreadSummary, useMarkChannelRead } from './useUnread';
import { useMutedChannelIds } from './useMutes';
import { deriveSidebarRowState } from './sidebarRowState';
import { isContextMenuKey } from './unreadsA11y';
import { CreateChannelModal } from './CreateChannelModal';
import {
  Icon,
  DropdownRoot,
  DropdownTrigger,
  DropdownContent,
  DropdownItem,
} from '../../design-system/primitives';
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

function DraggableChannelRow({
  channel,
  workspaceSlug,
  active,
  showUnreadStyle,
  mentionBadgeCount,
  canManage,
  isDropTarget,
  hasUnread,
  onMarkRead,
}: {
  channel: Channel;
  workspaceSlug: string;
  active: boolean;
  showUnreadStyle: boolean;
  mentionBadgeCount: number;
  canManage: boolean;
  isDropTarget: boolean;
  // S24 (FR-RS-09): 우클릭 컨텍스트 메뉴 "읽음으로 표시" 노출 여부 + 핸들러.
  hasUnread: boolean;
  onMarkRead: (channelId: string) => void;
}): JSX.Element {
  // S24 (FR-RS-09): 채널 우클릭 컨텍스트 메뉴. 신규 라이브러리 도입 없이 기존
  // Radix DropdownMenu(DS qf-menu 클래스)를 controlled 로 쓰고, 행의
  // onContextMenu 가 메뉴를 연다(트리거는 행 안의 0-size 앵커).
  const [menuOpen, setMenuOpen] = useState(false);
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
    disabled: !canManage,
  });
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
        {...(canManage ? { ...attributes, ...listeners } : {})}
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
          isDragging ? 'cursor-grabbing' : canManage ? 'cursor-grab' : 'cursor-pointer',
        )}
        data-testid={`channel-${channel.name}`}
        data-unread={showUnreadStyle ? 'true' : 'false'}
        data-mention={mentionBadgeCount > 0 ? 'true' : 'false'}
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
        <span className="qf-channel__prefix pointer-events-none relative">#</span>
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
            </DropdownContent>
          </DropdownRoot>
        </span>
      </li>
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
      <span className="truncate">
        <span aria-hidden="true">▾ </span>채널
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
  workspaceSlug,
  activeChannelName,
  unreadByChannel,
  mutedChannelIds,
  canManage,
  onAddChannel,
  dragOverId,
  activeType,
  isCategoryDropTarget,
  onMarkRead,
}: {
  category: { id: string; name: string };
  channels: Channel[];
  workspaceSlug: string;
  activeChannelName: string | null;
  unreadByChannel: Map<string, { count: number; mentionCount: number }>;
  mutedChannelIds: Set<string>;
  canManage: boolean;
  onAddChannel: () => void;
  dragOverId: string | null;
  activeType: 'channel' | 'category' | null;
  isCategoryDropTarget: boolean;
  onMarkRead: (channelId: string) => void;
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
        className="rounded-[var(--r-md)]"
      >
        <div className="qf-category flex items-center justify-between pr-[var(--s-2)]">
          {canManage ? (
            <span
              {...attributes}
              {...listeners}
              data-testid={`category-drag-${category.name}`}
              aria-label={`카테고리 ${category.name} 드래그`}
              className="flex min-w-0 flex-1 cursor-grab items-center truncate"
            >
              <span aria-hidden="true">▾&nbsp;</span>
              {category.name}
            </span>
          ) : (
            <span className="flex min-w-0 flex-1 items-center truncate">
              <span aria-hidden="true">▾&nbsp;</span>
              {category.name}
            </span>
          )}
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
                  workspaceSlug={workspaceSlug}
                  active={isActive}
                  showUnreadStyle={rowState.showUnreadStyle}
                  mentionBadgeCount={rowState.mentionBadgeCount}
                  canManage={canManage}
                  isDropTarget={activeType === 'channel' && dragOverId === ch.id}
                  hasUnread={(u?.count ?? 0) > 0}
                  onMarkRead={onMarkRead}
                />
              );
            })}
            {sectionDropLine ? <DropLine /> : null}
          </ul>
        </SortableContext>
      </section>
    </>
  );
}

function DefaultSection({
  channels,
  workspaceSlug,
  activeChannelName,
  unreadByChannel,
  mutedChannelIds,
  canManage,
  onAddChannel,
  dragOverId,
  activeType,
  onMarkRead,
}: {
  channels: Channel[];
  workspaceSlug: string;
  activeChannelName: string | null;
  unreadByChannel: Map<string, { count: number; mentionCount: number }>;
  mutedChannelIds: Set<string>;
  canManage: boolean;
  onAddChannel: () => void;
  dragOverId: string | null;
  activeType: 'channel' | 'category' | null;
  onMarkRead: (channelId: string) => void;
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
                workspaceSlug={workspaceSlug}
                active={isActive}
                showUnreadStyle={rowState.showUnreadStyle}
                mentionBadgeCount={rowState.mentionBadgeCount}
                canManage={canManage}
                isDropTarget={activeType === 'channel' && dragOverId === ch.id}
                hasUnread={(u?.count ?? 0) > 0}
                onMarkRead={onMarkRead}
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
  // S22 (FR-RS-05): 뮤트 채널 id 집합. unread bold/pill 억제에 사용.
  const mutedChannelIds = useMutedChannelIds();
  // S24 (FR-RS-09): 우클릭 컨텍스트 메뉴 "읽음으로 표시" — 채널 최신까지 ACK 전진
  // (기존 markRead 재사용, monotonic 전진).
  const markReadMut = useMarkChannelRead(workspaceId);
  const onMarkRead = (channelId: string): void => {
    markReadMut.mutate(channelId);
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

  const uncategorized = useMemo(() => data?.uncategorized ?? [], [data]);
  const categories = useMemo(() => data?.categories ?? [], [data]);

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
            workspaceSlug={workspaceSlug}
            activeChannelName={activeChannelName}
            unreadByChannel={unreadByChannel}
            mutedChannelIds={mutedChannelIds}
            canManage={canManage}
            onAddChannel={() => openChannelCreate(null, '채널')}
            dragOverId={dragOverId}
            activeType={activeDragType}
            onMarkRead={onMarkRead}
          />
          <SortableContext items={categories.map((c) => c.id)} strategy={() => null}>
            {categories.map((cat) => (
              <SortableCategorySection
                key={cat.id}
                category={cat}
                channels={cat.channels}
                workspaceSlug={workspaceSlug}
                activeChannelName={activeChannelName}
                unreadByChannel={unreadByChannel}
                mutedChannelIds={mutedChannelIds}
                canManage={canManage}
                onAddChannel={() => openChannelCreate(cat.id, cat.name)}
                dragOverId={dragOverId}
                activeType={activeDragType}
                isCategoryDropTarget={activeDragType === 'category' && dragOverId === cat.id}
                onMarkRead={onMarkRead}
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
