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
    // S32 (a11y A-01/A-02 · WCAG 4.1.3): 라이브 리전 속성을 추가해 스크린리더가
    // 타이핑 상태 변화를 통지하게 합니다. label 은 안정 문자열이라 React 텍스트
    // reconcile 로 과통지가 자연 억제되며, aria-atomic 으로 전체 리전을 한 번에
    // 읽도록 보강합니다. DS 클래스(qf-typing)는 변경하지 않고 속성만 추가합니다.
    <div
      data-testid={`typing-indicator-${channelId}`}
      className="qf-typing"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
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
