import {
  resolveMemberDisplayName,
  resolveMemberAvatarUrl,
  type MemberWithPresence,
} from '@qufox/shared-types';
// ★F11 리뷰 H-4: 그룹 응답은 첫 페이지(50명) 윈도 — 총원은 전량 워크 훅(useMembers,
// topbar 멤버수와 동일 캐시)에서 읽어 한 화면 내 카운트 모순을 없앤다.
import { useMemberGroups, useMembers } from '../../features/workspaces/useWorkspaces';
// H-6(071-M0 C9): presence:subscribe 는 행이 뷰포트에 들어올 때 발행된다(S27 모델).
// 모바일 드로어는 register 배선이 없어 구독이 0건 → 전원(본인 포함) 오프라인으로 보였다.
import { useViewportPresence } from '../../features/realtime/useViewportPresence';
// F11 회귀 수리: 서버 그룹 버킷은 fetch 시점 스냅샷 — 데스크톱 MemberColumn 정본대로
// presence:update 라이브 푸시(useUserPresence)를 우선 적용해야 idle 전이가 보인다.
import { useUserPresence } from '../../features/realtime/useUserPresence';
// F11 회귀 수리 2: per-user 푸시는 presence:subscribe **이후의 전이**만 흐른다 —
// 패널이 닫혀 있는 동안(IO 비교차 → 구독 0건) 일어난 전이는 영영 안 온다. 종전
// 모바일이 쓰던 워크스페이스 broadcast 스냅샷(presence.updated — 구독 불요, 셸
// 루트 디스패처가 캐시에 기록)을 중간 폴백으로 복원한다.
import { usePresence } from '../../features/realtime/usePresence';
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

export function MobileMembers({
  workspaceId,
  onDirectory,
}: {
  workspaceId: string;
  /** ★F11 H-4: 51번째+ 멤버 도달 경로 — nextCursor 존재 시 디렉터리 풋터를 연다. */
  onDirectory?: () => void;
}): JSX.Element {
  // F8: 서버 그룹 응답(listMembers — hoist/groups). useMembers(전량 평탄)와 달리
  // MemberColumn 과 동일 소스를 쓴다.
  const { data } = useMemberGroups(workspaceId);
  const { data: flatData } = useMembers(workspaceId);
  const { register } = useViewportPresence(workspaceId);
  // 상태 우선순위: per-user 푸시(행) > 워크스페이스 broadcast 스냅샷 > REST 그룹 버킷.
  // broadcast 는 전이마다 전체 목록을 다시 싣는다 — 캐시가 한 번이라도 쓰였다면
  // (뷰어 자신이 접속해 있으므로 합집합이 비지 않음) 부재 = 오프라인이 정확하다.
  const { onlineUserIds, dndUserIds, idleUserIds } = usePresence(workspaceId);
  const hasBroadcast = onlineUserIds.size + dndUserIds.size + idleUserIds.size > 0;
  const broadcastStatus = (userId: string): 'online' | 'idle' | 'dnd' | 'offline' | undefined => {
    if (!hasBroadcast) return undefined;
    if (dndUserIds.has(userId)) return 'dnd';
    if (idleUserIds.has(userId)) return 'idle';
    if (onlineUserIds.has(userId)) return 'online';
    return 'offline';
  };

  const hoist = data?.hoist ?? [];
  const groups = data?.groups ?? [];
  // ★F11 H-4: 페이지 윈도 합산은 50명 초과 워크스페이스에서 topbar 카운트와
  // 모순된다 — 전량 워크 결과(동일 캐시)를 우선하고 로드 전엔 윈도 합산 폴백.
  const pageSum =
    hoist.reduce((n, g) => n + g.members.length, 0) +
    groups.reduce((n, g) => n + g.members.length, 0);
  const total = flatData?.members.length ?? pageSum;

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
                status={broadcastStatus(m.userId) ?? 'online'}
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
                status={broadcastStatus(m.userId) ?? STATUS_BY_GROUP[g.key] ?? 'offline'}
                workspaceId={workspaceId}
                register={register}
              />
            ))}
          </div>
        ),
      )}
      {/* ★F11 H-4: 첫 페이지(50명) 밖 멤버 도달 경로 — 패널 내 무한스크롤 대신
          전량 페이지네이션을 이미 갖춘 멤버 디렉터리로 보낸다. */}
      {data?.nextCursor && onDirectory ? (
        <button
          type="button"
          data-testid="mobile-members-more"
          className="qf-m-row w-full text-left text-text-muted"
          onClick={onDirectory}
        >
          <Icon name="users" size="sm" className="text-text-muted" />
          <span className="qf-m-row__primary">
            전체 멤버 보기 · {Math.max(total - pageSum, 0)}명 더
          </span>
        </button>
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
  status: groupStatus,
  workspaceId,
  register,
}: {
  member: MemberWithPresence;
  /** 서버 그룹 버킷(fetch 시점) — 라이브 푸시 미도착 시 폴백. */
  status: 'online' | 'idle' | 'dnd' | 'offline';
  workspaceId: string;
  register: (userId: string) => (el: Element | null) => void;
}): JSX.Element {
  const displayName = resolveMemberDisplayName(member.user);
  const avatarUrl = resolveMemberAvatarUrl(member.user);
  // S27 (FR-P15/P16): 라이브 per-user 푸시 > REST 그룹 버킷 — 상태 플립이 리페치
  // 없이 닷을 재채색한다(MemberColumn 정본). 푸시 미도착이면 그룹 버킷 폴백.
  const live = useUserPresence(member.userId);
  const status = (live ?? groupStatus) as typeof groupStatus;
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
        {member.mutedUntil ? (
          // 071-M5 H17b (감사 B-76): 타임아웃 라벨 — 디렉터리(MemberDirectoryPanel) 정본
          // 패턴(bell-off 시각 라벨 + sr-only 텍스트). mutedUntil 은 서버가 만료분
          // (mutedUntil<=now)을 null 로 마스킹해 내려보내므로 비-null 이면 활성
          // (MemberWithPresence 기존재 데이터 — 클라 추가 판정 불요).
          <div
            className="qf-m-row__aside flex items-center gap-[var(--s-1)] text-text-strong"
            data-testid={`mobile-member-timeout-${member.user.username}`}
          >
            <Icon name="bell-off" size="sm" aria-hidden="true" />
            <span className="sr-only">타임아웃 중</span>
          </div>
        ) : null}
        {member.role === 'OWNER' ? (
          <div className="qf-m-row__aside" aria-label="소유자">
            <Icon name="crown" size="sm" />
          </div>
        ) : null}
      </div>
    </ProfilePopover>
  );
}
