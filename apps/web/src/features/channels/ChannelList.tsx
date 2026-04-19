import { Link } from 'react-router-dom';
import { DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMemo, useState } from 'react';
import type { Channel } from '@qufox/shared-types';
import { useChannelList, useCreateCategory, useCreateChannel, useMoveChannel } from './useChannels';
import { Button, Input } from '../../design-system/primitives';
import { cn } from '../../lib/cn';

type Props = {
  workspaceId: string;
  workspaceSlug: string;
  canManage: boolean;
  activeChannelName: string | null;
};

/**
 * Channel / category list. Was called `ChannelSidebar` pre-task-008 — the
 * column frame is now provided by `shell/ChannelColumn.tsx` so this file
 * is purely the list, reusable in other layouts (e.g. command palette).
 *
 * Drag handle stays on uncategorized channels only for task-008. Dragging
 * into/out of categories is TODO(task-016).
 */
function ChannelRow({
  channel,
  workspaceSlug,
  active,
}: {
  channel: Channel;
  workspaceSlug: string;
  active: boolean;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: channel.id,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        'group flex items-center gap-1 rounded-md px-2 py-1 text-sm',
        active
          ? 'bg-bg-accent text-foreground'
          : 'text-text-muted hover:bg-bg-accent hover:text-foreground',
      )}
      data-testid={`channel-${channel.name}`}
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
        <span className="text-text-muted">#</span>&nbsp;{channel.name}
      </Link>
    </li>
  );
}

export function ChannelList({
  workspaceId,
  workspaceSlug,
  canManage,
  activeChannelName,
}: Props): JSX.Element {
  const { data } = useChannelList(workspaceId);
  const createChannelMut = useCreateChannel(workspaceId);
  const createCategoryMut = useCreateCategory(workspaceId);
  const moveMut = useMoveChannel(workspaceId);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const [newChannel, setNewChannel] = useState('');
  const [newCategory, setNewCategory] = useState('');

  const uncategorized = useMemo(() => data?.uncategorized ?? [], [data]);

  async function handleDragEnd(evt: DragEndEvent): Promise<void> {
    const { active, over } = evt;
    if (!over || active.id === over.id) return;
    const ids = uncategorized.map((c) => c.id);
    const from = ids.indexOf(active.id as string);
    const to = ids.indexOf(over.id as string);
    if (from < 0 || to < 0) return;
    const newOrder = arrayMove(ids, from, to);
    const movedId = active.id as string;
    const newIndex = newOrder.indexOf(movedId);
    const before = newOrder[newIndex + 1];
    const after = newOrder[newIndex - 1];
    await moveMut.mutateAsync({
      id: movedId,
      input: { beforeId: before, afterId: after },
    });
  }

  return (
    <nav className="flex flex-col gap-3" data-testid="channel-sidebar" aria-label="채널">
      {(data?.categories ?? []).map((cat) => (
        <section key={cat.id}>
          <h3 className="px-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
            {cat.name}
          </h3>
          <ul className="mt-1 space-y-0.5">
            {cat.channels.map((ch) => (
              <li
                key={ch.id}
                className={cn(
                  'rounded-md px-2 py-1 text-sm',
                  activeChannelName === ch.name
                    ? 'bg-bg-accent text-foreground'
                    : 'text-text-muted hover:bg-bg-accent hover:text-foreground',
                )}
                data-testid={`channel-${ch.name}`}
              >
                <Link to={`/w/${workspaceSlug}/${ch.name}`}>
                  <span className="text-text-muted">#</span>&nbsp;{ch.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <section>
        <h3 className="px-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
          채널
        </h3>
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <SortableContext
            items={uncategorized.map((c) => c.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="mt-1 space-y-0.5">
              {uncategorized.map((ch) => (
                <ChannelRow
                  key={ch.id}
                  channel={ch}
                  workspaceSlug={workspaceSlug}
                  active={activeChannelName === ch.name}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>

        {canManage && (
          <div className="mt-2 space-y-2 px-2" data-testid="channel-create-panel">
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!newChannel) return;
                await createChannelMut.mutateAsync({ name: newChannel, type: 'TEXT' });
                setNewChannel('');
              }}
              className="flex gap-1"
            >
              <Input
                data-testid="new-channel-name"
                type="text"
                value={newChannel}
                onChange={(e) => setNewChannel(e.target.value)}
                placeholder="new-channel"
                className="h-7 text-xs"
              />
              <Button
                data-testid="new-channel-submit"
                type="submit"
                variant="primary"
                size="sm"
                aria-label="채널 생성"
                className="h-7 px-2 text-xs"
              >
                +
              </Button>
            </form>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!newCategory) return;
                await createCategoryMut.mutateAsync({ name: newCategory });
                setNewCategory('');
              }}
              className="flex gap-1"
            >
              <Input
                data-testid="new-category-name"
                type="text"
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                placeholder="category name"
                className="h-7 text-xs"
              />
              <Button
                data-testid="new-category-submit"
                type="submit"
                variant="secondary"
                size="sm"
                aria-label="카테고리 생성"
                className="h-7 px-2 text-xs"
              >
                + cat
              </Button>
            </form>
          </div>
        )}
      </section>
    </nav>
  );
}
