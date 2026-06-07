import { Link } from 'react-router-dom';
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useMemo, useState } from 'react';
import type { Channel, SidebarSection } from '@qufox/shared-types';
import {
  Icon,
  DropdownRoot,
  DropdownTrigger,
  DropdownContent,
  DropdownItem,
} from '../../design-system/primitives';
import { cn } from '../../lib/cn';
import { deriveSidebarRowState } from './sidebarRowState';
import { computeSectionChannelOrder } from './sidebarSectionOrder';
import {
  useDeleteSidebarSection,
  useMoveSidebarChannel,
  useMoveSidebarSection,
  useSidebarSections,
  useUnassignSidebarChannel,
  useUpdateSidebarSection,
} from './useSidebarSections';

/**
 * S85 (FR-CH-16): 사이드바 개인 섹션.
 *
 * - Favorites 아래·카테고리 위에 렌더한다(개인 그룹 영역). 전부 per-user(타인 미노출).
 * - 섹션 헤더: 이모지 + 이름 + collapse 토글 + 옵션 메뉴(이름변경/삭제). 섹션 자체를
 *   드래그해 순서를 바꾼다(섹션 SortableContext).
 * - 섹션 내 채널: 각 섹션 안에서 드래그 재정렬(채널 SortableContext). 채널을 다른
 *   섹션으로 옮기는 교차 이동은 본 컴포넌트에서 같은 섹션 내 재정렬 + 메뉴 해제로
 *   충분히 표현되며, 교차 섹션 드래그는 후속 확장으로 둔다(BE moveChannel 은 지원).
 * - sortMode=ALPHABETICAL 섹션은 표시 시 채널명 가나다 정렬을 적용한다(저장 position
 *   무관 — 드래그 비활성). MANUAL 은 서버 position 순서 + 드래그 재정렬.
 * - 섹션이 0개면 아무것도 렌더하지 않는다(생성 UI 는 ChannelList 워크스페이스 메뉴/
 *   본 컴포넌트 상단 + 버튼 — 여기서는 표시·재정렬·관리에 집중).
 */
type Props = {
  workspaceId: string;
  workspaceSlug: string;
  channelsById: Map<string, Channel>;
  activeChannelName: string | null;
  unreadByChannel: Map<string, { count: number; mentionCount: number }>;
  mutedChannelIds: Set<string>;
};

