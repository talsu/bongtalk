import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Dialog } from '../../design-system/primitives';
import { useUI } from '../../stores/ui-store';
import { useMyWorkspaces } from '../workspaces/useWorkspaces';
import { useNotifications } from '../../stores/notification-store';
import { submitFeedback, type FeedbackCategory } from './api';

const MAX_CONTENT = 2000;

/**
 * Task-016-C-3: feedback modal. Opened from the BottomBar. Three
 * categories (BUG / FEATURE / OTHER), content textarea with character
 * counter, submit → POST /feedback. Success shows a toast; failure
 * keeps the form open + shows an error so the user can retry.
 */
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
      className="max-w-lg"
    >
      <div className="space-y-3">
        <label className="block text-xs text-text-muted">
          카테고리
          <select
            data-testid="feedback-category"
            value={category}
            onChange={(e) => setCategory(e.target.value as FeedbackCategory)}
            className="mt-1 block w-full rounded-md border border-border-subtle bg-bg-surface px-2 py-1 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="BUG">🐛 버그</option>
            <option value="FEATURE">✨ 기능 제안</option>
            <option value="OTHER">💬 기타</option>
          </select>
        </label>
        <label className="block text-xs text-text-muted">
          내용
          <textarea
            data-testid="feedback-content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            maxLength={MAX_CONTENT}
            rows={6}
            placeholder="무엇을 발견하셨나요? 무엇이 필요한가요?"
            className="mt-1 block w-full resize-none rounded-md border border-border-subtle bg-bg-surface px-2 py-1 text-sm text-foreground placeholder:text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <div className="flex items-center justify-between text-[11px] text-text-muted">
          <span>{`${content.length} / ${MAX_CONTENT}`}</span>
          <button
            type="button"
            data-testid="feedback-submit"
            onClick={submit}
            disabled={!canSubmit}
            className="rounded-md bg-bg-primary px-3 py-1 text-xs font-semibold text-fg-primary disabled:opacity-50"
          >
            {submitting ? '보내는 중…' : '보내기'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
