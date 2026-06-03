import { Button } from '../../design-system/primitives';
import { useNotifications } from '../../stores/notification-store';
import { useBans, useUnbanMember } from './useWorkspaces';

type Props = {
  workspaceId: string;
  /** 권한자에게만 차단 목록을 조회/표시한다(서버가 최종 권위). */
  enabled: boolean;
};

/**
 * S63 (D12 / FR-RM06): 워크스페이스 차단 목록 패널. 권한자(canManage)에게만
 * 노출하며, 각 항목의 차단 해제 버튼은 unbanMember 를 호출한다.
 */
export function BanListPanel({ workspaceId, enabled }: Props): JSX.Element | null {
  const { data, isLoading } = useBans(workspaceId, enabled);
  const unbanMut = useUnbanMember(workspaceId);
  const notify = useNotifications((s) => s.push);

  if (!enabled) return null;

  const bans = data?.bans ?? [];

  return (
    <section data-testid="ban-list-panel" className="mt-[var(--s-4)]">
      <h3 className="mb-[var(--s-2)] text-[length:var(--fs-11)] font-semibold uppercase text-text-muted">
        차단 목록
      </h3>
      {isLoading ? (
        <p className="text-[length:var(--fs-13)] text-text-muted">불러오는 중…</p>
      ) : bans.length === 0 ? (
        <p data-testid="ban-list-empty" className="text-[length:var(--fs-13)] text-text-muted">
          차단된 사용자가 없습니다.
        </p>
      ) : (
        <ul aria-label="차단된 사용자" className="text-[length:var(--fs-13)]">
          {bans.map((b) => {
            const name = b.user?.username ?? b.userId;
            return (
              <li
                key={b.userId}
                data-testid={`ban-row-${b.userId}`}
                className="flex items-center justify-between gap-[var(--s-2)] py-[var(--s-2)] text-text-secondary"
              >
                <span className="min-w-0 truncate">
                  <span className="text-text-strong">{name}</span>
                  {b.reason ? (
                    <span className="ml-[var(--s-2)] text-text-muted">— {b.reason}</span>
                  ) : null}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  data-testid={`ban-unban-${b.userId}`}
                  disabled={unbanMut.isPending}
                  onClick={async () => {
                    try {
                      await unbanMut.mutateAsync(b.userId);
                      notify({ variant: 'success', title: `${name} 님의 차단을 해제했습니다` });
                    } catch (err) {
                      notify({
                        variant: 'danger',
                        title: '차단 해제 실패',
                        body: (err as Error).message,
                      });
                    }
                  }}
                >
                  차단 해제
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
