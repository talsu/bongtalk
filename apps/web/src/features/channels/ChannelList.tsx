import { Link } from 'react-router-dom';
import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  PointerSensor,
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
import { useChannelList, useMoveChannel } from './useChannels';
import { useUnreadSummary } from './useUnread';
import { CreateChannelModal } from './CreateChannelModal';
import { CreateCategoryModal } from './CreateCategoryModal';
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
 * - Uncategorized channels live under a synthesized "채널" group
 *   treated identically to real categories — every section header
 *   shows a right-aligned `+` that opens the channel-create modal
 *   scoped to that section.
 * - List footer has a compact `+` button that opens the category-
 *   create modal.
 * - Channels drag within AND across sections. The default group's
 *   dnd id is `ROOT_CATEGORY_ID`; real category rows use their uuid.
 *   On drop we POST `/channels/:id/move` with `{ categoryId,
 *   beforeId, afterId }`, the same endpoint used for in-section
 *   reordering since 008. Cross-section drops just flip categoryId.
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

function SectionHeader({
  label,
  onAddChannel,
  canManage,
  testId,
}: {
  label: string;
  onAddChannel: () => void;
  canManage: boolean;
  testId: string;
}): JSX.Element {
  return (
    <div className="qf-category flex items-center justify-between pr-[var(--s-2)]">
      <span className="truncate">{label}</span>
      {canManage ? (
        <button
          type="button"
          onClick={onAddChannel}
          data-testid={testId}
          aria-label={`${label}에 채널 추가`}
          className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
        >
          +
        </button>
      ) : null}
    </div>
  );
}

function ChannelSection({
  sectionId,
  label,
  channels,
  workspaceSlug,
  activeChannelName,
  unreadByChannel,
  canManage,
  onAddChannel,
  testIdPrefix,
}: {
  sectionId: string;
  label: string;
  channels: Channel[];
  workspaceSlug: string;
  activeChannelName: string | null;
  unreadByChannel: Map<string, { count: number; mention: boolean }>;
  canManage: boolean;
  onAddChannel: () => void;
  testIdPrefix: string;
}): JSX.Element {
  return (
    <section data-testid={`${testIdPrefix}-section`} data-section-id={sectionId}>
      <SectionHeader
        label={label}
        onAddChannel={onAddChannel}
        canManage={canManage}
        testId={`${testIdPrefix}-add`}
      />
      <SortableContext items={channels.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <ul className="mt-1">
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
  const moveMut = useMoveChannel(workspaceId);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const [channelModal, setChannelModal] = useState<null | {
    categoryId: string | null;
    categoryLabel: string;
  }>(null);
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);

  const uncategorized = useMemo(() => data?.uncategorized ?? [], [data]);
  const categories = useMemo(() => data?.categories ?? [], [data]);

  // Flat (channelId → sectionId) map so drag-end can resolve new positions
  // without re-walking React nodes.
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

  async function handleDragEnd(evt: DragEndEvent): Promise<void> {
    const { active, over } = evt;
    if (!over) return;
    const activeId = active.id as string;
    const overId = over.id as string;
    if (activeId === overId) return;

    const fromSection = sectionOf.get(activeId);
    if (!fromSection) return;

    // overId might be another channel id OR (future) a section container
    // id when an empty section is dropped into.
    let toSection = sectionOf.get(overId);
    if (!toSection) {
      if (overId === ROOT_CATEGORY_ID || channelsBySection.has(overId)) {
        toSection = overId;
      }
    }
    if (!toSection) return;

    const sourceList = (channelsBySection.get(fromSection) ?? []).slice();
    const targetList = (channelsBySection.get(toSection) ?? []).slice();

    let newOrder: Channel[];
    let newIndex: number;
    if (fromSection === toSection) {
      const fromIdx = sourceList.findIndex((c) => c.id === activeId);
      const toIdx = sourceList.findIndex((c) => c.id === overId);
      if (fromIdx < 0 || toIdx < 0) return;
      newOrder = arrayMove(sourceList, fromIdx, toIdx);
      newIndex = newOrder.findIndex((c) => c.id === activeId);
    } else {
      const moved = sourceList.find((c) => c.id === activeId);
      if (!moved) return;
      const overIdx = targetList.findIndex((c) => c.id === overId);
      const insertAt = overIdx >= 0 ? overIdx : targetList.length;
      newOrder = [...targetList.slice(0, insertAt), moved, ...targetList.slice(insertAt)];
      newIndex = insertAt;
    }

    // Gap-based position algorithm (task-008): caller supplies the
    // neighbour channel ids; server picks a midpoint between their
    // Decimal `position` values. beforeId / afterId are mutually
    // exclusive per the schema — pick one.
    const before = newOrder[newIndex + 1]?.id;
    const after = newOrder[newIndex - 1]?.id;

    await moveMut
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
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={handleDragEnd}>
        <nav className="flex flex-col gap-3" data-testid="channel-sidebar" aria-label="채널">
          <ChannelSection
            sectionId={ROOT_CATEGORY_ID}
            label="채널"
            channels={uncategorized}
            workspaceSlug={workspaceSlug}
            activeChannelName={activeChannelName}
            unreadByChannel={unreadByChannel}
            canManage={canManage}
            onAddChannel={() => openChannelCreate(null, '채널')}
            testIdPrefix="channel-default"
          />
          {categories.map((cat) => (
            <ChannelSection
              key={cat.id}
              sectionId={cat.id}
              label={cat.name}
              channels={cat.channels}
              workspaceSlug={workspaceSlug}
              activeChannelName={activeChannelName}
              unreadByChannel={unreadByChannel}
              canManage={canManage}
              onAddChannel={() => openChannelCreate(cat.id, cat.name)}
              testIdPrefix={`channel-cat-${cat.name}`}
            />
          ))}
          {canManage ? (
            <button
              type="button"
              data-testid="category-create-btn"
              aria-label="카테고리 추가"
              onClick={() => setCategoryModalOpen(true)}
              className="qf-btn qf-btn--ghost qf-btn--sm mx-[var(--s-2)] mt-[var(--s-3)] justify-center"
            >
              +
            </button>
          ) : null}
        </nav>
      </DndContext>

      <CreateChannelModal
        workspaceId={workspaceId}
        categoryId={channelModal?.categoryId ?? null}
        categoryLabel={channelModal?.categoryLabel ?? '채널'}
        open={channelModal !== null}
        onClose={() => setChannelModal(null)}
      />
      <CreateCategoryModal
        workspaceId={workspaceId}
        open={categoryModalOpen}
        onClose={() => setCategoryModalOpen(false)}
      />
    </>
  );
}
