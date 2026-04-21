import { useCallback, useState } from 'react';
import type { ReactionSummary } from '@qufox/shared-types';
import { cn } from '../../lib/cn';
import { EmojiPicker } from './EmojiPicker';

type Props = {
  reactions: ReactionSummary[];
  onToggle: (emoji: string, currentlyByMe: boolean) => void;
  /** Controlled picker state so the message toolbar can open it. */
  pickerOpen?: boolean;
  onPickerOpenChange?: (open: boolean) => void;
};

export function ReactionBar({
  reactions,
  onToggle,
  pickerOpen: controlledOpen,
  onPickerOpenChange,
}: Props): JSX.Element | null {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? (controlledOpen as boolean) : uncontrolledOpen;
  const setOpen = useCallback(
    (v: boolean): void => {
      if (!isControlled) setUncontrolledOpen(v);
      onPickerOpenChange?.(v);
    },
    [isControlled, onPickerOpenChange],
  );

  const hasAny = reactions.length > 0;
  // Suppress the inline "+" button when no reactions exist yet: the DS
  // toolbar 😀 button already drives the picker, and a second hover
  // affordance under the message body just adds noise.
  if (!hasAny && !open) return null;

  return (
    <div data-testid="reaction-bar" className="qf-reactions relative">
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
      {hasAny ? (
        <button
          type="button"
          data-testid="reaction-add-btn"
          onClick={() => setOpen(!open)}
          aria-label="리액션 추가"
          aria-expanded={open}
          className="qf-reaction"
        >
          +
        </button>
      ) : null}
      {open ? (
        <EmojiPicker
          className="absolute z-[var(--z-dropdown,50)] mt-1"
          onSelect={(emoji) => {
            const existing = reactions.find((r) => r.emoji === emoji);
            onToggle(emoji, existing?.byMe ?? false);
            setOpen(false);
          }}
          onDismiss={() => setOpen(false)}
          isActive={(emoji) => reactions.find((r) => r.emoji === emoji)?.byMe ?? false}
        />
      ) : null}
    </div>
  );
}