function SectionChannelRow({
  channel,
  workspaceSlug,
  active,
  showUnreadStyle,
  mentionBadgeCount,
  muted,
  draggable,
}: {
  channel: Channel;
  workspaceSlug: string;
  active: boolean;
  showUnreadStyle: boolean;
  mentionBadgeCount: number;
  muted: boolean;
  draggable: boolean;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({
    id: channel.id,
    data: { type: 'sidebar-channel', channelId: channel.id },
    disabled: !draggable,
  });
  return (
    <li
      ref={setNodeRef}
      {...(draggable ? { ...attributes, ...listeners } : {})}
      style={{ opacity: isDragging ? 0.4 : 1 }}
      aria-current={active ? 'page' : undefined}
      data-active={active ? 'true' : undefined}
      data-testid={`sidebar-section-channel-${channel.name}`}
      data-muted={muted ? 'true' : 'false'}
      className={cn(
        'qf-channel group relative',
        active && 'bg-[var(--bg-selected)] text-[var(--text-strong)]',
        showUnreadStyle && !active && 'qf-channel--unread',
        muted && !active && 'text-[color:var(--text-muted)]',
        draggable ? (isDragging ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-pointer',
      )}
    >
      <Link
        to={`/w/${workspaceSlug}/${channel.name}`}
        tabIndex={-1}
        aria-label={`# ${channel.name} 채널 열기`}
        className="absolute inset-0"
      />
      <span className="qf-channel__prefix pointer-events-none relative">#</span>
      <span className="pointer-events-none relative flex-1 truncate">&nbsp;{channel.name}</span>
      <span className="qf-channel__suffix pointer-events-auto relative z-10">
        {muted ? (
          <Icon
            name="bell-off"
            size="sm"
            aria-label="뮤트됨"
            className="qf-icon--muted relative shrink-0"
          />
        ) : null}
        {mentionBadgeCount > 0 ? (
          <span
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

function SectionBlock({
  section,
  workspaceId,
  workspaceSlug,
  channelsById,
  activeChannelName,
  unreadByChannel,
  mutedChannelIds,
}: {
  section: SidebarSection;
  workspaceId: string;
  workspaceSlug: string;
  channelsById: Map<string, Channel>;
  activeChannelName: string | null;
  unreadByChannel: Map<string, { count: number; mentionCount: number }>;
  mutedChannelIds: Set<string>;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({
    id: section.id,
    data: { type: 'sidebar-section', sectionId: section.id },
  });
  const [collapsed, setCollapsed] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(section.name);
  const [menuOpen, setMenuOpen] = useState(false);

  const updateMut = useUpdateSidebarSection(workspaceId);
  const deleteMut = useDeleteSidebarSection(workspaceId);
  const moveChannelMut = useMoveSidebarChannel(workspaceId);
  const unassignMut = useUnassignSidebarChannel(workspaceId);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const isAlpha = section.sortMode === 'ALPHABETICAL';

  // 섹션에 속한 채널(현재 워크스페이스 가시 채널만). MANUAL = 서버 position 순서,
  // ALPHABETICAL = 채널명 로캘 정렬(표시 시점 적용 · 저장 position 무관).
  const rows = useMemo(() => {
    const out: Channel[] = [];
    for (const id of section.channelIds) {
      const ch = channelsById.get(id);
      if (ch) out.push(ch);
    }
    if (isAlpha) {
      return [...out].sort((a, b) => a.name.localeCompare(b.name));
    }
    return out;
  }, [section.channelIds, channelsById, isAlpha]);

  function commitRename(): void {
    const next = draftName.trim();
    setRenaming(false);
    if (next.length === 0 || next === section.name) {
      setDraftName(section.name);
      return;
    }
    updateMut.mutate({ sectionId: section.id, input: { name: next } });
  }

  async function handleChannelDragEnd(evt: DragEndEvent): Promise<void> {
    const { active, over } = evt;
    if (!over) return;
    const anchor = computeSectionChannelOrder(
      rows.map((c) => c.id),
      active.id as string,
      over.id as string,
    );
    if (!anchor) return;
    await moveChannelMut
      .mutateAsync({ channelId: active.id as string, input: anchor })
      .catch(() => undefined);
  }

  return (
    <section
      ref={setNodeRef}
      style={{ opacity: isDragging ? 0.4 : 1 }}
      data-testid={`sidebar-section-${section.id}`}
      data-sort-mode={section.sortMode}
      aria-label={section.name}
      className="rounded-[var(--r-md)]"
    >
      <div className="qf-category flex items-center justify-between pr-[var(--s-2)]">
        <span
          {...attributes}
          {...listeners}
          data-testid={`sidebar-section-drag-${section.id}`}
          aria-label={`섹션 ${section.name} 드래그`}
          className="cursor-grab pl-[var(--s-1)]"
        >
          <Icon name="grid" size="sm" className="qf-icon--muted" aria-hidden />
        </span>
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          data-testid={`sidebar-section-collapse-${section.id}`}
          aria-label={`섹션 ${section.name} ${collapsed ? '펼치기' : '접기'}`}
          className="flex min-w-0 flex-1 items-center truncate bg-transparent pl-[var(--s-1)] text-left"
        >
          <span className="pointer-events-none flex shrink-0 items-center">
            <Icon
              name="chevron-down"
              size="sm"
              aria-hidden
              className={cn('qf-icon--muted shrink-0', collapsed && '-rotate-90')}
            />
          </span>
          {section.emoji ? (
            <span aria-hidden className="shrink-0 pl-[var(--s-1)]">
              {section.emoji}
            </span>
          ) : null}
          {renaming ? null : <span className="truncate pl-[var(--s-1)]">{section.name}</span>}
        </button>
        {renaming ? (
          <input
            autoFocus
            aria-label="섹션 이름"
            data-testid={`sidebar-section-rename-input-${section.id}`}
            maxLength={100}
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') {
                setDraftName(section.name);
                setRenaming(false);
              }
            }}
            className="qf-input min-w-0 flex-1"
          />
        ) : null}
        <DropdownRoot open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownTrigger asChild>
            <button
              type="button"
              data-testid={`sidebar-section-menu-${section.id}`}
              aria-label="섹션 옵션"
              className="qf-row-iconbtn opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            >
              <Icon name="more" size="sm" />
            </button>
          </DropdownTrigger>
          <DropdownContent align="start">
            <DropdownItem
              onSelect={() => {
                setDraftName(section.name);
                setRenaming(true);
              }}
            >
              <span data-testid={`sidebar-section-rename-${section.id}`}>이름 변경</span>
            </DropdownItem>
            <DropdownItem onSelect={() => deleteMut.mutate(section.id)}>
              <span data-testid={`sidebar-section-delete-${section.id}`}>섹션 삭제</span>
            </DropdownItem>
          </DropdownContent>
        </DropdownRoot>
      </div>
      {collapsed ? null : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleChannelDragEnd}
        >
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
                  <div key={ch.id} className="group/row relative flex items-center">
                    <div className="min-w-0 flex-1">
                      <SectionChannelRow
                        channel={ch}
                        workspaceSlug={workspaceSlug}
                        active={isActive}
                        showUnreadStyle={rowState.showUnreadStyle}
                        mentionBadgeCount={rowState.mentionBadgeCount}
                        muted={mutedChannelIds.has(ch.id)}
                        draggable={!isAlpha}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        unassignMut.mutate({ sectionId: section.id, channelId: ch.id })
                      }
                      data-testid={`sidebar-section-unassign-${ch.name}`}
                      aria-label={`# ${ch.name} 섹션에서 제거`}
                      className="qf-row-iconbtn shrink-0 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
                    >
                      <Icon name="x" size="sm" aria-hidden />
                    </button>
                  </div>
                );
              })}
            </ul>
          </SortableContext>
        </DndContext>
      )}
    </section>
  );
}

