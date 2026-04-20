import { useState } from 'react';
import type { ReactionSummary } from '@qufox/shared-types';
import { cn } from '../../lib/cn';

const QUICK_EMOJIS = ['👍', '❤️', '😂', '🎉', '🚀', '👀', '🙏', '🔥'] as const;

type Props = {
  reactions: ReactionSummary[];
  onToggle: (emoji: string, currentlyByMe: boolean) => void;
};

export function ReactionBar({ reactions, onToggle }: Props): JSX.Element | null {
  const [pickerOpen, setPickerOpen] = useState(false);
  if (reactions.length === 0 && !pickerOpen) {
    return (
      <div data-testid="reaction-bar" className="qf-reactions">
        <button
          type="button"
          data-testid="reaction-add-btn"
          onClick={() => setPickerOpen(true)}
          aria-label="리액션 추가"
          className="qf-reaction opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        >
          +
        </button>
      </div>
    );
  }
  return (
    <div data-testid="reaction-bar" className="qf-reactions">
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          data-testid={`reaction-${r.emoji}`}
          data-bymine={r.byMe ? 'true' : 'false'}
          onClick={() => onToggle(r.emoji, r.byMe)}
          aria-pressed={r.byMe}
          aria-label={`${r.emoji} ${r.count}`}
          className={cn('qf-reaction', r.byMe && 'qf-reaction--me')}
        >
          <span>{r.emoji}</span>
          <span className="tabular-nums">{r.count}</span>
        </button>
      ))}
      <button
        type="button"
        data-testid="reaction-add-btn"
        onClick={() => setPickerOpen((v) => !v)}
        aria-label="리액션 추가"
        className="qf-reaction"
      >
        +
      </button>
      {pickerOpen ? (
        <div
          role="menu"
          data-testid="reaction-picker"
          className="qf-menu !min-w-0 flex items-center gap-0.5"
        >
          {QUICK_EMOJIS.map((e) => {
            const existing = reactions.find((r) => r.emoji === e);
            const byMe = existing?.byMe ?? false;
            return (
              <button
                key={e}
                type="button"
                data-testid={`reaction-pick-${e}`}
                onClick={() => {
                  onToggle(e, byMe);
                  setPickerOpen(false);
                }}
                className="qf-menu__item !p-[var(--s-2)]"
              >
                {e}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
