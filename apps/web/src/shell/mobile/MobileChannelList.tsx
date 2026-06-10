import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Workspace } from '@qufox/shared-types';
import { useChannelList } from '../../features/channels/useChannels';
import { useUnreadSummary } from '../../features/channels/useUnread';
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
}: {
  workspace: Pick<Workspace, 'id' | 'name' | 'slug'>;
  workspaces: Pick<Workspace, 'id' | 'name' | 'slug'>[];
  activeChannelName: string | null;
  onPick: () => void;
  /** 071-M2 E5 (FR-IA-MOB-03): server-header 의 + 액션 — 채널 둘러보기 오픈. */
  onBrowse?: () => void;
}): JSX.Element {
  const { data } = useChannelList(workspace.id);
  const { data: unread } = useUnreadSummary(workspace.id);
  const [filter, setFilter] = useState('');
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
        <span className="qf-m-server-header__name">{workspace.name}</span>
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
        >
          <span className="qf-avatar qf-avatar--sm grid place-items-center bg-bg-subtle">
            <Icon name="message" size="sm" />
          </span>
          <span
            style={{ maxWidth: 'var(--s-10)' }}
            className="text-[length:var(--fs-11)] text-text-muted truncate"
          >
            DM
          </span>
        </Link>
        {workspaces.map((w) => (
          <Link
            key={w.id}
            to={`/w/${w.slug}`}
            onClick={onPick}
            className={cn(
              'inline-flex flex-col items-center gap-1 p-1 rounded-[var(--r-md)]',
              w.slug === workspace.slug ? 'bg-bg-accent' : '',
            )}
            data-testid={`mobile-ws-${w.slug}`}
          >
            <Avatar name={w.name} size="sm" />
            <span
              style={{ maxWidth: 'var(--s-10)' }}
              className="text-[length:var(--fs-11)] text-text-muted truncate"
            >
              {w.name}
            </span>
          </Link>
        ))}
      </nav>

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
                  onPick={onPick}
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
                  onPick={onPick}
                />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function ChannelRow({
  slug,
  name,
  active,
  unread,
  onPick,
}: {
  slug: string;
  name: string;
  active: boolean;
  unread?: { count: number; mention: boolean };
  onPick: () => void;
}): JSX.Element {
  const hasUnread = (unread?.count ?? 0) > 0;
  return (
    <li>
      <Link
        to={`/w/${slug}/${name}`}
        onClick={onPick}
        aria-selected={active || undefined}
        data-testid={`mobile-channel-${name}`}
        className={cn('qf-m-row', hasUnread && !active && 'qf-m-row--unread')}
      >
        <Icon name="hash" size="sm" className="text-text-muted" />
        <div className="min-w-0 flex-1">
          <div className="qf-m-row__primary">{name}</div>
        </div>
        <div className="qf-m-row__aside">
          {hasUnread ? (
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
