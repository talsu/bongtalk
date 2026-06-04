import { Link } from 'react-router-dom';
import { Avatar } from '../../design-system/primitives';
import { useNotifications } from '../../stores/notification-store';
import { useFriendsList, useUnblockUser } from '../friends/useFriends';

/**
 * S75 (D14 / FR-PS-14): 개인정보/안전 설정 — 차단 목록 + 해제.
 *
 * 차단 목록은 기존 FriendsController(GET /me/friends?status=blocked)를 100% 재사용한다
 * (신규 차단 API 없음). 해제는 DELETE /me/friends/block/:userId(useUnblockUser). 해제 시
 * useUnblockUser 가 friends 캐시를 invalidate 하고, 서버는 user:unblocked WS 이벤트를 보내
 * 클라가 차단 마스킹을 푼다(useUserUnblocked — 채널/DM 메시지 캐시 무효화).
 *
 * NotificationSettingsPage 와 동일한 설정 페이지 셸(qf-* + DS 토큰)을 쓴다.
 */
export function PrivacySafetySettingsPage(): JSX.Element {
  const { data, isLoading } = useFriendsList('blocked');
  const unblock = useUnblockUser();
  const notify = useNotifications((s) => s.push);
  const blocked = data?.items ?? [];

  const onUnblock = (userId: string, username: string): void => {
    unblock.mutate(
      { userId },
      {
        onSuccess: () =>
          notify({ variant: 'success', title: '차단 해제됨', body: `@${username}`, ttlMs: 2500 }),
        onError: () =>
          notify({
            variant: 'danger',
            title: '차단 해제 실패',
            body: '잠시 후 다시 시도하세요.',
            ttlMs: 4000,
          }),
      },
    );
  };

  return (
    <main
      className="min-h-full bg-background p-[var(--s-7)]"
      aria-label="개인정보 및 안전 설정"
      data-testid="privacy-safety-settings"
    >
      <div className="mx-auto max-w-[var(--w-settings)]">
        <div className="mb-[var(--s-5)] flex items-center justify-between">
          <div>
            <div className="qf-eyebrow">settings</div>
            <h1 className="text-[length:var(--fs-24)] font-semibold tracking-[var(--tracking-tight)] text-text-strong">
              개인정보 및 안전
            </h1>
          </div>
          <Link to="/" className="qf-btn qf-btn--ghost">
            닫기
          </Link>
        </div>

        <section
          className="mb-[var(--s-6)] rounded-[var(--r-xl)] border border-border bg-bg-surface p-[var(--s-5)]"
          aria-labelledby="blocked-users-heading"
        >
          <h2
            id="blocked-users-heading"
            className="mb-[var(--s-1)] text-[length:var(--fs-16)] font-semibold text-text-strong"
          >
            차단한 사용자
          </h2>
          <p className="mb-[var(--s-4)] text-[length:var(--fs-12)] text-text-muted">
            차단한 사용자의 메시지는 가려지고, DM/멘션을 받을 수 없습니다. 해제하면 다시 표시됩니다.
          </p>

          {isLoading ? (
            <div role="status" aria-busy="true" className="flex flex-col gap-[var(--s-2)]">
              <span className="sr-only">차단 목록 불러오는 중</span>
              <div className="qf-skel h-[var(--s-9)] w-full" aria-hidden="true" />
              <div className="qf-skel h-[var(--s-9)] w-full" aria-hidden="true" />
            </div>
          ) : blocked.length === 0 ? (
            <p
              role="status"
              data-testid="blocked-empty"
              className="py-[var(--s-4)] text-[length:var(--fs-13)] text-text-secondary"
            >
              차단한 사용자가 없습니다.
            </p>
          ) : (
            <ul className="flex flex-col gap-[var(--s-2)]">
              {blocked.map((row) => (
                <li
                  key={row.friendshipId}
                  data-testid={`blocked-row-${row.otherUserId}`}
                  className="flex items-center gap-[var(--s-3)] rounded-md border border-border-subtle p-[var(--s-3)]"
                >
                  <Avatar name={row.otherUsername} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-[length:var(--fs-14)] text-foreground">
                    @{row.otherUsername}
                  </span>
                  <button
                    type="button"
                    data-testid={`blocked-unblock-${row.otherUserId}`}
                    onClick={() => onUnblock(row.otherUserId, row.otherUsername)}
                    disabled={unblock.isPending}
                    className="qf-btn qf-btn--secondary qf-btn--sm"
                  >
                    차단 해제
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
