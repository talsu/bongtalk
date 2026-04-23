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

export interface CustomEmojiOption {
  id: string;
  name: string;
  url: string;
}

type Props = {
  /**
   * Fired with the selected emoji token. Unicode glyph for the curated
   * tabs, shortcode `:name:` for the workspace custom-emoji tab — the
   * caller decides what to do with either form.
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
  /**
   * task-037-D: workspace custom emoji pack. When supplied + non-empty,
   * a "워크스페이스" tab renders first so users default to the pack they
   * uploaded rather than scrolling past the curated Unicode tabs.
   */
  customEmojis?: CustomEmojiOption[];
};

export function EmojiPicker({
  onSelect,
  onDismiss,
  isActive,
  className,
  customEmojis,
}: Props): JSX.Element {
  const hasCustom = (customEmojis?.length ?? 0) > 0;
  // Workspace tab when present is index 0; curated tabs shift right.
  const [tab, setTab] = useState(hasCustom ? 0 : 0);
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

  const tabs = hasCustom
    ? [{ label: '워크스페이스' }, ...EMOJI_CATEGORIES.map((c) => ({ label: c.label }))]
    : EMOJI_CATEGORIES.map((c) => ({ label: c.label }));
  const customTabActive = hasCustom && tab === 0;
  const curatedIndex = hasCustom ? tab - 1 : tab;

  return (
    <div
      ref={rootRef}
      role="menu"
      data-testid="emoji-picker"
      className={cn('qf-menu flex w-64 flex-col gap-[var(--s-2)] p-[var(--s-3)]', className)}
    >
      <div className="flex items-center gap-[var(--s-1)] border-b border-border-subtle pb-[var(--s-2)] text-[length:var(--fs-11)]">
        {tabs.map((t, i) => (
          <button
            key={t.label}
            type="button"
            onClick={() => setTab(i)}
            className={cn(
              'px-[var(--s-2)] py-[var(--s-1)] rounded-[var(--r-sm)]',
              i === tab ? 'bg-bg-selected text-text-strong' : 'text-text-muted hover:text-text',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {customTabActive ? (
        <div className="grid grid-cols-6 gap-[var(--s-1)]" data-testid="emoji-picker-custom-grid">
          {customEmojis?.map((ce) => {
            const token = `:${ce.name}:`;
            return (
              <button
                key={ce.id}
                type="button"
                data-testid={`emoji-pick-custom-${ce.name}`}
                aria-pressed={isActive?.(token) ?? undefined}
                onClick={() => onSelect(token)}
                title={token}
                className={cn(
                  'qf-menu__item !p-[var(--s-1)] grid place-items-center',
                  isActive?.(token) && 'bg-bg-selected',
                )}
              >
                <img
                  src={ce.url}
                  alt={ce.name}
                  className="qf-emoji-custom qf-emoji-custom--picker"
                  style={{ width: 40, height: 40, objectFit: 'contain' }}
                />
              </button>
            );
          })}
        </div>
      ) : (
        <div className="grid grid-cols-8 gap-[var(--s-1)]">
          {EMOJI_CATEGORIES[curatedIndex].emojis.map((e) => (
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
      )}
    </div>
  );
}
