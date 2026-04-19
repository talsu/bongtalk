import { Link, useParams } from 'react-router-dom';
import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMemo, useState } from 'react';
import type { Channel } from '@qufox/shared-types';
import { useChannelList, useCreateCategory, useCreateChannel, useMoveChannel } from './useChannels';

type Props = {
  workspaceId: string;
  workspaceSlug: string;
  canManage: boolean;
};

function ChannelRow({
  channel,
  workspaceSlug,
  active,
}: {
  channel: Channel;
  workspaceSlug: string;
  active: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: channel.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-1 rounded px-2 py-1 text-sm ${
        active ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'
      }`}
      data-testid={`channel-${channel.name}`}
    >
      <span
        {...attributes}
        {...listeners}
        data-testid={`channel-drag-${channel.name}`}
        className="cursor-grab text-slate-400"
      >
        ⋮⋮
      </span>
      <Link to={`/w/${workspaceSlug}/${channel.name}`} className="flex-1 truncate">
        # {channel.name}
      </Link>
    </li>
  );
}

export function ChannelSidebar({ workspaceId, workspaceSlug, canManage }: Props): JSX.Element {
  const { channelName } = useParams();
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
    <nav className="flex flex-col gap-3 py-3" data-testid="channel-sidebar">
      {(data?.categories ?? []).map((cat) => (
        <section key={cat.id}>
          <h3 className="px-2 text-xs uppercase tracking-wide text-slate-500">{cat.name}</h3>
          <ul className="mt-1 space-y-0.5">
            {cat.channels.map((ch) => (
              <li
                key={ch.id}
                className={`rounded px-2 py-1 text-sm ${
                  channelName === ch.name ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'
                }`}
                data-testid={`channel-${ch.name}`}
              >
                <Link to={`/w/${workspaceSlug}/${ch.name}`}># {ch.name}</Link>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <section>
        <h3 className="px-2 text-xs uppercase tracking-wide text-slate-500">Channels</h3>
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
                  active={channelName === ch.name}
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
              <input
                data-testid="new-channel-name"
                type="text"
                value={newChannel}
                onChange={(e) => setNewChannel(e.target.value)}
                placeholder="new-channel"
                className="flex-1 rounded border border-slate-300 px-2 py-1 text-xs"
              />
              <button
                data-testid="new-channel-submit"
                type="submit"
                className="rounded bg-slate-900 px-2 py-1 text-xs text-white"
              >
                +
              </button>
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
              <input
                data-testid="new-category-name"
                type="text"
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                placeholder="category name"
                className="flex-1 rounded border border-slate-300 px-2 py-1 text-xs"
              />
              <button
                data-testid="new-category-submit"
                type="submit"
                className="rounded border border-slate-300 px-2 py-1 text-xs"
              >
                + cat
              </button>
            </form>
          </div>
        )}
      </section>
    </nav>
  );
}
