import { useState } from 'react';
import {
  REPORT_ACTION_LABELS,
  REPORT_ACTIONS,
  REPORT_CATEGORY_LABELS,
  TIMEOUT_DURATION_PRESETS,
  type ModerationReport,
  type ReportAction,
  type ReportQueueFilter,
} from '@qufox/shared-types';
import { Button, Dialog } from '../../../design-system/primitives';
import { useNotifications } from '../../../stores/notification-store';
import { cn } from '../../../lib/cn';
import { useReports, useResolveReport } from '../useModeration';

/**
 * S64 (D12 / FR-RM11): 신고 큐 패널(워크스페이스 설정 reports 탭, MODERATOR+).
 *
 * 미처리/전체 필터 + 신고 행(카테고리·사유·신고자·메시지 발췌) + 처리 모달
 * (DISMISS/WARN/DELETE_MESSAGE/TIMEOUT/BAN). DS qf-* + 토큰만 사용(raw hex/px 금지).
 * a11y: 목록 role=list, 처리 모달은 Dialog(focus trap + aria-modal).
 */
export function ReportQueuePanel({ workspaceId }: { workspaceId: string }): JSX.Element {
  const [filter, setFilter] = useState<ReportQueueFilter>('OPEN');
  const query = useReports(workspaceId, filter);
  const [resolving, setResolving] = useState<ModerationReport | null>(null);

  const reports = query.data?.reports ?? [];

  return (
    <div className="flex flex-col gap-[var(--s-4)]" data-testid="report-queue-panel">
      <div
        role="group"
        aria-label="신고 큐 필터"
        className="flex gap-[var(--s-1)]"
        data-testid="report-queue-filter"
      >
        {(['OPEN', 'ALL'] as const).map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            data-testid={`report-filter-${f.toLowerCase()}`}
            className={cn(
              'px-[var(--s-3)] py-[var(--s-2)] rounded-[var(--r-sm)] text-[length:var(--fs-13)]',
              filter === f
                ? 'bg-bg-accent text-text-strong'
                : 'text-text-muted hover:text-foreground',
            )}
            onClick={() => setFilter(f)}
          >
            {f === 'OPEN' ? '미처리' : '전체'}
          </button>
        ))}
      </div>

      {query.isLoading ? (
        <p className="text-[length:var(--fs-13)] text-text-muted" role="status" aria-live="polite">
          불러오는 중…
        </p>
      ) : query.isError ? (
        <p className="qf-field__error" data-testid="report-queue-error" role="alert">
          신고 큐를 불러오지 못했습니다.
        </p>
      ) : reports.length === 0 ? (
        <p className="text-[length:var(--fs-13)] text-text-muted" data-testid="report-queue-empty">
          {filter === 'OPEN' ? '미처리 신고가 없습니다.' : '신고가 없습니다.'}
        </p>
      ) : (
        <ul
          role="list"
          aria-label="신고 목록"
          className="flex flex-col gap-[var(--s-2)]"
          data-testid="report-queue-list"
        >
          {reports.map((r) => (
            <ReportRow key={r.id} report={r} onResolve={() => setResolving(r)} />
          ))}
        </ul>
      )}

      {resolving ? (
        <ResolveReportModal
          workspaceId={workspaceId}
          report={resolving}
          onClose={() => setResolving(null)}
        />
      ) : null}
    </div>
  );
}

