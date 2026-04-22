import { useMembers } from '../../features/workspaces/useWorkspaces';
import { usePresence } from '../../features/realtime/usePresence';
import { Avatar, Icon } from '../../design-system/primitives';
import { cn } from '../../lib/cn';

/**
 * Right-drawer member list. qf-m-row per member with presence-aware
 * primary colour. Presence comes from the same cache the desktop
 * MemberColumn reads.
 */
export function MobileMembers({ workspaceId }: { workspaceId: string }): JSX.Element {
  const { data: members } = useMembers(workspaceId);
  const { onlineUserIds, dndUserIds } = usePresence(workspaceId);

  const list = members?.members ?? [];
  const online = list.filter((m) => onlineUserIds.has(m.userId));
  const offline = list.filter((m) => !onlineUserIds.has(m.userId));

  const status = (userId: string): 'online' | 'dnd' | 'offline' => {
    if (dndUserIds.has(userId)) return 'dnd';
    if (onlineUserIds.has(userId)) return 'online';
    return 'offline';
  };

  return (
    <div>
      <div className="qf-m-section">
        <div>멤버 · {list.length}</div>
      </div>
      {online.length > 0 ? (
        <>
          <div className="qf-m-section">
            <div>온라인 — {online.length}</div>
          </div>
          {online.map((m) => (
            <div
              key={m.userId}
              data-testid={`mobile-member-${m.user.username}`}
              data-presence={status(m.userId)}
              className="qf-m-row"
            >
              <Avatar name={m.user.username} size="sm" status={status(m.userId)} />
              <div className="min-w-0 flex-1">
                <div className="qf-m-row__primary">{m.user.username}</div>
                <div className="qf-m-row__secondary">{m.role}</div>
              </div>
              {m.role === 'OWNER' ? (
                <div className="qf-m-row__aside" aria-label="Owner">
                  <Icon name="crown" size="sm" />
                </div>
              ) : null}
            </div>
          ))}
        </>
      ) : null}
      {offline.length > 0 ? (
        <>
          <div className="qf-m-section">
            <div>오프라인 — {offline.length}</div>
          </div>
          {offline.map((m) => (
            <div
              key={m.userId}
              data-testid={`mobile-member-${m.user.username}`}
              data-presence="offline"
              className={cn('qf-m-row', 'opacity-60')}
            >
              <Avatar name={m.user.username} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="qf-m-row__primary">{m.user.username}</div>
                <div className="qf-m-row__secondary">{m.role}</div>
              </div>
              {m.role === 'OWNER' ? (
                <div className="qf-m-row__aside" aria-label="Owner">
                  <Icon name="crown" size="sm" />
                </div>
              ) : null}
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}
