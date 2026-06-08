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
// S75 (FR-PS-07): 멤버 행을 프로필 팝오버 트리거로 감싼다.
import { ProfilePopover } from '../features/profile/ProfilePopover';

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
      {/* FR-P09 (task-068 · S95): 역할기반 per-role hoist 그룹(hoistInMemberList=true)을
          상단에 표시한다(position DESC). 헤더 라벨=역할명, 역할 colorHex 는 라벨 옆 색 점으로
          표시한다(텍스트 color 아님 — a11y BLOCKER fix-forward · WCAG 1.4.3). */}
      {data?.hoist.map((group) => (
        <MemberGroup
          key={`hoist-${group.key}`}
          label={group.label}
          color={group.color ?? null}
          members={group.members}
          register={register}
          workspaceId={workspaceId}
        />
      ))}
      {/* FR-P08: status-bucketed groups (online/idle/dnd/offline). */}
      {data?.groups.map((group) => (
        <MemberGroup
          key={`status-${group.key}`}
          label={group.label}
          members={group.members}
          register={register}
          workspaceId={workspaceId}
        />
      ))}
    </aside>
  );
}

function MemberGroup({
  label,
  members,
  register,
  workspaceId,
  color = null,
}: {
  label: string;
  members: MemberWithPresence[];
  register: (userId: string) => (el: Element | null) => void;
  workspaceId: string;
  /** FR-P09 (task-068 · S95): hoist 그룹 역할 색(colorHex). 라벨 옆 색 점으로만 표시하고
   * 헤더 텍스트 color 로는 쓰지 않는다(a11y · WCAG 1.4.3). null=점 미표시(status 그룹). */
  color?: string | null;
}): JSX.Element | null {
  if (members.length === 0) return null;
  return (
    <>
      {/* a11y L-2: 그룹 헤더를 heading 으로 노출(SR 네비게이션 · MobileMembers HIGH-5 와 동일). */}
      {/* FR-P09 fix-forward (a11y BLOCKER · WCAG 1.4.3): 역할 색을 헤더 텍스트 color 로
          적용하지 않는다 — 사용자 지정 역할색(예 #5865F2)은 12px/600 일반 텍스트의 4.5:1
          대비를 만족하지 못해 신규 위반이 된다. 대신 라벨 왼쪽에 작은 색 점만 두고(점은
          텍스트 대비 규칙 비대상 · aria-hidden), 헤더 텍스트는 DS 기본색(qf-memberlist__group
          의 --text-muted)을 유지한다. 색이 없으면 점을 표시하지 않는다. 점 색만 동적
          사용자 hex 라 인라인 backgroundColor 를 쓰고(DS 토큰으로 표현 불가), 점 크기/간격은
          DS 토큰(--s-*)을 사용한다. 역할명 텍스트가 항상 동반되므로 색 단독 비의존(1.4.1)도
          충족한다. status 그룹(color=null)은 점 없이 종전과 동일하다. */}
      <div className="qf-memberlist__group" role="heading" aria-level={3}>
        {color ? (
          <span
            aria-hidden="true"
            data-testid="hoist-group-dot"
            className="mr-[var(--s-1)] inline-block h-[var(--s-2)] w-[var(--s-2)] shrink-0 rounded-full align-middle"
            style={{ backgroundColor: color }}
          />
        ) : null}
        {label} — {members.length}
      </div>
      {members.map((m) => (
        <MemberRow key={m.userId} member={m} register={register} workspaceId={workspaceId} />
      ))}
    </>
  );
}

function MemberRow({
  member,
  register,
  workspaceId,
}: {
  member: MemberWithPresence;
  register: (userId: string) => (el: Element | null) => void;
  workspaceId: string;
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
    // S75 (FR-PS-07): 멤버 행 전체를 프로필 팝오버 트리거로 감싼다(클릭/Enter/Space → 200px
    // 미니카드). register(IntersectionObserver) 는 외부 div 에 유지하고, 팝오버 트리거는 행
    // 컨텐츠를 감싼다(트리거가 role=button aria-haspopup=dialog 를 부여).
    <div ref={register(member.userId)} data-presence={status}>
      {/* F3 (a11y B-3): 멤버 행은 블록 `.qf-member` div 라 트리거 host 도 div 로
          렌더해 block-in-inline 을 피한다. */}
      <ProfilePopover userId={member.userId} workspaceId={workspaceId} as="div">
        <div
          data-testid={`member-${username}`}
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
          <span
            data-testid={`member-name-${username}`}
            className={cn('qf-member__name', roleClass)}
          >
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
      </ProfilePopover>
    </div>
  );
}
