import { Dialog } from '../../design-system/primitives';
import { useNotifications } from '../../stores/notification-store';
import { useMembers, useUpdateRole } from './useWorkspaces';
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
            className="flex items-center justify-between py-[var(--s-2)] text-text-secondary"
          >
            <span
              className={cn('truncate', m.role === 'OWNER' && 'font-semibold text-text-strong')}
            >
              {m.user.username}
            </span>
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
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
