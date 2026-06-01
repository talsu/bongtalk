import type { MemberWithPresence } from '@qufox/shared-types';
import { useMemberGroups } from '../features/workspaces/useWorkspaces';
import { useViewportPresence } from '../features/realtime/useViewportPresence';
import { useUserPresence } from '../features/realtime/useUserPresence';
import { useUI } from '../stores/ui-store';
import { Avatar } from '../design-system/primitives';
import { cn } from '../lib/cn';
import type { PresenceStatus } from '../features/presence/presenceStatus';

export function MemberColumn({ workspaceId }: { workspaceId: string }): JSX.Element | null {
  const open = useUI((s) => s.memberListOpen);
  // S27 (FR-P15): channel switch resets the viewport observer (disconnect +
  // presence:unsubscribe of the old scope's watched users).
  const activeChannelId = useUI((s) => s.activeChannelId);
  const { data } = useMemberGroups(workspaceId);
  // S27 (FR-P15): scope the viewport subscription to the active channel so a
  // channel switch tears down + re-arms the IntersectionObserver.
  const { register } = useViewportPresence(activeChannelId ?? workspaceId);

  if (!open) return null;

  return (
    <aside
      data-testid="member-column"
      aria-label="멤버 목록"
      className="qf-memberlist hidden lg:block"
    >
      {/* FR-P09: hoisted OWNER/ADMIN staff group on top. */}
      {data?.hoist.map((group) => (
        <MemberGroup
          key={`hoist-${group.key}`}
          label={group.label}
          members={group.members}
          register={register}
        />
      ))}
      {/* FR-P08: status-bucketed groups (online/idle/dnd/offline). */}
      {data?.groups.map((group) => (
        <MemberGroup
          key={`status-${group.key}`}
          label={group.label}
          members={group.members}
          register={register}
        />
      ))}
    </aside>
  );
}

function MemberGroup({
  label,
  members,
  register,
}: {
  label: string;
  members: MemberWithPresence[];
  register: (userId: string) => (el: Element | null) => void;
}): JSX.Element | null {
  if (members.length === 0) return null;
  return (
    <>
      <div className="qf-memberlist__group">
        {label} — {members.length}
      </div>
      {members.map((m) => (
        <MemberRow key={m.userId} member={m} register={register} />
      ))}
    </>
  );
}

function MemberRow({
  member,
  register,
}: {
  member: MemberWithPresence;
  register: (userId: string) => (el: Element | null) => void;
}): JSX.Element {
  // S27 (FR-P15/P16): prefer the live per-user push (presence:update →
  // qk.presence.user) over the REST group bucket so a status flip recolours the
  // dot without a member-list refetch. Falls back to the REST bucket.
  const live = useUserPresence(member.userId);
  const status: PresenceStatus = (live ?? member.status) as PresenceStatus;
  const role = member.role;
  const name = member.user.username;
  const roleClass =
    role === 'OWNER'
      ? 'qf-member__role-owner'
      : role === 'ADMIN'
        ? 'qf-member__role-mod'
        : undefined;
  return (
    <div
      ref={register(member.userId)}
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
