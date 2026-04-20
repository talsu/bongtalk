import { useEffect, useState } from 'react';
import { Dialog, Button, Input } from '../../design-system/primitives';
import { useNotifications } from '../../stores/notification-store';
import { useCreateChannel } from './useChannels';

type Props = {
  workspaceId: string;
  /** null = default "채널" group (no category). */
  categoryId: string | null;
  /** Display name of the target category, for the dialog description. */
  categoryLabel: string;
  open: boolean;
  onClose: () => void;
};

/**
 * Task-020-ish UX: channel creation is now modal-driven. Each category
 * header (real or the "채널" default group) fires this with its own
 * categoryId so the new channel lands in the right bucket.
 */
export function CreateChannelModal({
  workspaceId,
  categoryId,
  categoryLabel,
  open,
  onClose,
}: Props): JSX.Element | null {
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const notify = useNotifications((s) => s.push);
  const createMut = useCreateChannel(workspaceId);

  useEffect(() => {
    if (open) {
      setName('');
      setTopic('');
      setSubmitting(false);
    }
  }, [open]);

  if (!open) return null;

  const canSubmit = !submitting && name.trim().length > 0;

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const trimmedTopic = topic.trim();
      await createMut.mutateAsync({
        name: name.trim(),
        type: 'TEXT',
        categoryId: categoryId ?? undefined,
        ...(trimmedTopic ? { topic: trimmedTopic } : {}),
      });
      onClose();
    } catch (err) {
      notify({
        variant: 'danger',
        title: '채널 생성 실패',
        body: (err as Error).message,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title="채널 만들기"
      description={`${categoryLabel} 아래에 새 텍스트 채널을 추가합니다.`}
    >
      <form
        data-testid="create-channel-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="qf-field">
          <label className="qf-field__label" htmlFor="create-channel-name">
            채널 이름
          </label>
          <Input
            id="create-channel-name"
            data-testid="create-channel-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="예: general"
            maxLength={80}
          />
          <p className="qf-field__hint">공백 대신 하이픈(-)을 쓰면 깔끔해 보여요.</p>
        </div>
        <div className="qf-field">
          <label className="qf-field__label" htmlFor="create-channel-topic">
            설명 <span className="text-text-muted">(선택)</span>
          </label>
          <Input
            id="create-channel-topic"
            data-testid="create-channel-topic"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="예: 공지 · 일반 대화"
            maxLength={1024}
          />
          <p className="qf-field__hint">
            채널 상단 제목 옆에 표시됩니다. 나중에 언제든 수정할 수 있어요.
          </p>
        </div>
        <div className="qf-modal__footer">
          <Button type="button" variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button
            type="submit"
            data-testid="create-channel-submit"
            disabled={!canSubmit}
            variant="primary"
          >
            {submitting ? '만드는 중…' : '만들기'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
