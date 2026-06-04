import {
  resolveMemberDisplayName,
  resolveMemberAvatarUrl,
  type MemberWithPresence,
} from '@qufox/shared-types';
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
          {/* a11y HIGH-5: 그룹 헤더를 heading 으로 노출(SR 네비게이션). */}
          <div className="qf-m-section" role="heading" aria-level={3}>
            <div>온라인 — {online.length}</div>
          </div>
          {online.map((m) => (
            <MobileMemberRow key={m.userId} member={m} status={status(m.userId)} />
          ))}
        </>
      ) : null}
      {offline.length > 0 ? (
        <>
          <div className="qf-m-section" role="heading" aria-level={3}>
            <div>오프라인 — {offline.length}</div>
          </div>
          {offline.map((m) => (
            <MobileMemberRow key={m.userId} member={m} status="offline" />
          ))}
        </>
      ) : null}
    </div>
  );
}

/**
 * S74 (ui-designer LOW-4 + reviewer LOW-1 parity): 모바일 멤버 행. 데스크톱 MemberColumn 과
 * 동일하게 resolveMemberAvatarUrl(ws/전역 아바타)로 이미지 아바타를 렌더하고, 없으면 이니셜
 * Avatar 로 폴백한다. a11y M-4: 오프라인은 status="offline" 을 명시한다.
 */
function MobileMemberRow({
  member,
  status,
}: {
  member: MemberWithPresence;
  status: 'online' | 'dnd' | 'offline';
}): JSX.Element {
  const displayName = resolveMemberDisplayName(member.user);
  const avatarUrl = resolveMemberAvatarUrl(member.user);
  return (
    <div
      data-testid={`mobile-member-${member.user.username}`}
      data-presence={status}
      className={cn('qf-m-row', status === 'offline' && 'opacity-60')}
    >
      {avatarUrl ? (
        // page-scoped 이미지 아바타(DS Avatar 프리미티브는 이니셜 전용 — 미수정). 프레즌스
        // 닷은 별도 span 으로 오버레이한다(MemberColumn 선례 동일).
        <span className="qf-avatar qf-avatar--sm relative inline-flex items-center justify-center overflow-hidden">
          <img
            src={avatarUrl}
            alt={`${displayName}의 프로필 사진`}
            data-testid={`mobile-member-avatar-${member.user.username}`}
            className="h-full w-full object-cover"
          />
          {status !== 'offline' ? (
            <span className={`qf-avatar__status qf-avatar__status--${status}`} aria-hidden />
          ) : null}
        </span>
      ) : (
        // a11y M-4: 오프라인도 status 를 명시해 의미를 분명히 한다(닷은 미렌더).
        <Avatar name={displayName} size="sm" status={status} />
      )}
      <div className="min-w-0 flex-1">
        {/* S74 (FR-PS-06): ws nickname > displayName > username 우선순위 표시. */}
        <div className="qf-m-row__primary">{displayName}</div>
        <div className="qf-m-row__secondary">{member.role}</div>
      </div>
      {member.role === 'OWNER' ? (
        <div className="qf-m-row__aside" aria-label="Owner">
          <Icon name="crown" size="sm" />
        </div>
      ) : null}
    </div>
  );
}