export function SidebarSections({
  workspaceId,
  workspaceSlug,
  channelsById,
  activeChannelName,
  unreadByChannel,
  mutedChannelIds,
}: Props): JSX.Element | null {
  const { data } = useSidebarSections(workspaceId);
  const moveSectionMut = useMoveSidebarSection(workspaceId);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const sections = useMemo(() => data?.sections ?? [], [data]);

  if (sections.length === 0) return null;

  async function handleSectionDragEnd(evt: DragEndEvent): Promise<void> {
    const { active, over } = evt;
    if (!over) return;
    const anchor = computeSectionChannelOrder(
      sections.map((s) => s.id),
      active.id as string,
      over.id as string,
    );
    if (!anchor) return;
    await moveSectionMut
      .mutateAsync({ sectionId: active.id as string, input: anchor })
      .catch(() => undefined);
  }

  return (
    <div data-testid="sidebar-sections" aria-label="개인 섹션">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleSectionDragEnd}
      >
        <SortableContext items={sections.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          {sections.map((section) => (
            <SectionBlock
              key={section.id}
              section={section}
              workspaceId={workspaceId}
              workspaceSlug={workspaceSlug}
              channelsById={channelsById}
              activeChannelName={activeChannelName}
              unreadByChannel={unreadByChannel}
              mutedChannelIds={mutedChannelIds}
            />
          ))}
        </SortableContext>
      </DndContext>
    </div>
  );
}
