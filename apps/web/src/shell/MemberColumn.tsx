import { useMembers } from '../features/workspaces/useWorkspaces';
import { usePresence } from '../features/realtime/usePresence';
import { useUI } from '../stores/ui-store';
import { Avatar, PresenceDot, Scrollable } from '../design-system/primitives';
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
      className="hidden w-60 shrink-0 flex-col border-l border-border-subtle bg-bg-subtle lg:flex"
    >
      <header className="flex h-12 items-center border-b border-border-subtle px-4 text-xs font-semibold uppercase tracking-wider text-text-muted">
        멤버 · {members?.members.length ?? 0}
      </header>
      <Scrollable className="flex-1 p-2">
        {online.length > 0 ? (
          <>
            <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-text-muted">
              온라인 — {online.length}
            </div>
            {online.map((m) => (
              <MemberRow key={m.userId} name={m.user.username} role={m.role} online />
            ))}
          </>
        ) : null}
        {offline.length > 0 ? (
          <>
            <div className="px-2 py-1 pt-3 text-[10px] uppercase tracking-wider text-text-muted">
              오프라인 — {offline.length}
            </div>
            {offline.map((m) => (
              <MemberRow key={m.userId} name={m.user.username} role={m.role} online={false} />
            ))}
          </>
        ) : null}
      </Scrollable>
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
  return (
    <div
      data-testid={`member-${name}`}
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-bg-accent',
        !online && 'opacity-70',
      )}
    >
      <div className="relative">
        <Avatar name={name} size="sm" />
        <span className="absolute -right-0.5 -bottom-0.5">
          <PresenceDot status={online ? 'online' : 'offline'} size="xs" />
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div
          data-testid={`member-name-${name}`}
          className="truncate text-sm font-medium text-foreground"
        >
          {name}
        </div>
      </div>
      {role !== 'MEMBER' ? (
        <span
          data-testid={`role-${name}`}
          className="text-[10px] font-semibold uppercase text-text-muted"
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
