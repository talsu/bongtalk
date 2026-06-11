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
        // S63 fix-forward (ui M-01): raw scale max-h-96 대신 뷰포트 기준 max-h-[85vh] 로
        // 둬 작은 화면에서도 모달이 넘치지 않게 한다.
        className="max-h-[85vh] overflow-y-auto text-[length:var(--fs-13)]"
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
                  // S63 fix-forward (a11y MAJOR-4 = ui H-01): 존재하지 않는 키였던
                  // bg-bg-muted → bg-muted(--bg-hover), rounded-[var(--radius-sm)](--radius-sm
                  // 미정의) → rounded-sm(--r-sm 매핑). 뱃지 배경/모서리가 복원된다.
                  className="shrink-0 rounded-sm bg-muted px-[var(--s-1)] text-[length:var(--fs-11)] text-text-muted"
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
                  // S63 fix-forward (ui M-02): qf-input + qf-btn--sm 혼합과 raw !h-6/!px-2
                  // override 를 제거한다. qf-input 단독 + 콤팩트 크기는 토큰 매핑 유틸
                  // (h-7=--s-7, px-2=--s-2, w-auto)로만 조정한다(DS 컴포넌트 혼합/important 제거).
                  className="qf-input h-7 w-auto px-2 text-[length:var(--fs-11)]"
                >
                  {/* 071-M5 H9 (감사 H-11): enum 원문 노출 → 한글 라벨(value 는 enum 유지 —
                      e2e selectOption('ADMIN') 등 value 셀렉터 무영향). */}
                  <option value="MEMBER">멤버</option>
                  <option value="ADMIN">관리자</option>
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
