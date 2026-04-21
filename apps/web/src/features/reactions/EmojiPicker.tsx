import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/cn';

// Curated emoji palette. First tab is "frequently used" (the set the DS
// composer + reaction mockups show), rest grouped by theme. Hand-curated
// to keep the bundle thin — a full emoji library (~1800) costs more
// than it delivers at this stage.
export const EMOJI_CATEGORIES: { label: string; emojis: string[] }[] = [
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
  /**
   * Fired with the selected emoji. Caller decides whether to close the
   * picker or keep it open (composer inserts + keeps open; reactions
   * close immediately).
   */
  onSelect: (emoji: string) => void;
  /** Invoked on outside click / Escape so the caller can close. */
  onDismiss: () => void;
  /**
   * Which emoji(s) should render pressed. Reactions pass the byMe set so
   * the picker reflects "already added" state; the composer can skip.
   */
  isActive?: (emoji: string) => boolean;
  /** Tailwind class appended to the outer panel (position, z-index). */
  className?: string;
};

export function EmojiPicker({ onSelect, onDismiss, isActive, className }: Props): JSX.Element {
  const [tab, setTab] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMouse = (e: MouseEvent): void => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) onDismiss();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('mousedown', onMouse);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onMouse);
      window.removeEventListener('keydown', onKey);
    };
  }, [onDismiss]);

  return (
    <div
      ref={rootRef}
      role="menu"
      data-testid="emoji-picker"
      className={cn('qf-menu flex w-64 flex-col gap-[var(--s-2)] p-[var(--s-3)]', className)}
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
        {EMOJI_CATEGORIES[tab].emojis.map((e) => (
          <button
            key={e}
            type="button"
            data-testid={`emoji-pick-${e}`}
            aria-pressed={isActive?.(e) ?? undefined}
            onClick={() => onSelect(e)}
            className={cn(
              'qf-menu__item !p-[var(--s-1)] text-center text-[length:var(--fs-15)]',
              isActive?.(e) && 'bg-bg-selected',
            )}
          >
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}
