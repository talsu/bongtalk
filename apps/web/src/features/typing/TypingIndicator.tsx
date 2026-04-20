import { useTypingStore } from './useTypingStore';
import { formatTypingLabel } from './formatTyping';

type Props = {
  channelId: string;
  viewerId: string | null;
  nameByUserId: Map<string, string>;
};

/**
 * Task-018-F: renders the `qf-typing` strip above the composer when
 * other users are typing in the current channel. Viewer is always
 * excluded. Copy matches the Full Chat Mockup (index.html line 607).
 * Format logic lives in formatTypingLabel for pure-function unit tests.
 */
export function TypingIndicator({ channelId, viewerId, nameByUserId }: Props): JSX.Element | null {
  const userIds = useTypingStore((s) => s.byChannel[channelId] ?? []);
  const label = formatTypingLabel(userIds, viewerId, nameByUserId);
  if (!label) return null;
  return (
    <div data-testid={`typing-indicator-${channelId}`} className="qf-typing">
      <span className="qf-typing__dots" aria-hidden>
        <span />
        <span />
        <span />
      </span>
      <span>
        <strong className="text-text-secondary">{label}</strong>
      </span>
    </div>
  );
}
