import { useEffect, useRef } from 'react';
import { useSendMessage } from './useMessages';
import { useCompose } from '../../stores/compose-store';

type Props = {
  workspaceId: string;
  channelId: string;
  channelName: string;
};

export function MessageComposer({ workspaceId, channelId, channelName }: Props): JSX.Element {
  const draft = useCompose((s) => s.drafts[channelId] ?? '');
  const setDraft = useCompose((s) => s.setDraft);
  const clearDraft = useCompose((s) => s.clearDraft);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { send, mutation } = useSendMessage(workspaceId, channelId);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [channelId]);

  const submit = (): void => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    send(trimmed);
    clearDraft(channelId);
  };

  return (
    <form
      data-testid="msg-composer"
      className="border-t border-border-subtle bg-chat p-[var(--s-4)]"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="sr-only" htmlFor="msg-input">
        {`# ${channelName} 로 메시지 보내기`}
      </label>
      <textarea
        id="msg-input"
        ref={textareaRef}
        data-testid="msg-input"
        value={draft}
        onChange={(e) => setDraft(channelId, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={2}
        maxLength={4000}
        placeholder={`# ${channelName} 에 메시지…`}
        className="qf-input qf-textarea"
      />
      <div className="mt-[var(--s-2)] flex items-center justify-between text-[length:var(--fs-11)] text-text-muted">
        <span>{draft.length} / 4000 · Enter 전송, Shift+Enter 줄바꿈</span>
        <button
          type="submit"
          data-testid="msg-send"
          disabled={mutation.isPending || draft.trim().length === 0}
          className="qf-btn qf-btn--primary qf-btn--sm"
        >
          전송
        </button>
      </div>
    </form>
  );
}
