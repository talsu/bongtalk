import { Link } from 'react-router-dom';
import type { Workspace } from '@qufox/shared-types';
import { useChannelList } from '../../features/channels/useChannels';
import { useUnreadSummary } from '../../features/channels/useUnread';
import { Icon, Avatar } from '../../design-system/primitives';
import { cn } from '../../lib/cn';

/**
 * Mobile left drawer content: workspace selector (small avatar rail)
 * + channel list for the active workspace. Each row is a full
 * qf-m-channel row; tapping dismisses the drawer via onPick.
 */
export function MobileChannelList({
  workspace,
  workspaces,
  activeChannelName,
  onPick,
}: {
  workspace: Pick<Workspace, 'id' | 'name' | 'slug'>;
  workspaces: Pick<Workspace, 'id' | 'name' | 'slug'>[];
  activeChannelName: string | null;
  onPick: () => void;
}): JSX.Element {
  const { data } = useChannelList(workspace.id);
  const { data: unread } = useUnreadSummary(workspace.id);
  const unreadByChannel = new Map<string, { count: number; mention: boolean }>();
  for (const u of unread?.channels ?? []) {
    unreadByChannel.set(u.channelId, { count: u.unreadCount, mention: u.hasMention });
  }

  const uncategorized = data?.uncategorized ?? [];
  const categories = data?.categories ?? [];

  return (
    <div>
      {/* Workspace row strip */}
      <div className="qf-m-section">
        <div>{workspace.name}</div>
      </div>
      {workspaces.length > 1 ? (
        <nav
          aria-label="워크스페이스 선택"
          className="px-[var(--s-4)] py-[var(--s-2)] flex gap-[var(--s-2)] overflow-x-auto"
        >
          {workspaces.map((w) => (
            <Link
              key={w.id}
              to={`/w/${w.slug}`}
              onClick={onPick}
              className={cn(
                'inline-flex flex-col items-center gap-1 p-1 rounded-[var(--r-md)]',
                w.slug === workspace.slug ? 'bg-bg-selected' : '',
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
      ) : null}

      {/* Default / uncategorized */}
      {uncategorized.length > 0 ? (
        <>
          <div className="qf-m-section">
            <div>채널</div>
          </div>
          <ul role="list">
            {uncategorized.map((c) => (
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

      {/* Categories */}
      {categories.map((cat) => (
        <div key={cat.id}>
          <div className="qf-m-section">
            <div>{cat.name}</div>
          </div>
          <ul role="list">
            {cat.channels.map((c) => (
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
      ))}
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
        className={cn('qf-m-channel', hasUnread && !active && 'qf-m-channel--unread')}
      >
        <Icon name="hash" size="sm" className="qf-m-channel__prefix text-text-muted" />
        <span className="flex-1 truncate">{name}</span>
        {hasUnread ? (
          <span
            className="qf-badge qf-badge--count"
            data-testid={unread?.mention ? 'mobile-unread-mention' : 'mobile-unread'}
          >
            {unread!.count > 99 ? '99+' : unread!.count}
          </span>
        ) : null}
      </Link>
    </li>
  );
}
