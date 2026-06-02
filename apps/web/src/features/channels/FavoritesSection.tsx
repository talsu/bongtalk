import { Link } from 'react-router-dom';
import {
  closestCenter,
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
import { useMemo } from 'react';
import type { Channel } from '@qufox/shared-types';
import { Icon } from '../../design-system/primitives';
import { cn } from '../../lib/cn';
import { useFavorites, useMoveFavorite } from './useFavorites';
import { deriveSidebarRowState } from './sidebarRowState';

/**
 * S43 (FR-CH-15): 사이드바 최상단 "즐겨찾기" 섹션.
 *
 * - 표시 대상: GET /me/favorites(position asc) ∩ 현재 워크스페이스 가시 채널.
 *   다른 워크스페이스 즐겨찾기는 channelsById 에 없어 자연히 제외된다.
 * - 정렬: 서버가 준 position asc 순서 그대로(useFavorites 가 정렬 보장).
 * - 드래그 재정렬: dnd-kit 으로 같은 섹션 안에서만 이동. 드롭 시
 *   beforeId/afterId 를 계산해 PATCH /favorite/position 으로 fractional 재배치.
 * - 빈 목록이면 섹션 자체를 렌더하지 않는다(사이드바 공간 절약).
 * - unread/mention/뮤트 시각 표시는 채널 목록과 동일 규칙(deriveSidebarRowState)
 *   을 재사용해 일관성을 지킨다. 즐겨찾기 행 컨텍스트 메뉴는 본 슬라이스 범위
 *   밖(채널 목록 메뉴에서 추가/해제 가능) — 행은 네비게이션 + 드래그에 집중.
 */
type Props = {
  workspaceId: string;
  workspaceSlug: string;
  channelsById: Map<string, Channel>;
  activeChannelName: string | null;
  unreadByChannel: Map<string, { count: number; mentionCount: number }>;
  mutedChannelIds: Set<string>;
};

function FavoriteRow({
  channel,
  workspaceSlug,
  active,
  showUnreadStyle,
  mentionBadgeCount,
  muted,
}: {
  channel: Channel;
  workspaceSlug: string;
  active: boolean;
  showUnreadStyle: boolean;
  mentionBadgeCount: number;
  muted: boolean;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({
    id: channel.id,
    data: { type: 'favorite', channelId: channel.id },
  });
  return (
    <li
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{ opacity: isDragging ? 0.4 : 1 }}
      aria-current={active ? 'page' : undefined}
      data-active={active ? 'true' : undefined}
      data-testid={`favorite-${channel.name}`}
      data-muted={muted ? 'true' : 'false'}
      className={cn(
        'qf-channel group relative',
        active && 'bg-[var(--bg-selected)] text-[var(--text-strong)]',
        showUnreadStyle && !active && 'qf-channel--unread',
        muted && !active && 'text-[color:var(--text-muted)]',
        isDragging ? 'cursor-grabbing' : 'cursor-grab',
      )}
    >
      <Link
        to={`/w/${workspaceSlug}/${channel.name}`}
        tabIndex={-1}
        aria-label={`# ${channel.name} 채널 열기`}
        className="absolute inset-0"
      />
      <span className="qf-channel__prefix pointer-events-none relative">
        <Icon name="star" size="sm" solid aria-hidden className="shrink-0" />
      </span>
      <span className="pointer-events-none relative flex-1 truncate">&nbsp;{channel.name}</span>
      <span className="qf-channel__suffix pointer-events-auto relative z-10">
        {muted ? (
          <Icon
            name="bell-off"
            size="sm"
            aria-label="뮤트됨"
            data-testid={`favorite-muted-${channel.name}`}
            className="qf-icon--muted relative shrink-0"
          />
        ) : null}
        {mentionBadgeCount > 0 ? (
          <span
            data-testid="favorite-pill-mention"
            aria-label={`읽지 않은 멘션 ${mentionBadgeCount}개`}
            className="qf-badge qf-badge--count"
          >
            {mentionBadgeCount > 99 ? '99+' : mentionBadgeCount}
          </span>
        ) : null}
      </span>
    </li>
  );
}

export function FavoritesSection({
  workspaceId,
  workspaceSlug,
  channelsById,
  activeChannelName,
  unreadByChannel,
  mutedChannelIds,
}: Props): JSX.Element | null {
  const { data } = useFavorites();
  const moveFavoriteMut = useMoveFavorite(workspaceId);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // 서버 position asc 순서를 유지하면서 현재 워크스페이스에 보이는 채널만 추린다.
  const rows = useMemo(() => {
    const out: Channel[] = [];
    for (const f of data?.items ?? []) {
      const ch = channelsById.get(f.channelId);
      if (ch) out.push(ch);
    }
    return out;
  }, [data, channelsById]);

  if (rows.length === 0) return null;

  async function handleDragEnd(evt: DragEndEvent): Promise<void> {
    const { active, over } = evt;
    if (!over || active.id === over.id) return;
    const ids = rows.map((c) => c.id);
    const fromIdx = ids.indexOf(active.id as string);
    const toIdx = ids.indexOf(over.id as string);
    if (fromIdx < 0 || toIdx < 0) return;
    const newOrder = arrayMove(ids, fromIdx, toIdx);
    const newIndex = newOrder.indexOf(active.id as string);
    // 채널 move 와 동일 anchor 규약: 뒤 항목 = beforeId, 앞 항목 = afterId.
    const before = newOrder[newIndex + 1];
    const after = newOrder[newIndex - 1];
    await moveFavoriteMut
      .mutateAsync({
        channelId: active.id as string,
        input: before ? { beforeId: before } : after ? { afterId: after } : {},
      })
      .catch(() => undefined);
  }

  return (
    <section
      data-testid="favorites-section"
      aria-label="즐겨찾기"
      className="rounded-[var(--r-md)]"
    >
      <div className="qf-category flex items-center justify-between pr-[var(--s-2)]">
        <span className="flex min-w-0 flex-1 items-center truncate">즐겨찾기</span>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={rows.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          <ul className="mt-1 min-h-[var(--s-5)]">
            {rows.map((ch) => {
              const u = unreadByChannel.get(ch.id);
              const isActive = activeChannelName === ch.name;
              const rowState = deriveSidebarRowState({
                unreadCount: isActive ? 0 : (u?.count ?? 0),
                mentionCount: isActive ? 0 : (u?.mentionCount ?? 0),
                muted: mutedChannelIds.has(ch.id),
              });
              return (
                <FavoriteRow
                  key={ch.id}
                  channel={ch}
                  workspaceSlug={workspaceSlug}
                  active={isActive}
                  showUnreadStyle={rowState.showUnreadStyle}
                  mentionBadgeCount={rowState.mentionBadgeCount}
                  muted={mutedChannelIds.has(ch.id)}
                />
              );
            })}
          </ul>
        </SortableContext>
      </DndContext>
    </section>
  );
}
