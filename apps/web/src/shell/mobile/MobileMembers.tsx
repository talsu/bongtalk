import {
  resolveMemberDisplayName,
  resolveMemberAvatarUrl,
  type MemberWithPresence,
} from '@qufox/shared-types';
import { useMemberGroups } from '../../features/workspaces/useWorkspaces';
// H-6(071-M0 C9): presence:subscribe 는 행이 뷰포트에 들어올 때 발행된다(S27 모델).
// 모바일 드로어는 register 배선이 없어 구독이 0건 → 전원(본인 포함) 오프라인으로 보였다.
import { useViewportPresence } from '../../features/realtime/useViewportPresence';
import { Avatar, Icon } from '../../design-system/primitives';
import { cn } from '../../lib/cn';
// S75 (FR-PS-07): 모바일 멤버 행 탭 → 프로필 팝오버(터치 단일 진입점).
import { ProfilePopover } from '../../features/profile/ProfilePopover';

/**
 * 071-M3 F8 (FR-P08/P09 모바일 / 감사 B-4·B-55·B-119·B-122) — 우패널 멤버 목록.
 *
 * 종전엔 클라이언트 2버킷(online/offline — idle/dnd 가 오프라인으로 강등)이었다.
 * 데스크톱 MemberColumn 정본대로 **서버가 만든 그룹을 그대로 렌더**한다:
 * hoist(per-role, position DESC, 역할 색점) → status 4버킷(온라인/자리비움/
 * 방해금지/오프라인). 역할 표기는 한글화(감사 B-109).
 */
const ROLE_LABEL: Record<string, string> = {
  OWNER: '소유자',
  ADMIN: '관리자',
  MODERATOR: '운영진',
  MEMBER: '멤버',
  GUEST: '게스트',
};

const STATUS_BY_GROUP: Record<string, 'online' | 'idle' | 'dnd' | 'offline'> = {
  online: 'online',
  idle: 'idle',
  dnd: 'dnd',
  offline: 'offline',
};

export function MobileMembers({ workspaceId }: { workspaceId: string }): JSX.Element {
  // F8: 서버 그룹 응답(listMembers — hoist/groups). useMembers(전량 평탄)와 달리
  // MemberColumn 과 동일 소스를 쓴다.
  const { data } = useMemberGroups(workspaceId);
  const { register } = useViewportPresence(workspaceId);

  const hoist = data?.hoist ?? [];
  const groups = data?.groups ?? [];
  const total =
    hoist.reduce((n, g) => n + g.members.length, 0) +
    groups.reduce((n, g) => n + g.members.length, 0);

  return (
    <div>
      <div className="qf-m-section">
        <div>멤버 · {total}</div>
      </div>
      {/* FR-P09: per-role hoist 그룹(온라인 멤버만 — 서버 정본). */}
      {hoist.map((g) =>
        g.members.length === 0 ? null : (
          <div key={`hoist-${g.key}`}>
            <div
              className="qf-m-section flex items-center gap-[var(--s-2)]"
              role="heading"
              aria-level={3}
            >
              {g.color ? (
                <span
                  data-testid="mobile-hoist-dot"
                  aria-hidden
                  className="inline-block h-[var(--sz-status-dot)] w-[var(--sz-status-dot)] rounded-[var(--r-pill)]"
                  style={{ backgroundColor: g.color }}
                />
              ) : null}
              <div>
                {ROLE_LABEL[g.label] ?? g.label} — {g.members.length}
              </div>
            </div>
            {g.members.map((m) => (
              <MobileMemberRow
                key={m.userId}
                member={m}
                status="online"
                workspaceId={workspaceId}
                register={register}
              />
            ))}
          </div>
        ),
      )}
      {/* FR-P08: status 4버킷(온라인/자리비움/방해금지/오프라인) — 서버 정본. */}
      {groups.map((g) =>
        g.members.length === 0 ? null : (
          <div key={`status-${g.key}`}>
            <div className="qf-m-section" role="heading" aria-level={3}>
              <div>
                {g.label} — {g.members.length}
              </div>
            </div>
            {g.members.map((m) => (
              <MobileMemberRow
                key={m.userId}
                member={m}
                status={STATUS_BY_GROUP[g.key] ?? 'offline'}
                workspaceId={workspaceId}
                register={register}
              />
            ))}
          </div>
        ),
      )}
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
  workspaceId,
  register,
}: {
  member: MemberWithPresence;
  status: 'online' | 'idle' | 'dnd' | 'offline';
  workspaceId: string;
  register: (userId: string) => (el: Element | null) => void;
}): JSX.Element {
  const displayName = resolveMemberDisplayName(member.user);
  const avatarUrl = resolveMemberAvatarUrl(member.user);
  return (
    // S75 (FR-PS-07): 모바일 멤버 행 탭 → 프로필 팝오버(터치 단일 진입점).
    // F3 (a11y B-3): 모바일 멤버 행은 블록 `.qf-m-row` div 라 트리거 host 도 div.
    <ProfilePopover userId={member.userId} workspaceId={workspaceId} as="div">
      <div
        ref={register(member.userId)}
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
          {/* F8 (감사 B-109): 역할 한글화. */}
          <div className="qf-m-row__secondary">{ROLE_LABEL[member.role] ?? member.role}</div>
        </div>
        {member.role === 'OWNER' ? (
          <div className="qf-m-row__aside" aria-label="소유자">
            <Icon name="crown" size="sm" />
          </div>
        ) : null}
      </div>
    </ProfilePopover>
  );
}
