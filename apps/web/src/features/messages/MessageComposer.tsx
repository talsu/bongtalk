import { useEffect, useRef } from 'react';
import { useSendMessage } from './useMessages';
import { useCompose } from '../../stores/compose-store';
import { getSocket } from '../../lib/socket';

type Props = {
  workspaceId: string;
  channelId: string;
  channelName: string;
};

// Task-018-F: client-side safety margin for the typing ping cadence. The
// server throttles per (userId, channelId) at TYPING_THROTTLE_SEC (3 s),
// but re-emitting at 1.5 s keeps the indicator alive across brief pauses
// without flooding the socket. The server still enforces the floor.
const TYPING_EMIT_INTERVAL_MS = 1500;

export function MessageComposer({ workspaceId, channelId, channelName }: Props): JSX.Element {
  const draft = useCompose((s) => s.drafts[channelId] ?? '');
  const setDraft = useCompose((s) => s.setDraft);
  const clearDraft = useCompose((s) => s.clearDraft);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastPingRef = useRef<number>(0);
  const { send, mutation } = useSendMessage(workspaceId, channelId);

  useEffect(() => {
    textareaRef.current?.focus();
    lastPingRef.current = 0;
  }, [channelId]);

  const maybePing = (): void => {
    const now = Date.now();
    if (now - lastPingRef.current < TYPING_EMIT_INTERVAL_MS) return;
    lastPingRef.current = now;
    const socket = getSocket();
    if (socket?.connected) {
      socket.emit('typing.ping', { channelId });
    }
  };

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
        onChange={(e) => {
          setDraft(channelId, e.target.value);
          if (e.target.value.length > 0) maybePing();
        }}
        onKeyDown={(e) => {
          // task-021-R1-ime-enter-half-sends: skip Enter when an IME
          // composition is in flight. `nativeEvent.isComposing` is the
          // standard signal; `keyCode === 229` covers older browsers /
          // Korean IMEs that dispatch the pseudo-key before composition
          // end. Without this guard, pressing Enter mid-composition
          // sends the half-formed Hangul syllable.
          const native = e.nativeEvent as KeyboardEvent & { isComposing?: boolean };
          if (native.isComposing || e.keyCode === 229) return;
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
