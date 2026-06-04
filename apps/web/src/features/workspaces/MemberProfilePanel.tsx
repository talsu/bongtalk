import type { MemberDirectoryRow } from '@qufox/shared-types';
import { Avatar, Icon } from '../../design-system/primitives';
import { ROLE_LABEL, STATUS_LABEL } from './memberLabels';

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
    // S69 fix-forward (a11y H-05/N-02): Dialog 가 이미 landmark/제목을 제공하므로 내부에
    // <section aria-label> / <header> 를 또 두면 landmark 가 과잉이 된다 — 둘 다 <div> 로 낮춘다.
    <div
      data-testid="member-profile-panel"
      className="flex flex-col gap-[var(--s-4)] rounded-md bg-bg-surface p-[var(--s-4)]"
    >
      <div className="flex items-center justify-between gap-[var(--s-2)]">
        <div className="flex min-w-0 items-center gap-[var(--s-3)]">
          <Avatar name={member.user.username} size="md" status={member.status} />
          <div className="min-w-0">
            {/* S69 fix-forward (a11y M-04): Dialog title(h2) 하위 제목 계층으로 h3. */}
            <h3 className="truncate text-text-strong">{member.user.username}</h3>
            {/* S69 fix-forward (security): email 은 ADMIN+ 뷰어에게만 내려온다(비관리자 null). */}
            {member.user.email ? (
              <p className="truncate text-[length:var(--fs-12)] text-text-muted">
                {member.user.email}
              </p>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          aria-label="프로필 닫기"
          onClick={onClose}
          // S69 fix-forward (ui MEDIUM/a11y B-03): qf-icon-btn → 표준 버튼 토큰 조합.
          className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm shrink-0"
        >
          <Icon name="x" size="sm" />
        </button>
      </div>

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
    </div>
  );
}
