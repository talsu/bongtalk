import {
  resolveMemberDisplayName,
  resolveMemberAvatarUrl,
  type MemberWithPresence,
} from '@qufox/shared-types';
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
      {/* a11y L-2: 그룹 헤더를 heading 으로 노출(SR 네비게이션 · MobileMembers HIGH-5 와 동일). */}
      <div className="qf-memberlist__group" role="heading" aria-level={3}>
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
  // S74 (FR-PS-06 + S73 carryover): 표시 우선순위 — ws nickname > 전역 displayName >
  // username, 아바타 — ws avatarUrl > 전역 avatarUrl > 이니셜. testid 는 username 으로
  // 안정 유지(기존 E2E/테스트 셀렉터 무회귀)하고 표시 라벨만 우선순위 반영한다.
  const username = member.user.username;
  const displayName = resolveMemberDisplayName(member.user);
  const avatarUrl = resolveMemberAvatarUrl(member.user);
  const roleClass =
    role === 'OWNER'
      ? 'qf-member__role-owner'
      : role === 'ADMIN'
        ? 'qf-member__role-mod'
        : undefined;
  return (
    <div
      ref={register(member.userId)}
      data-testid={`member-${username}`}
      data-presence={status}
      className={cn('qf-member', status === 'offline' && 'opacity-50')}
    >
      {avatarUrl ? (
        // page-scoped 아바타 이미지(DS Avatar 프리미티브는 이니셜 전용 — 미수정).
        // 프레즌스 닷은 별도 span 으로 오버레이한다(DS qf-avatar__status 클래스 재사용).
        <span className="qf-avatar qf-avatar--sm relative inline-flex items-center justify-center overflow-hidden">
          <img
            src={avatarUrl}
            alt={`${displayName}의 프로필 사진`}
            data-testid={`member-avatar-${username}`}
            className="h-full w-full object-cover"
          />
          {status !== 'offline' ? (
            <span className={`qf-avatar__status qf-avatar__status--${status}`} aria-hidden />
          ) : null}
        </span>
      ) : (
        <Avatar name={displayName} size="sm" status={status} />
      )}
      <span data-testid={`member-name-${username}`} className={cn('qf-member__name', roleClass)}>
        {displayName}
      </span>
      {role !== 'MEMBER' ? (
        <span
          data-testid={`role-${username}`}
          className="text-[length:var(--fs-11)] font-semibold uppercase tracking-[var(--tracking-caps)] text-text-muted"
        >
          {role}
        </span>
      ) : (
        <span data-testid={`role-${username}`} className="sr-only">
          {role}
        </span>
      )}
    </div>
  );
}
