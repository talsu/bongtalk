import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactionSummary } from '@qufox/shared-types';
import { cn } from '../../lib/cn';

// Curated emoji palette mirroring the Discord mini-picker shape. The
// first row is "frequently used" (matches the DS sample's visible
// reaction pills) and the rest are grouped by category. Keep it
// hand-curated — a full emoji library (~1800) is overkill for MVP and
// bloats the bundle.
const EMOJI_CATEGORIES: { label: string; emojis: string[] }[] = [
  { label: '자주 쓰는', emojis: ['👍', '❤️', '😂', '🎉', '🚀', '👀', '🙏', '🔥'] },
  {
    label: '표정',
    emojis: [
      '😀',
      '😁',
      '😆',
      '😅',
      '🤣',
      '😊',
      '😍',
      '🥰',
      '😘',
      '😎',
      '🤩',
      '🤔',
      '😐',
      '😴',
      '🤯',
      '😱',
      '😭',
      '😢',
      '😤',
      '😡',
    ],
  },
  {
    label: '손짓',
    emojis: ['👍', '👎', '👏', '🙌', '👋', '🤝', '🤞', '✌️', '🤘', '👌', '🤙', '💪', '🙏', '🫡'],
  },
  {
    label: '마음',
    emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💔', '💖', '💗', '💘', '💝', '💕'],
  },
  {
    label: '사물',
    emojis: [
      '✅',
      '❌',
      '⭐',
      '🌟',
      '✨',
      '⚡',
      '🔥',
      '💯',
      '🎉',
      '🎊',
      '🎈',
      '🎁',
      '📌',
      '📎',
      '🔗',
      '💡',
      '🧠',
      '🦊',
      '🚀',
      '🛠️',
    ],
  },
];

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

  const [tab, setTab] = useState(0);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Dismiss on outside click — the toolbar's 😀 button is the canonical
  // open gesture; clicking elsewhere should close without forcing the
  // caller to wire up every surface.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent): void => {
      if (!pickerRef.current) return;
      if (!pickerRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open, setOpen]);

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
        <div
          ref={pickerRef}
          role="menu"
          data-testid="reaction-picker"
          className="qf-menu absolute z-[var(--z-dropdown,50)] mt-1 flex w-64 flex-col gap-[var(--s-2)] p-[var(--s-3)]"
        >
          <div className="flex items-center gap-[var(--s-1)] border-b border-border-subtle pb-[var(--s-2)] text-[length:var(--fs-11)]">
            {EMOJI_CATEGORIES.map((c, i) => (
              <button
                key={c.label}
                type="button"
                onClick={() => setTab(i)}
                className={cn(
                  'px-[var(--s-2)] py-[var(--s-1)] rounded-[var(--r-sm)]',
                  i === tab ? 'bg-bg-selected text-text-strong' : 'text-text-muted hover:text-text',
                )}
              >
                {c.label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-8 gap-[var(--s-1)]">
            {EMOJI_CATEGORIES[tab].emojis.map((e) => {
              const existing = reactions.find((r) => r.emoji === e);
              const byMe = existing?.byMe ?? false;
              return (
                <button
                  key={e}
                  type="button"
                  data-testid={`reaction-pick-${e}`}
                  onClick={() => {
                    onToggle(e, byMe);
                    setOpen(false);
                  }}
                  className="qf-menu__item !p-[var(--s-1)] text-center text-[length:var(--fs-15)]"
                >
                  {e}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
