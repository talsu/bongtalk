import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar } from '../../design-system/primitives';
import { Dialog } from '../../design-system/primitives/Dialog';
import { useNotifications } from '../../stores/notification-store';
import { useFriendsList, useUnblockUser } from '../friends/useFriends';

/**
 * S75 (D14 / FR-PS-14): 개인정보/안전 설정 — 차단 목록 + 해제.
 *
 * 차단 목록은 기존 FriendsController(GET /me/friends?status=blocked)를 100% 재사용한다
 * (신규 차단 API 없음). 해제는 DELETE /me/friends/block/:userId(useUnblockUser).
 *
 * S75 fix-forward (F13): 해제 성공 시 useUnblockUser 가 `['friends']` + `['messages']`
 * 캐시를 함께 무효화한다 — 이 탭에서 열린 채널/DM 메시지의 `[차단된 사용자의
 * 메시지]` 마스킹이 풀린 원문으로 즉시 재로드된다. 다른 탭/기기로의 실시간 전파
 * (`user:unblocked` WS → useUserUnblocked)는 현재 어떤 Shell 에도 배선돼 있지 않다
 * (dormant — useUserUnblocked.ts 의 carryover 참고). 따라서 본 페이지는 mutation
 * onSuccess 의 직접 무효화에만 의존한다.
 *
 * NotificationSettingsPage 와 동일한 설정 페이지 셸(qf-* + DS 토큰)을 쓴다.
 */
export function PrivacySafetySettingsPage(): JSX.Element {
  const { data, isLoading } = useFriendsList('blocked');
  const unblock = useUnblockUser();
  const notify = useNotifications((s) => s.push);
  const blocked = data?.items ?? [];

  // F11 (a11y M-5): 차단 해제 즉시실행은 오클릭 위험 → 확인 단계(alertDialog)를 둔다.
  const [confirmTarget, setConfirmTarget] = useState<{
    userId: string;
    username: string;
  } | null>(null);

  const runUnblock = (userId: string, username: string): void => {
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
                    // F6 (a11y H-1): 모든 해제 버튼이 같은 텍스트 "차단 해제"라
                    // 접근명이 중복된다 — 대상 @username 을 aria-label 에 포함한다.
                    aria-label={`@${row.otherUsername} 차단 해제`}
                    onClick={() =>
                      setConfirmTarget({ userId: row.otherUserId, username: row.otherUsername })
                    }
                    // F10 (a11y M-3): 해제 진행 중 표시. 해당 대상이 처리 중일 때만 busy.
                    aria-busy={unblock.isPending && confirmTarget?.userId === row.otherUserId}
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

      {/* F11 (a11y M-5): 차단 해제 확인 다이얼로그(alertDialog — 의사 결정 환기). */}
      <Dialog
        open={confirmTarget !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmTarget(null);
        }}
        alertDialog
        title="차단을 해제할까요?"
        description={
          confirmTarget
            ? `@${confirmTarget.username} 의 메시지와 DM/멘션이 다시 표시됩니다.`
            : undefined
        }
      >
        <div className="flex justify-end gap-[var(--s-2)]">
          <button
            type="button"
            data-testid="unblock-confirm-cancel"
            onClick={() => setConfirmTarget(null)}
            className="qf-btn qf-btn--ghost qf-btn--sm"
          >
            취소
          </button>
          <button
            type="button"
            data-testid="unblock-confirm-ok"
            onClick={() => {
              if (confirmTarget) runUnblock(confirmTarget.userId, confirmTarget.username);
              setConfirmTarget(null);
            }}
            className="qf-btn qf-btn--secondary qf-btn--sm"
          >
            차단 해제
          </button>
        </div>
      </Dialog>
    </main>
  );
}
