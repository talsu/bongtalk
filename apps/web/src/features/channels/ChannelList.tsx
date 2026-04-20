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
import { useUnreadSummary } from './useUnread';
import { Button, Input } from '../../design-system/primitives';
import { cn } from '../../lib/cn';

type Props = {
  workspaceId: string;
  workspaceSlug: string;
  canManage: boolean;
  activeChannelName: string | null;
};

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

function ChannelRow({
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
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: channel.id,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };
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

export function ChannelList({
  workspaceId,
  workspaceSlug,
  canManage,
  activeChannelName,
}: Props): JSX.Element {
  const { data } = useChannelList(workspaceId);
  const { data: unread } = useUnreadSummary(workspaceId);
  const createChannelMut = useCreateChannel(workspaceId);
  const createCategoryMut = useCreateCategory(workspaceId);
  const moveMut = useMoveChannel(workspaceId);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const [newChannel, setNewChannel] = useState('');
  const [newCategory, setNewCategory] = useState('');

  const uncategorized = useMemo(() => data?.uncategorized ?? [], [data]);
  const unreadByChannel = useMemo(() => {
    const m = new Map<string, { count: number; mention: boolean }>();
    for (const u of unread?.channels ?? []) {
      m.set(u.channelId, { count: u.unreadCount, mention: u.hasMention });
    }
    return m;
  }, [unread]);

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
          <h3 className="qf-category">{cat.name}</h3>
          <ul className="mt-1">
            {cat.channels.map((ch) => {
              const u = unreadByChannel.get(ch.id);
              const active = activeChannelName === ch.name;
              const hasUnread = !active && (u?.count ?? 0) > 0;
              const hasMention = hasUnread && u?.mention === true;
              return (
                <li
                  key={ch.id}
                  aria-selected={active || undefined}
                  className={cn('qf-channel', hasUnread && 'qf-channel--unread')}
                  data-testid={`channel-${ch.name}`}
                  data-unread={hasUnread ? 'true' : 'false'}
                  data-mention={hasMention ? 'true' : 'false'}
                >
                  <Link to={`/w/${workspaceSlug}/${ch.name}`} className="flex-1 truncate">
                    <span className="qf-channel__prefix">#</span>&nbsp;{ch.name}
                    {hasUnread && (
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
                    <UnreadIndicator count={u?.count ?? 0} hasMention={u?.mention ?? false} />
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <section>
        <h3 className="qf-category">채널</h3>
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <SortableContext
            items={uncategorized.map((c) => c.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul className="mt-1">
              {uncategorized.map((ch) => {
                const u = unreadByChannel.get(ch.id);
                return (
                  <ChannelRow
                    key={ch.id}
                    channel={ch}
                    workspaceSlug={workspaceSlug}
                    active={activeChannelName === ch.name}
                    unreadCount={u?.count ?? 0}
                    hasMention={u?.mention ?? false}
                  />
                );
              })}
            </ul>
          </SortableContext>
        </DndContext>

        {canManage && (
          <div className="mt-2 flex flex-col gap-2 px-2" data-testid="channel-create-panel">
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
                className="h-8 text-[13px]"
              />
              <Button
                data-testid="new-channel-submit"
                type="submit"
                variant="primary"
                size="sm"
                aria-label="채널 생성"
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
                className="h-8 text-[13px]"
              />
              <Button
                data-testid="new-category-submit"
                type="submit"
                variant="secondary"
                size="sm"
                aria-label="카테고리 생성"
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
