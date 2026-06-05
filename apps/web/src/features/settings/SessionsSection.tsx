import { useState } from 'react';
import type { SessionSummary } from '@qufox/shared-types';
import { Dialog } from '../../design-system/primitives';
import { useNotifications } from '../../stores/notification-store';
import { useRevokeAllSessions, useRevokeSession, useSessions } from './useSecurity';

/**
 * S77b (D14 / FR-PS-15): 활성 세션 목록 + 개별/전체 로그아웃.
 *
 * isCurrent 세션은 "현재 기기" 로 표시하고 개별 로그아웃 버튼을 두지 않는다(전체 로그아웃은
 * 현재 세션을 제외하므로 안전). 비어 있으면 안내 문구만 노출한다.
 */
export function SessionsSection(): JSX.Element {
  const notify = useNotifications((s) => s.push);
  const { data, isLoading, isError } = useSessions();
  const revoke = useRevokeSession();
  const revokeAll = useRevokeAllSessions();

  // MINOR-02 (a11y): "다른 기기 모두 로그아웃" 은 파괴적 액션이라 alertDialog 확인을 거친다.
  const [confirmOpen, setConfirmOpen] = useState(false);

  const sessions = data?.sessions ?? [];
  const hasOthers = sessions.some((s) => !s.isCurrent);

  const onRevoke = async (id: string): Promise<void> => {
    try {
      await revoke.mutateAsync(id);
      notify({ variant: 'success', title: '세션을 로그아웃했습니다.' });
    } catch (err) {
      notify({ variant: 'danger', title: '로그아웃 실패', body: (err as Error).message });
    }
  };

  const onRevokeAll = async (): Promise<void> => {
    try {
      await revokeAll.mutateAsync();
      notify({ variant: 'success', title: '다른 모든 기기에서 로그아웃했습니다.' });
      setConfirmOpen(false);
    } catch (err) {
      notify({ variant: 'danger', title: '로그아웃 실패', body: (err as Error).message });
    }
  };

  return (
    <section
      data-testid="sessions-section"
      aria-label="활성 세션"
      className="flex flex-col gap-[var(--s-3)]"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-[length:var(--fs-15)] font-semibold">활성 세션</h2>
        {hasOthers ? (
          <button
            type="button"
            data-testid="sessions-revoke-all"
            className="qf-btn qf-btn--ghost qf-btn--sm"
            onClick={() => setConfirmOpen(true)}
            disabled={revokeAll.isPending}
            aria-busy={revokeAll.isPending}
          >
            다른 기기 모두 로그아웃
          </button>
        ) : null}
      </div>

      {isLoading ? (
        <p role="status" className="text-text-muted">
          불러오는 중…
        </p>
      ) : isError ? (
        <p role="alert" className="qf-field__error">
          세션을 불러올 수 없습니다.
        </p>
      ) : sessions.length === 0 ? (
        <p className="text-text-muted">활성 세션이 없습니다.</p>
      ) : (
        <ul className="flex flex-col gap-[var(--s-2)]">
          {sessions.map((s) => (
            <SessionRow key={s.id} session={s} onRevoke={onRevoke} revoking={revoke.isPending} />
          ))}
        </ul>
      )}

      {/* MINOR-02 (a11y): 파괴적 액션 확인 alertDialog. */}
      <Dialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="다른 모든 기기에서 로그아웃"
        description="현재 기기를 제외한 모든 세션이 즉시 로그아웃됩니다. 계속할까요?"
        alertDialog
      >
        <div
          data-testid="sessions-revoke-all-confirm"
          className="flex justify-end gap-[var(--s-2)]"
        >
          <button
            type="button"
            className="qf-btn qf-btn--ghost"
            onClick={() => setConfirmOpen(false)}
          >
            취소
          </button>
          <button
            type="button"
            data-testid="sessions-revoke-all-submit"
            className="qf-btn qf-btn--danger"
            onClick={() => void onRevokeAll()}
            disabled={revokeAll.isPending}
            aria-busy={revokeAll.isPending}
          >
            {revokeAll.isPending ? '로그아웃 중…' : '모두 로그아웃'}
          </button>
        </div>
      </Dialog>
    </section>
  );
}

function SessionRow({
  session,
  onRevoke,
  revoking,
}: {
  session: SessionSummary;
  onRevoke: (id: string) => void | Promise<void>;
  revoking: boolean;
}): JSX.Element {
  const label = session.deviceName ?? session.userAgent ?? '알 수 없는 기기';
  const seen = session.lastSeenAt ?? session.createdAt;
  return (
    <li
      data-testid={`session-row-${session.id}`}
      className="flex items-center justify-between rounded-[var(--r-md)] border border-border-subtle px-[var(--s-3)] py-[var(--s-2)]"
    >
      <div className="flex flex-col">
        <span className="text-[length:var(--fs-14)] font-medium">
          {label}
          {session.isCurrent ? (
            <span
              data-testid="session-current-badge"
              className="ml-[var(--s-2)] text-[length:var(--fs-11)] text-text-muted"
            >
              (현재 기기)
            </span>
          ) : null}
        </span>
        <span className="text-[length:var(--fs-12)] text-text-muted">
          {session.ip ?? 'IP 미상'} · {new Date(seen).toLocaleString()}
        </span>
      </div>
      {!session.isCurrent ? (
        <button
          type="button"
          data-testid={`session-revoke-${session.id}`}
          // "로그아웃" 텍스트만으론 행마다 접근명이 중복 → aria-label 로 기기명을 포함해 구분.
          aria-label={`${label} 세션 로그아웃`}
          className="qf-btn qf-btn--ghost qf-btn--sm"
          onClick={() => void onRevoke(session.id)}
          disabled={revoking}
        >
          로그아웃
        </button>
      ) : null}
    </li>
  );
}
