import { useState } from 'react';
import type { ReactionSummary } from '@qufox/shared-types';
import { cn } from '../../lib/cn';

/**
 * Task-013-B: compact reaction row beneath each message.
 *   - Existing buckets render as pills (count badge). `byMe=true` pill
 *     uses the accent background so the viewer sees which reactions
 *     they've already placed.
 *   - The trailing `+` button opens a lightweight picker (starter set of
 *     frequent emojis). A real emoji-mart integration is out of scope
 *     for MVP — a curated 8-emoji list covers the most common reactions
 *     and keeps the bundle tiny.
 */
const QUICK_EMOJIS = ['👍', '❤️', '😂', '🎉', '🚀', '👀', '🙏', '🔥'] as const;

type Props = {
  reactions: ReactionSummary[];
  onToggle: (emoji: string, currentlyByMe: boolean) => void;
};

export function ReactionBar({ reactions, onToggle }: Props): JSX.Element | null {
  const [pickerOpen, setPickerOpen] = useState(false);
  if (reactions.length === 0 && !pickerOpen) {
    return (
      <div data-testid="reaction-bar" className="mt-0.5 flex items-center gap-1">
        <button
          type="button"
          data-testid="reaction-add-btn"
          onClick={() => setPickerOpen(true)}
          aria-label="리액션 추가"
          className="rounded-md px-1.5 py-0.5 text-xs text-text-muted opacity-0 transition hover:bg-bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
        >
          +
        </button>
      </div>
    );
  }
  return (
    <div data-testid="reaction-bar" className="mt-0.5 flex flex-wrap items-center gap-1">
      {reactions.map((r) => (
        <button
          key={r.emoji}
          type="button"
          data-testid={`reaction-${r.emoji}`}
          data-bymine={r.byMe ? 'true' : 'false'}
          onClick={() => onToggle(r.emoji, r.byMe)}
          aria-pressed={r.byMe}
          aria-label={`${r.emoji} ${r.count}`}
          className={cn(
            'flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs transition',
            r.byMe
              ? 'border-accent-foreground bg-bg-accent text-accent-foreground'
              : 'border-border-subtle bg-bg-surface text-text-muted hover:border-accent-foreground',
          )}
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
        className="rounded-md px-1.5 py-0.5 text-xs text-text-muted hover:bg-bg-accent hover:text-foreground"
      >
        +
      </button>
      {pickerOpen ? (
        <div
          role="menu"
          data-testid="reaction-picker"
          className="flex items-center gap-0.5 rounded-md border border-border-subtle bg-bg-surface px-1 py-0.5 shadow-sm"
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
                className="rounded px-1 py-0.5 text-sm hover:bg-bg-accent"
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