function ReportRow({
  report,
  onResolve,
}: {
  report: ModerationReport;
  onResolve: () => void;
}): JSX.Element {
  const resolved = report.resolvedAt !== null;
  const reporterName = report.reporter?.username ?? '(알 수 없음)';
  const categoryLabel = REPORT_CATEGORY_LABELS[report.category];
  // S64 fix-forward (security A-2 · FE): 본문 표시 우선순위 — 삭제 > 비공개 마스킹 > 본문.
  const messagePreview = report.message?.deleted
    ? '[삭제된 메시지]'
    : report.message?.contentMasked
      ? '[비공개 채널 메시지]'
      : (report.message?.content ?? '').slice(0, 80);
  return (
    <li
      role="listitem"
      data-testid="report-row"
      className="flex items-start justify-between gap-[var(--s-3)] rounded-[var(--r-sm)] bg-bg-subtle px-[var(--s-3)] py-[var(--s-2)]"
    >
      <div className="min-w-0 flex flex-col gap-[var(--s-1)]">
        <span className="text-[length:var(--fs-13)] text-text-strong">
          {categoryLabel}
          {report.reason ? ` · ${report.reason}` : ''}
        </span>
        <span className="text-[length:var(--fs-12)] text-text-muted truncate">
          신고자 {reporterName} · {messagePreview}
        </span>
        {/* S64 fix-forward (a11y M-04 · SC 1.4.1): 처리 상태를 색만이 아니라 배지로 표시한다. */}
        {resolved ? (
          <span className="qf-badge qf-badge--success" data-testid="report-resolved-badge">
            처리됨: {report.resolvedAction ? REPORT_ACTION_LABELS[report.resolvedAction] : ''}
          </span>
        ) : null}
      </div>
      {!resolved ? (
        // S64 fix-forward (a11y H-02 · SC 2.4.6): 버튼 라벨이 "처리" 만으로는 어느 신고인지
        // 알 수 없다. 카테고리 + 신고자를 aria-label 로 명시한다.
        <Button
          data-testid="report-resolve-open"
          aria-label={`${categoryLabel} 신고 처리 (신고자 ${reporterName})`}
          onClick={onResolve}
        >
          처리
        </Button>
      ) : null}
    </li>
  );
}

function ResolveReportModal({
  workspaceId,
  report,
  onClose,
}: {
  workspaceId: string;
  report: ModerationReport;
  onClose: () => void;
}): JSX.Element {
  const resolve = useResolveReport(workspaceId);
  const notifications = useNotifications();
  const [action, setAction] = useState<ReportAction>('DISMISS');
  const [reason, setReason] = useState('');
  const [durationSeconds, setDurationSeconds] = useState<number>(
    TIMEOUT_DURATION_PRESETS[0].seconds,
  );

  // BAN/DELETE_MESSAGE 는 되돌리기 어려운 파괴적 처리라 alertdialog 로 노출한다.
  const destructive = action === 'BAN' || action === 'DELETE_MESSAGE';

  const submit = async (): Promise<void> => {
    try {
      await resolve.mutateAsync({
        reportId: report.id,
        action,
        reason: reason.trim() || undefined,
        durationSeconds: action === 'TIMEOUT' ? durationSeconds : undefined,
      });
      notifications.push({ variant: 'success', title: '신고를 처리했습니다.' });
      onClose();
    } catch (e) {
      notifications.push({
        variant: 'danger',
        title: '신고 처리 실패',
        body: (e as Error).message,
      });
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title="신고 처리"
      description={`${REPORT_CATEGORY_LABELS[report.category]} 신고를 처리합니다.`}
      alertDialog={destructive}
    >
      <div className="flex flex-col gap-[var(--s-4)]" data-testid="resolve-report-modal">
        <div className="qf-field">
          <label className="qf-field__label" htmlFor="report-action">
            처리 액션
          </label>
          <select
            id="report-action"
            data-testid="report-action-select"
            className="qf-input"
            value={action}
            onChange={(e) => setAction(e.target.value as ReportAction)}
          >
            {REPORT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {REPORT_ACTION_LABELS[a]}
              </option>
            ))}
          </select>
        </div>

        {action === 'TIMEOUT' ? (
          <div className="qf-field">
            <label className="qf-field__label" htmlFor="report-timeout-duration">
              타임아웃 기간
            </label>
            <select
              id="report-timeout-duration"
              data-testid="report-timeout-duration"
              className="qf-input"
              value={durationSeconds}
              onChange={(e) => setDurationSeconds(Number(e.target.value))}
            >
              {TIMEOUT_DURATION_PRESETS.map((p) => (
                <option key={p.seconds} value={p.seconds}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="qf-field">
          <label className="qf-field__label" htmlFor="report-reason">
            사유 <span className="text-text-muted">(선택)</span>
          </label>
          <textarea
            id="report-reason"
            data-testid="report-reason"
            rows={2}
            maxLength={512}
            className="qf-input"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>

        <div className="flex gap-[var(--s-2)] justify-end">
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button
            data-testid="report-resolve-submit"
            disabled={resolve.isPending}
            aria-busy={resolve.isPending}
            onClick={() => void submit()}
          >
            {resolve.isPending ? '처리 중…' : '처리'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
