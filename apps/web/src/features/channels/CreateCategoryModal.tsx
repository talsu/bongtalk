import { useEffect, useState } from 'react';
import { Dialog, Button, Input } from '../../design-system/primitives';
import { useNotifications } from '../../stores/notification-store';
import { useCreateCategory } from './useChannels';

type Props = {
  workspaceId: string;
  open: boolean;
  onClose: () => void;
};

export function CreateCategoryModal({ workspaceId, open, onClose }: Props): JSX.Element | null {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const notify = useNotifications((s) => s.push);
  const createMut = useCreateCategory(workspaceId);

  useEffect(() => {
    if (open) {
      setName('');
      setSubmitting(false);
    }
  }, [open]);

  if (!open) return null;

  const canSubmit = !submitting && name.trim().length > 0;

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await createMut.mutateAsync({ name: name.trim() });
      onClose();
    } catch (err) {
      notify({
        variant: 'danger',
        title: '카테고리 생성 실패',
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
      title="카테고리 만들기"
      description="관련 채널을 묶어 정리할 수 있는 새 카테고리를 추가합니다."
    >
      <form
        data-testid="create-category-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="qf-field">
          <label className="qf-field__label" htmlFor="create-category-name">
            카테고리 이름
          </label>
          <Input
            id="create-category-name"
            data-testid="create-category-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="예: PRODUCT"
            maxLength={80}
          />
        </div>
        <div className="qf-modal__footer">
          <Button type="button" variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button
            type="submit"
            data-testid="create-category-submit"
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
