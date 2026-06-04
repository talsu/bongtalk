import type { MemberDirectoryRow } from '@qufox/shared-types';
import { Avatar, Icon } from '../../design-system/primitives';

const STATUS_LABEL: Record<string, string> = {
  online: '온라인',
  idle: '자리 비움',
  dnd: '다른 용무 중',
  offline: '오프라인',
};

const ROLE_LABEL: Record<string, string> = {
  OWNER: '소유자',
  ADMIN: '관리자',
  MODERATOR: '모더레이터',
  MEMBER: '멤버',
  GUEST: '게스트',
};

/**
 * S69 (D13 / FR-W10): 멤버 프로필 패널. 디렉터리에서 멤버를 클릭하면 역할·상태·가입일·
 * **초대자(invitedBy)** 를 보여준다. 읽기 전용 — 관리 액션은 디렉터리 행/일괄 액션에서
 * 처리한다(권한 시).
 */
export function MemberProfilePanel({
  member,
  onClose,
}: {
  member: MemberDirectoryRow;
  onClose: () => void;
}): JSX.Element {
  const joinedAt = new Date(member.joinedAt);
  const joinedLabel = Number.isNaN(joinedAt.getTime())
    ? '-'
    : `${joinedAt.getUTCFullYear()}년 ${joinedAt.getUTCMonth() + 1}월 ${joinedAt.getUTCDate()}일`;

  return (
    <section
      data-testid="member-profile-panel"
      aria-label={`${member.user.username} 프로필`}
      className="flex flex-col gap-[var(--s-4)] rounded-md bg-bg-surface p-[var(--s-4)]"
    >
      <header className="flex items-center justify-between gap-[var(--s-2)]">
        <div className="flex min-w-0 items-center gap-[var(--s-3)]">
          <Avatar name={member.user.username} size="md" status={member.status} />
          <div className="min-w-0">
            <p className="truncate text-text-strong">{member.user.username}</p>
            <p className="truncate text-[length:var(--fs-12)] text-text-muted">
              {member.user.email}
            </p>
          </div>
        </div>
        <button
          type="button"
          aria-label="프로필 닫기"
          onClick={onClose}
          className="qf-icon-btn shrink-0"
        >
          <Icon name="x" size="sm" />
        </button>
      </header>

      <dl className="grid grid-cols-[auto_1fr] gap-x-[var(--s-4)] gap-y-[var(--s-2)] text-[length:var(--fs-13)]">
        <dt className="text-text-muted">역할</dt>
        <dd className="text-text-strong">{ROLE_LABEL[member.role] ?? member.role}</dd>

        <dt className="text-text-muted">상태</dt>
        <dd className="text-foreground">{STATUS_LABEL[member.status] ?? member.status}</dd>

        <dt className="text-text-muted">가입일</dt>
        <dd className="text-foreground">{joinedLabel}</dd>

        <dt className="text-text-muted">초대자</dt>
        <dd className="text-foreground" data-testid="member-profile-inviter">
          {member.invitedBy ? member.invitedBy.username : '공개 가입'}
        </dd>

        {member.mutedUntil ? (
          <>
            <dt className="text-text-muted">음소거</dt>
            <dd className="flex items-center gap-[var(--s-1)] text-text-strong">
              {/* danger/warn 텍스트는 라이트 대비 미달 — text-text-strong + 아이콘으로 표기. */}
              <Icon name="bell-off" size="sm" />
              음소거 중
            </dd>
          </>
        ) : null}
      </dl>
    </section>
  );
}
