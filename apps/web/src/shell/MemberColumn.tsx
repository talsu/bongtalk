import { useMembers } from '../features/workspaces/useWorkspaces';
import { usePresence } from '../features/realtime/usePresence';
import { useUI } from '../stores/ui-store';
import { Avatar, PresenceDot } from '../design-system/primitives';
import { cn } from '../lib/cn';

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
            <MemberRow key={m.userId} name={m.user.username} role={m.role} online />
          ))}
        </>
      ) : null}
      {offline.length > 0 ? (
        <>
          <div className="qf-memberlist__group">오프라인 — {offline.length}</div>
          {offline.map((m) => (
            <MemberRow key={m.userId} name={m.user.username} role={m.role} online={false} />
          ))}
        </>
      ) : null}
    </aside>
  );
}

function MemberRow({
  name,
  role,
  online,
}: {
  name: string;
  role: string;
  online: boolean;
}): JSX.Element {
  const roleClass =
    role === 'OWNER'
      ? 'qf-member__role-owner'
      : role === 'ADMIN'
        ? 'qf-member__role-mod'
        : undefined;
  return (
    <div data-testid={`member-${name}`} className={cn('qf-member', !online && 'opacity-70')}>
      <div className="relative">
        <Avatar name={name} size="sm" />
        <span className="absolute -right-0.5 -bottom-0.5">
          <PresenceDot status={online ? 'online' : 'offline'} size="xs" />
        </span>
      </div>
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
      <span
        data-testid={`presence-${name}`}
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          online ? 'bg-presence-online' : 'bg-presence-offline',
        )}
        aria-hidden
      />
    </div>
  );
}
