import { useTypingStore } from './useTypingStore';
import { formatTypingLabel } from './formatTyping';

type Props = {
  channelId: string;
  viewerId: string | null;
  nameByUserId: Map<string, string>;
};

// task-019 hotfix: zustand selectors MUST return a stable reference
// when the selected state is unchanged. Returning `?? []` fresh each
// call caused `useSyncExternalStore` to see a new snapshot every render,
// which React 18 treats as a violation and raises `Minified React
// error #185` (Maximum update depth exceeded). A module-level EMPTY
// array avoids the churn; the same array is safe to share because
// consumers never mutate it.
const EMPTY: readonly string[] = [];

/**
 * Task-018-F: renders the `qf-typing` strip above the composer when
 * other users are typing in the current channel. Viewer is always
 * excluded. Copy matches the Full Chat Mockup (index.html line 607).
 * Format logic lives in formatTypingLabel for pure-function unit tests.
 */
export function TypingIndicator({ channelId, viewerId, nameByUserId }: Props): JSX.Element | null {
  const userIds = useTypingStore((s) => s.byChannel[channelId] ?? EMPTY);
  const label = formatTypingLabel(userIds as string[], viewerId, nameByUserId);
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
