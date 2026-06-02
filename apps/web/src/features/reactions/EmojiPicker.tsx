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

/**
 * S42 (FR-PK03): 피츠패트릭 스킨톤 수정자. 1=기본(수정자 없음), 2-6=피부톤. 단일
 * codepoint 수정자를 base 글리프에 덧붙인다. base 글리프가 수정자를 지원하지 않으면
 * (예: 🎉) 시각적으로 무시되므로, 적용 가능한 손/사람 이모지에만 자연히 반영된다
 * (PRD: skinTone 을 유니코드 렌더 전반에 소급하는 건 범위 밖 — picker 기본 톤 적용까지).
 */
const SKIN_TONE_MODIFIERS = [
  '',
  '',
  '\u{1F3FB}',
  '\u{1F3FC}',
  '\u{1F3FD}',
  '\u{1F3FE}',
  '\u{1F3FF}',
];

export function applySkinTone(glyph: string, tone: number): string {
  if (tone <= 1 || tone > 6) return glyph;
  return glyph + SKIN_TONE_MODIFIERS[tone];
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
  /**
   * S42 (FR-PK01/PK04): 퀵 반응 행. 사용자 설정이 있으면 그것을, 없으면 워크스페이스
   * 기본값을 호출부가 결정해 넘긴다(피커는 받은 대로 한 줄에 노출). 비거나 미제공 시
   * 퀵 반응 행을 렌더하지 않는다.
   */
  quickReactions?: string[];
  /**
   * S42 (FR-PK01): 최근 사용 이모지(최대 36, 최근순). 비어있지 않으면 "최근" 탭이
   * 첫 탭(워크스페이스 탭보다도 앞)으로 노출된다.
   */
  recentEmojis?: string[];
  /**
   * S42 (FR-PK03): 기본 스킨톤(1-6). 큐레이션 유니코드 탭의 글리프에 적용된다(picker
   * 기본 톤). 미제공 시 1(기본).
   */
  defaultSkinTone?: number;
};

export function EmojiPicker({
  onSelect,
  onDismiss,
  isActive,
  className,
  customEmojis,
  quickReactions,
  recentEmojis,
  defaultSkinTone,
}: Props): JSX.Element {
  const hasCustom = (customEmojis?.length ?? 0) > 0;
  const hasRecent = (recentEmojis?.length ?? 0) > 0;
  const hasQuick = (quickReactions?.length ?? 0) > 0;
  const tone = defaultSkinTone ?? 1;
  const [tab, setTab] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMouse = (e: MouseEvent): void => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) onDismiss();
    };
    const onKey = (e: KeyboardEvent): void => {
      // S23 BLOCKER fix: Esc 가 피커를 닫는 데 소비되면 전파/기본동작을 멈춰
      // useGlobalShortcuts 의 read 단축키(mark-current)가 같은 Esc 로 동시
      // 발화하지 않게 한다(채널 강제 읽음 방지).
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onDismiss();
      }
    };
    window.addEventListener('mousedown', onMouse);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onMouse);
      window.removeEventListener('keydown', onKey);
    };
  }, [onDismiss]);

  // S42 (FR-PK01): 동적 탭 순서 — [최근?] [워크스페이스?] [큐레이션…]. 앞쪽 특수
  // 탭의 존재 여부에 따라 큐레이션 탭의 베이스 인덱스가 밀린다.
  const specialTabs: ('recent' | 'custom')[] = [];
  if (hasRecent) specialTabs.push('recent');
  if (hasCustom) specialTabs.push('custom');
  const tabs = [
    ...specialTabs.map((t) => ({ label: t === 'recent' ? '최근' : '워크스페이스' })),
    ...EMOJI_CATEGORIES.map((c) => ({ label: c.label })),
  ];
  const activeSpecial = tab < specialTabs.length ? specialTabs[tab] : null;
  const recentTabActive = activeSpecial === 'recent';
  const customTabActive = activeSpecial === 'custom';
  const curatedIndex = tab - specialTabs.length;

  return (
    <div
      ref={rootRef}
      role="menu"
      data-testid="emoji-picker"
      className={cn('qf-menu flex w-64 flex-col gap-[var(--s-2)] p-[var(--s-3)]', className)}
    >
      {/* S42 (FR-PK01/PK04): 퀵 반응 행 — 사용자/워크스페이스 퀵 반응을 한 줄에
          노출한다. 스킨톤은 큐레이션 탭에만 적용하고 퀵 반응에는 받은 글리프 그대로
          노출한다(사용자가 저장한 값을 변형하지 않음). */}
      {hasQuick ? (
        <div
          data-testid="emoji-picker-quick"
          className="flex items-center gap-[var(--s-1)] border-b border-border-subtle pb-[var(--s-2)]"
        >
          {quickReactions?.map((e) => (
            <button
              key={`quick-${e}`}
              type="button"
              data-testid={`emoji-quick-${e}`}
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
      ) : null}
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
      {recentTabActive ? (
        <div className="grid grid-cols-8 gap-[var(--s-1)]" data-testid="emoji-picker-recent-grid">
          {recentEmojis?.map((e, i) => (
            <button
              key={`recent-${e}-${i}`}
              type="button"
              data-testid={`emoji-recent-${e}`}
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
      ) : customTabActive ? (
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
          {EMOJI_CATEGORIES[curatedIndex].emojis.map((e) => {
            // S42 (FR-PK03): 큐레이션 글리프에 기본 스킨톤을 적용한다(적용 불가 글리프는
            // 수정자가 시각적으로 무시됨). 선택 시에도 톤이 적용된 글리프를 삽입한다.
            const toned = applySkinTone(e, tone);
            return (
              <button
                key={e}
                type="button"
                data-testid={`emoji-pick-${e}`}
                aria-pressed={isActive?.(toned) ?? undefined}
                onClick={() => onSelect(toned)}
                className={cn(
                  'qf-menu__item !p-[var(--s-1)] text-center text-[length:var(--fs-15)]',
                  isActive?.(toned) && 'bg-bg-selected',
                )}
              >
                {toned}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
