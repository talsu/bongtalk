import { useEffect, useRef } from 'react';
import { useSendMessage } from './useMessages';
import { useCompose } from '../../stores/compose-store';

type Props = {
  workspaceId: string;
  channelId: string;
  channelName: string;
};

/**
 * Message input. Persists per-channel drafts in the compose-store so
 * switching channels mid-typing doesn't lose the text. Enter sends,
 * Shift+Enter newlines, 4000-char cap matches the backend validator.
 */
export function MessageComposer({ workspaceId, channelId, channelName }: Props): JSX.Element {
  const draft = useCompose((s) => s.drafts[channelId] ?? '');
  const setDraft = useCompose((s) => s.setDraft);
  const clearDraft = useCompose((s) => s.clearDraft);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { send, mutation } = useSendMessage(workspaceId, channelId);

  // Focus composer when channel changes.
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
      className="border-t border-border-subtle p-3"
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
        className="w-full resize-none rounded-md border border-border-subtle bg-bg-surface px-3 py-2 text-sm text-foreground placeholder:text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="mt-1 flex items-center justify-between text-[11px] text-text-muted">
        <span>{draft.length} / 4000 · Enter 전송, Shift+Enter 줄바꿈</span>
        <button
          type="submit"
          data-testid="msg-send"
          disabled={mutation.isPending || draft.trim().length === 0}
          className="rounded-md bg-bg-primary px-3 py-1 text-[11px] font-semibold text-fg-primary disabled:opacity-50"
        >
          전송
        </button>
      </div>
    </form>
  );
}
