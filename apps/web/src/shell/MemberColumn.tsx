import { useMembers } from '../features/workspaces/useWorkspaces';
import { usePresence } from '../features/realtime/usePresence';
import { useUI } from '../stores/ui-store';
import { Avatar } from '../design-system/primitives';
import { cn } from '../lib/cn';
import type { PresenceStatus } from '../features/presence/presenceStatus';

export function MemberColumn({ workspaceId }: { workspaceId: string }): JSX.Element | null {
  const open = useUI((s) => s.memberListOpen);
  const { data: members } = useMembers(workspaceId);
  const { onlineUserIds } = usePresence(workspaceId);

  if (!open) return null;

  const online = members?.members.filter((m) => onlineUserIds.has(m.userId)) ?? [];
  const offline = members?.members.filter((m) => !onlineUserIds.has(m.userId)) ?? [];

  return (
    <aside
      data-testid="member-column"
      aria-label="멤버 목록"
      className="qf-memberlist hidden lg:block"
    >
      {online.length > 0 ? (
        <>
          <div className="qf-memberlist__group">온라인 — {online.length}</div>
          {online.map((m) => (
            <MemberRow key={m.userId} name={m.user.username} role={m.role} status="online" />
          ))}
        </>
      ) : null}
      {offline.length > 0 ? (
        <>
          <div className="qf-memberlist__group">오프라인 — {offline.length}</div>
          {offline.map((m) => (
            <MemberRow key={m.userId} name={m.user.username} role={m.role} status="offline" />
          ))}
        </>
      ) : null}
    </aside>
  );
}

function MemberRow({
  name,
  role,
  status,
}: {
  name: string;
  role: string;
  status: PresenceStatus;
}): JSX.Element {
  const roleClass =
    role === 'OWNER'
      ? 'qf-member__role-owner'
      : role === 'ADMIN'
        ? 'qf-member__role-mod'
        : undefined;
  return (
    <div
      data-testid={`member-${name}`}
      data-presence={status}
      className={cn('qf-member', status === 'offline' && 'opacity-50')}
    >
      <Avatar name={name} size="sm" status={status} />
      <span data-testid={`member-name-${name}`} className={cn('qf-member__name', roleClass)}>
        {name}
      </span>
      {role !== 'MEMBER' ? (
        <span
          data-testid={`role-${name}`}
          className="text-[length:var(--fs-11)] font-semibold uppercase tracking-[var(--tracking-caps)] text-text-muted"
        >
          {role}
        </span>
      ) : (
        <span data-testid={`role-${name}`} className="sr-only">
          {role}
        </span>
      )}
    </div>
  );
}
