import { Dialog } from '../../design-system/primitives';
import { useNotifications } from '../../stores/notification-store';
import { useMembers, useUpdateRole } from './useWorkspaces';
import { ModerationActions } from './ModerationActions';
import { BanListPanel } from './BanListPanel';
import { cn } from '../../lib/cn';

type Props = {
  workspaceId: string;
  canManage: boolean;
  open: boolean;
  onClose: () => void;
};

export function WorkspaceMembersModal({
  workspaceId,
  canManage,
  open,
  onClose,
}: Props): JSX.Element | null {
  const { data: members } = useMembers(workspaceId);
  const roleMut = useUpdateRole(workspaceId);
  const notify = useNotifications((s) => s.push);

  if (!open) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title="멤버 관리"
      description="워크스페이스에 속한 멤버와 역할을 확인합니다."
    >
      <ul
        data-testid="ws-members-modal-list"
        aria-label="워크스페이스 멤버"
        className="max-h-96 overflow-y-auto text-[length:var(--fs-13)]"
      >
        {(members?.members ?? []).map((m) => (
          <li
            key={m.userId}
            data-testid={`ws-member-${m.user.username}`}
            className="flex items-center justify-between gap-[var(--s-2)] py-[var(--s-2)] text-text-secondary"
          >
            <span
              className={cn(
                'flex min-w-0 items-center gap-[var(--s-2)] truncate',
                m.role === 'OWNER' && 'font-semibold text-text-strong',
              )}
            >
              <span className="truncate">{m.user.username}</span>
              {/* S63 (FR-RM07): 활성 음소거 배지(서버가 만료분은 null 로 마스킹). */}
              {m.mutedUntil ? (
                <span
                  data-testid={`ws-member-muted-${m.user.username}`}
                  title="음소거 중"
                  className="shrink-0 rounded-[var(--radius-sm)] bg-bg-muted px-[var(--s-1)] text-[length:var(--fs-11)] text-text-muted"
                >
                  음소거
                </span>
              ) : null}
            </span>
            <span className="flex shrink-0 items-center gap-[var(--s-2)]">
              {canManage && m.role !== 'OWNER' ? (
                <select
                  data-testid={`ws-role-select-${m.user.username}`}
                  aria-label={`${m.user.username} 의 역할 변경`}
                  value={m.role}
                  onChange={async (e) => {
                    try {
                      await roleMut.mutateAsync({
                        userId: m.userId,
                        role: e.target.value as 'ADMIN' | 'MEMBER',
                      });
                    } catch (err) {
                      notify({
                        variant: 'danger',
                        title: '역할 변경 실패',
                        body: (err as Error).message,
                      });
                    }
                  }}
                  className="qf-input qf-btn--sm !h-6 !w-auto !px-2 text-[length:var(--fs-11)]"
                >
                  <option value="MEMBER">MEMBER</option>
                  <option value="ADMIN">ADMIN</option>
                </select>
              ) : (
                <span data-testid={`ws-role-${m.user.username}`} className="text-text-muted">
                  {m.role}
                </span>
              )}
              {/* S63 (FR-RM05·06·07): 모더레이션 액션(권한자, OWNER 제외). */}
              {canManage && m.role !== 'OWNER' ? (
                <ModerationActions
                  workspaceId={workspaceId}
                  targetUserId={m.userId}
                  targetUsername={m.user.username}
                />
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {/* S63 (FR-RM06): 차단 목록 패널(권한자). */}
      <BanListPanel workspaceId={workspaceId} enabled={canManage} />
    </Dialog>
  );
}
