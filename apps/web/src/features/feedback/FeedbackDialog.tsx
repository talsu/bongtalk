import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Dialog } from '../../design-system/primitives';
import { useUI } from '../../stores/ui-store';
import { useMyWorkspaces } from '../workspaces/useWorkspaces';
import { useNotifications } from '../../stores/notification-store';
import { submitFeedback, type FeedbackCategory } from './api';

const MAX_CONTENT = 2000;

export function FeedbackDialog(): JSX.Element | null {
  const openModal = useUI((s) => s.openModal);
  const setOpenModal = useUI((s) => s.setOpenModal);
  const isOpen = openModal === 'feedback';
  const push = useNotifications((s) => s.push);
  const { data: mine } = useMyWorkspaces();
  const { slug } = useParams<{ slug: string }>();
  const activeWs = mine?.workspaces.find((w) => w.slug === slug);

  const [category, setCategory] = useState<FeedbackCategory>('OTHER');
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!isOpen) return null;

  const canSubmit = !submitting && content.trim().length > 0 && content.length <= MAX_CONTENT;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await submitFeedback({
        category,
        content,
        workspaceId: activeWs?.id ?? null,
      });
      push({ variant: 'success', title: '피드백 감사합니다!', ttlMs: 4000 });
      setContent('');
      setCategory('OTHER');
      setOpenModal(null);
    } catch (err) {
      push({
        variant: 'danger',
        title: '피드백 전송 실패',
        body: (err as Error).message,
        ttlMs: 6000,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(v) => setOpenModal(v ? 'feedback' : null)}
      title="피드백 보내기"
      description="버그 신고, 기능 제안, 기타 의견 무엇이든 환영합니다."
    >
      <div className="flex flex-col gap-[var(--s-4)]">
        <div className="qf-field">
          <label className="qf-field__label">카테고리</label>
          <select
            data-testid="feedback-category"
            value={category}
            onChange={(e) => setCategory(e.target.value as FeedbackCategory)}
            className="qf-input"
          >
            <option value="BUG">버그</option>
            <option value="FEATURE">기능 제안</option>
            <option value="OTHER">기타</option>
          </select>
        </div>
        <div className="qf-field">
          <label className="qf-field__label">내용</label>
          <textarea
            data-testid="feedback-content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            maxLength={MAX_CONTENT}
            rows={6}
            placeholder="무엇을 발견하셨나요? 무엇이 필요한가요?"
            className="qf-input qf-textarea"
          />
          <p className="qf-field__hint">{`${content.length} / ${MAX_CONTENT}`}</p>
        </div>
      </div>
      <div className="qf-modal__footer">
        <button type="button" onClick={() => setOpenModal(null)} className="qf-btn qf-btn--ghost">
          취소
        </button>
        <button
          type="button"
          data-testid="feedback-submit"
          onClick={submit}
          disabled={!canSubmit}
          className="qf-btn qf-btn--primary"
        >
          {submitting ? '보내는 중…' : '보내기'}
        </button>
      </div>
    </Dialog>
  );
}
