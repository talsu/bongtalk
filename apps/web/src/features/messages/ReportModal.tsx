import { useState } from 'react';
import {
  REPORT_CATEGORIES,
  REPORT_CATEGORY_LABELS,
  type ReportCategory,
} from '@qufox/shared-types';
import { Button, Dialog } from '../../design-system/primitives';
import { useNotifications } from '../../stores/notification-store';
import { reportMessage } from './api';

/**
 * S64 (D12 / FR-RM11): 메시지 신고 모달.
 *
 * 카테고리(SPAM/HARASSMENT/HATE_SPEECH/INAPPROPRIATE/OTHER) 선택 + 선택 사유. 제출 시
 * POST .../messages/:id/report. 중복 신고(409 REPORT_DUPLICATE)는 안내 토스트로 분기한다.
 * DS qf-* + 토큰만 사용(raw hex/px 금지). a11y: Dialog(focus trap + aria-modal), 라벨된
 * select/textarea.
 */
export function ReportModal({
  workspaceId,
  channelId,
  messageId,
  onClose,
}: {
  workspaceId: string;
  channelId: string;
  messageId: string;
  onClose: () => void;
}): JSX.Element {
  const notifications = useNotifications();
  const [category, setCategory] = useState<ReportCategory>('SPAM');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async (): Promise<void> => {
    setSubmitting(true);
    try {
      await reportMessage(workspaceId, channelId, messageId, {
        category,
        reason: reason.trim() || undefined,
      });
      notifications.push({ variant: 'success', title: '신고가 접수되었습니다.' });
      onClose();
    } catch (e) {
      const code = (e as { errorCode?: string } | undefined)?.errorCode;
      notifications.push({
        variant: code === 'REPORT_DUPLICATE' ? 'info' : 'danger',
        title: code === 'REPORT_DUPLICATE' ? '이미 신고한 메시지입니다.' : '신고에 실패했습니다.',
        body: code === 'REPORT_DUPLICATE' ? undefined : (e as Error).message,
      });
      if (code === 'REPORT_DUPLICATE') onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title="메시지 신고"
      description="이 메시지를 신고할 사유를 선택하세요."
    >
      <div className="flex flex-col gap-[var(--s-4)]" data-testid="report-modal">
        <div className="qf-field">
          <label className="qf-field__label" htmlFor="report-category">
            카테고리
          </label>
          <select
            id="report-category"
            data-testid="report-category-select"
            className="qf-input"
            value={category}
            onChange={(e) => setCategory(e.target.value as ReportCategory)}
          >
            {REPORT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {REPORT_CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </div>

        <div className="qf-field">
          <label className="qf-field__label" htmlFor="report-modal-reason">
            사유 <span className="text-text-muted">(선택)</span>
          </label>
          <textarea
            id="report-modal-reason"
            data-testid="report-modal-reason"
            rows={3}
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
            data-testid="report-modal-submit"
            disabled={submitting}
            onClick={() => void submit()}
          >
            {submitting ? '신고 중…' : '신고'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
