import { useState } from 'react';
import type { PendingInvite } from '@qufox/shared-types';
import { Button, Dialog, Icon } from '../../design-system/primitives';
import {
  useCancelPendingInvite,
  usePendingInvites,
  useUpdatePendingInvite,
} from './useEmailInvites';

/**
 * S68 (D13 / FR-W18): 보류 이메일 초대 관리 — 목록 + 개별 연장(+30일)/재발송/취소.
 * ADMIN 이상만 노출(서버 @Roles('ADMIN') 권위). 만료(expired)는 서버가 계산해 내려준다.
 */
const DATE_FORMAT = new Intl.DateTimeFormat('ko-KR', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatDate(iso: string): string {
  try {
    return DATE_FORMAT.format(new Date(iso));
  } catch {
    return iso;
  }
}

export function PendingInvitePanel({ workspaceId }: { workspaceId: string }): JSX.Element {
  const { data, isLoading } = usePendingInvites(workspaceId);
  const update = useUpdatePendingInvite(workspaceId);
  const cancel = useCancelPendingInvite(workspaceId);
  const [confirmTarget, setConfirmTarget] = useState<PendingInvite | null>(null);
  const [announce, setAnnounce] = useState('');

  const pending = data?.pending ?? [];

  const onExtend = async (p: PendingInvite): Promise<void> => {
    await update.mutateAsync({ pendingId: p.id, action: 'EXTEND' });
    setAnnounce(`${p.email} 초대를 연장했습니다.`);
  };
  const onResend = async (p: PendingInvite): Promise<void> => {
    await update.mutateAsync({ pendingId: p.id, action: 'RESEND' });
    setAnnounce(`${p.email} 에게 초대를 재발송했습니다.`);
  };
  const confirmCancel = async (): Promise<void> => {
    if (!confirmTarget) return;
    await cancel.mutateAsync(confirmTarget.id);
    setAnnounce(`${confirmTarget.email} 초대를 취소했습니다.`);
    setConfirmTarget(null);
  };

  return (
    <div
      data-testid="pending-invite-panel"
      aria-busy={isLoading}
      className="flex flex-col gap-[var(--s-4)]"
    >
      <h3 className="font-semibold text-[length:var(--fs-15)]">보류 중인 초대</h3>

      <div role="status" aria-live="polite" className="sr-only">
        {announce}
      </div>

      {isLoading ? (
        // S68 a11y (MAJOR-3): 로딩 안내를 status 라이브 영역으로 노출.
        <p role="status" className="text-[length:var(--fs-13)] text-text-muted">
          불러오는 중…
        </p>
      ) : pending.length === 0 ? (
        <p
          data-testid="pending-invite-empty"
          className="text-[length:var(--fs-13)] text-text-muted"
        >
          보류 중인 초대가 없습니다.
        </p>
      ) : (
        <ul className="flex flex-col gap-[var(--s-2)]">
          {pending.map((p) => (
            <li
              key={p.id}
              data-testid="pending-invite-row"
              data-pending-id={p.id}
              className="flex flex-col gap-[var(--s-2)] rounded-md border border-border-subtle bg-bg-surface p-[var(--s-3)]"
            >
              <div className="flex items-center justify-between gap-[var(--s-3)]">
                <span className="text-text-strong text-[length:var(--fs-13)]">{p.email}</span>
                {/* S68 a11y/ui (HIGH-5): 만료 라벨 text-danger(라이트 대비 미달) →
                    테마안전 text-text-strong + ⚠ 아이콘(색 의존 해소). */}
                <span
                  data-testid="pending-invite-status"
                  className={
                    p.expired
                      ? 'inline-flex items-center gap-[var(--s-1)] text-text-strong text-[length:var(--fs-12)]'
                      : 'text-text-muted text-[length:var(--fs-12)]'
                  }
                >
                  {p.expired ? <Icon name="alert" size="sm" className="shrink-0" /> : null}
                  {p.expired ? '만료됨' : '대기 중'}
                </span>
              </div>
              <dl className="grid grid-cols-[auto_1fr_auto_1fr] gap-x-[var(--s-3)] gap-y-[var(--s-1)] text-[length:var(--fs-12)] text-text-muted">
                <dt>역할</dt>
                <dd className="text-foreground">{p.role}</dd>
                <dt>만료</dt>
                <dd className="text-foreground">{formatDate(p.expiresAt)}</dd>
                <dt>초대자</dt>
                <dd className="text-foreground">{p.invitedBy?.username ?? '—'}</dd>
                <dt>마지막 발송</dt>
                <dd className="text-foreground">{formatDate(p.lastSentAt)}</dd>
              </dl>
              <div className="flex gap-[var(--s-2)]">
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="pending-invite-extend"
                  aria-label={`${p.email} 초대 연장`}
                  onClick={() => void onExtend(p)}
                  disabled={update.isPending}
                  aria-busy={update.isPending || undefined}
                >
                  연장 (+30일)
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="pending-invite-resend"
                  aria-label={`${p.email} 에게 초대 재발송`}
                  onClick={() => void onResend(p)}
                  disabled={update.isPending}
                  aria-busy={update.isPending || undefined}
                >
                  재발송
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  data-testid="pending-invite-cancel"
                  aria-label={`${p.email} 초대 취소`}
                  onClick={() => setConfirmTarget(p)}
                  disabled={cancel.isPending}
                >
                  취소
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={confirmTarget !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmTarget(null);
        }}
        alertDialog
        title="초대 취소"
        description={
          confirmTarget ? `${confirmTarget.email} 에게 보낸 초대를 취소합니다.` : undefined
        }
        className="w-[min(420px,92vw)]"
      >
        <div
          data-testid="pending-invite-cancel-confirm"
          className="flex gap-[var(--s-2)] justify-end"
        >
          <Button variant="ghost" onClick={() => setConfirmTarget(null)}>
            닫기
          </Button>
          <Button
            variant="danger"
            data-testid="pending-invite-cancel-submit"
            onClick={() => void confirmCancel()}
            disabled={cancel.isPending}
            aria-busy={cancel.isPending || undefined}
          >
            {cancel.isPending ? '취소 중…' : '초대 취소'}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
