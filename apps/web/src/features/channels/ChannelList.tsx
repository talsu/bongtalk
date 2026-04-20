import { Link } from 'react-router-dom';
import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMemo, useState } from 'react';
import type { Channel } from '@qufox/shared-types';
import { useChannelList, useMoveCategory, useMoveChannel } from './useChannels';
import { useUnreadSummary } from './useUnread';
import { CreateChannelModal } from './CreateChannelModal';
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
 * 1. Channels drag within a section (reorder).
 * 2. Channels drag across sections (change categoryId). Empty
 *    categories ARE valid drop targets because the section wrapper
 *    `useDroppable({ id: sectionId })` catches pointer hits on the
 *    header — not just on the channel rows.
 * 3. Visual feedback: when a channel-drag hovers over a section, its
 *    header + body gain a subtle ring so the user predicts the drop.
 * 4. Categories themselves drag-reorder via POST /categories/:id/move.
 *    Default "채널" is always first and not part of the sortable list.
 *
 * `active.data.current.type` distinguishes 'channel' vs 'category' so
 * drag-end routes to the correct mutation.
 */

const ROOT_CATEGORY_ID = '__root__';

function UnreadIndicator({
  count,
  hasMention,
}: {
  count: number;
  hasMention: boolean;
}): JSX.Element | null {
  if (count <= 0) return null;
  return (
    <span
      data-testid={hasMention ? 'unread-pill-mention' : 'unread-pill'}
      aria-label={hasMention ? `읽지 않은 멘션 ${count}개` : `읽지 않음 ${count}개`}
      className={cn('qf-badge qf-badge--count', !hasMention && 'bg-accent')}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

function DraggableChannelRow({
  channel,
  workspaceSlug,
  active,
  unreadCount,
  hasMention,
}: {
  channel: Channel;
  workspaceSlug: string;
  active: boolean;
  unreadCount: number;
  hasMention: boolean;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: channel.id,
    data: { type: 'channel', channelId: channel.id, categoryId: channel.categoryId },
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  const hasUnread = unreadCount > 0;
  return (
    <li
      ref={setNodeRef}
      style={style}
      aria-selected={active || undefined}
      className={cn('qf-channel group', hasUnread && !active && 'qf-channel--unread')}
      data-testid={`channel-${channel.name}`}
      data-unread={hasUnread ? 'true' : 'false'}
      data-mention={hasMention ? 'true' : 'false'}
    >
      <span
        {...attributes}
        {...listeners}
        data-testid={`channel-drag-${channel.name}`}
        aria-label={`채널 ${channel.name} 드래그`}
        className="cursor-grab text-text-muted opacity-0 transition-opacity group-hover:opacity-100"
      >
        ⋮⋮
      </span>
      <Link to={`/w/${workspaceSlug}/${channel.name}`} className="flex-1 truncate">
        <span className="qf-channel__prefix">#</span>&nbsp;{channel.name}
        {hasUnread && !active && (
          <span
            data-testid={hasMention ? 'unread-dot-mention' : 'unread-dot'}
            aria-hidden="true"
            className={cn(
              'ml-1 inline-block h-1.5 w-1.5 rounded-full',
              hasMention ? 'bg-danger' : 'bg-accent',
            )}
          />
        )}
      </Link>
      <span className="qf-channel__suffix">
        <UnreadIndicator count={unreadCount} hasMention={hasMention} />
      </span>
    </li>
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
      <span className="truncate">채널</span>
      {canManage ? (
        <button
          type="button"
          onClick={onAddChannel}
          data-testid="channel-default-add"
          aria-label="채널에 채널 추가"
          className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
        >
          +
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
  canManage,
  onAddChannel,
}: {
  category: { id: string; name: string };
  channels: Channel[];
  workspaceSlug: string;
  activeChannelName: string | null;
  unreadByChannel: Map<string, { count: number; mention: boolean }>;
  canManage: boolean;
  onAddChannel: () => void;
}): JSX.Element {
  // Sortable for category reordering.
  const {
    attributes,
    listeners,
    setNodeRef: setSortableRef,
    transform,
    transition,
    isDragging: isCategoryDragging,
  } = useSortable({
    id: category.id,
    data: { type: 'category', categoryId: category.id },
  });
  // Separate droppable for catching channel drops on the whole section
  // (header + empty-body area). Uses the same id so over.id === category.id.
  const {
    setNodeRef: setDroppableRef,
    isOver,
    active,
  } = useDroppable({
    id: category.id,
    data: { type: 'section', categoryId: category.id },
  });

  // Compose both refs (sortable + droppable) onto the outer section.
  const composedRef = (node: HTMLElement | null): void => {
    setSortableRef(node);
    setDroppableRef(node);
  };

  const incomingChannel = active?.data.current?.type === 'channel' && isOver;
  const sortStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isCategoryDragging ? 0.4 : 1,
  };
  return (
    <section
      ref={composedRef}
      style={sortStyle}
      data-testid={`channel-cat-${category.name}-section`}
      data-section-id={category.id}
      className={cn(
        'rounded-[var(--r-md)] transition-colors',
        incomingChannel && 'bg-accent-subtle ring-2 ring-accent',
      )}
    >
      <div className="qf-category flex items-center justify-between pr-[var(--s-2)]">
        <span
          {...attributes}
          {...listeners}
          data-testid={`category-drag-${category.name}`}
          aria-label={`카테고리 ${category.name} 드래그`}
          className="flex min-w-0 flex-1 cursor-grab items-center truncate"
        >
          {category.name}
        </span>
        {canManage ? (
          <button
            type="button"
            onClick={onAddChannel}
            data-testid={`channel-cat-${category.name}-add`}
            aria-label={`${category.name}에 채널 추가`}
            className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
          >
            +
          </button>
        ) : null}
      </div>
      <SortableContext items={channels.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <ul className="mt-1 min-h-[var(--s-5)]">
          {channels.map((ch) => {
            const u = unreadByChannel.get(ch.id);
            const isActive = activeChannelName === ch.name;
            return (
              <DraggableChannelRow
                key={ch.id}
                channel={ch}
                workspaceSlug={workspaceSlug}
                active={isActive}
                unreadCount={!isActive ? (u?.count ?? 0) : 0}
                hasMention={!isActive && (u?.mention ?? false)}
              />
            );
          })}
          {channels.length === 0 ? (
            <li
              aria-hidden
              className="px-[var(--s-3)] py-[var(--s-2)] text-[length:var(--fs-11)] text-text-muted italic"
            >
              채널 없음
            </li>
          ) : null}
        </ul>
      </SortableContext>
    </section>
  );
}

function DefaultSection({
  channels,
  workspaceSlug,
  activeChannelName,
  unreadByChannel,
  canManage,
  onAddChannel,
}: {
  channels: Channel[];
  workspaceSlug: string;
  activeChannelName: string | null;
  unreadByChannel: Map<string, { count: number; mention: boolean }>;
  canManage: boolean;
  onAddChannel: () => void;
}): JSX.Element {
  const { setNodeRef, isOver, active } = useDroppable({
    id: ROOT_CATEGORY_ID,
    data: { type: 'section', categoryId: null },
  });
  const incomingChannel = active?.data.current?.type === 'channel' && isOver;
  return (
    <section
      ref={setNodeRef}
      data-testid="channel-default-section"
      data-section-id={ROOT_CATEGORY_ID}
      className={cn(
        'rounded-[var(--r-md)] transition-colors',
        incomingChannel && 'bg-accent-subtle ring-2 ring-accent',
      )}
    >
      <DefaultSectionHeader onAddChannel={onAddChannel} canManage={canManage} />
      <SortableContext items={channels.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <ul className="mt-1 min-h-[var(--s-5)]">
          {channels.map((ch) => {
            const u = unreadByChannel.get(ch.id);
            const isActive = activeChannelName === ch.name;
            return (
              <DraggableChannelRow
                key={ch.id}
                channel={ch}
                workspaceSlug={workspaceSlug}
                active={isActive}
                unreadCount={!isActive ? (u?.count ?? 0) : 0}
                hasMention={!isActive && (u?.mention ?? false)}
              />
            );
          })}
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
  const moveChannelMut = useMoveChannel(workspaceId);
  const moveCategoryMut = useMoveCategory(workspaceId);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const [activeDragType, setActiveDragType] = useState<'channel' | 'category' | null>(null);
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
    const m = new Map<string, { count: number; mention: boolean }>();
    for (const u of unread?.channels ?? []) {
      m.set(u.channelId, { count: u.unreadCount, mention: u.hasMention });
    }
    return m;
  }, [unread]);

  const handleDragStart = (evt: DragStartEvent): void => {
    const t = (evt.active.data.current as { type?: string } | undefined)?.type;
    if (t === 'channel' || t === 'category') setActiveDragType(t);
  };

  async function handleDragEnd(evt: DragEndEvent): Promise<void> {
    setActiveDragType(null);
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

  // Silence unused-var noise — activeDragType can inform a future drag
  // overlay; for now the dependency keeps render cycles consistent with
  // the live drag-start / drag-end lifecycle.
  void activeDragType;

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <nav className="flex flex-col gap-3" data-testid="channel-sidebar" aria-label="채널">
          <DefaultSection
            channels={uncategorized}
            workspaceSlug={workspaceSlug}
            activeChannelName={activeChannelName}
            unreadByChannel={unreadByChannel}
            canManage={canManage}
            onAddChannel={() => openChannelCreate(null, '채널')}
          />
          <SortableContext
            items={categories.map((c) => c.id)}
            strategy={verticalListSortingStrategy}
          >
            {categories.map((cat) => (
              <SortableCategorySection
                key={cat.id}
                category={cat}
                channels={cat.channels}
                workspaceSlug={workspaceSlug}
                activeChannelName={activeChannelName}
                unreadByChannel={unreadByChannel}
                canManage={canManage}
                onAddChannel={() => openChannelCreate(cat.id, cat.name)}
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
