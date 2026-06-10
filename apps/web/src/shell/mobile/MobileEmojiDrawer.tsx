import { useEffect, useMemo, useRef, useState } from 'react';
import { EMOJI_CATEGORIES } from '../../features/reactions/EmojiPicker';
import { UNICODE_EMOJI_CANDIDATES } from '../../features/messages/autocomplete/emojiShortcodes';
import { Icon } from '../../design-system/primitives';
import { cn } from '../../lib/cn';

/**
 * 071-M1 D9 — 모바일 이모지 드로어(DS `qf-m-emoji-drawer*` 정본 골격).
 *
 * 메시지 시트의 퀵반응 5종 밖의 반응을 고를 때 여는 60vh 바텀 드로어.
 * 데이터는 새로 만들지 않는다:
 *   - 카테고리/글리프: 데스크톱 EmojiPicker 의 curated EMOJI_CATEGORIES.
 *   - 검색: `:` 자동완성의 UNICODE_EMOJI_CANDIDATES(shortcode 이름 보유)와
 *     워크스페이스 커스텀 이모지 이름을 부분 일치로 거른다.
 *   - 커스텀 선택값은 `:name:` 토큰(데스크톱 EmojiPicker custom 탭과 동일 —
 *     reactions toggle 이 그대로 받는 형식).
 */
export function MobileEmojiDrawer({
  onClose,
  onSelect,
  customEmojis,
}: {
  onClose: () => void;
  /** 유니코드 글리프 또는 커스텀 `:name:` 토큰. */
  onSelect: (emoji: string) => void;
  customEmojis?: { id: string; name: string; url: string }[];
}): JSX.Element {
  const [query, setQuery] = useState('');
  const hasCustom = (customEmojis?.length ?? 0) > 0;
  // 탭: 커스텀(있을 때만) → curated 카테고리들. 'custom' | 카테고리 인덱스.
  const [tab, setTab] = useState<'custom' | number>(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    searchRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      restoreRef.current?.focus?.();
    };
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const searchResults = useMemo(() => {
    if (q.length === 0) return null;
    const unicode = UNICODE_EMOJI_CANDIDATES.filter((c) => c.name.includes(q))
      .map((c) =>
        c.kind === 'unicode' ? { key: `u-${c.name}`, glyph: c.glyph, token: c.glyph } : null,
      )
      .filter((x): x is { key: string; glyph: string; token: string } => x !== null);
    const custom = (customEmojis ?? [])
      .filter((ce) => ce.name.toLowerCase().includes(q))
      .map((ce) => ({ key: `c-${ce.id}`, url: ce.url, name: ce.name, token: `:${ce.name}:` }));
    return { unicode, custom };
  }, [q, customEmojis]);

  const activeCategory =
    tab === 'custom' ? null : EMOJI_CATEGORIES[Math.min(tab, EMOJI_CATEGORIES.length - 1)];

  // DS 8열 grid — __row 단위로 8개씩 끊어 렌더.
  const chunk8 = <T,>(arr: T[]): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += 8) out.push(arr.slice(i, i + 8));
    return out;
  };

  const pick = (token: string): void => {
    onSelect(token);
    onClose();
  };

  return (
    <div
      data-testid="mobile-emoji-drawer"
      className="fixed inset-0 z-[var(--z-modal,60)]"
      role="dialog"
      aria-modal="true"
      aria-label="이모지 선택"
    >
      <div className="qf-m-sheet-backdrop absolute inset-0" onClick={onClose} />
      <div className="qf-m-emoji-drawer absolute bottom-0 left-0 right-0 z-[var(--z-modal)]">
        <div className="qf-m-emoji-drawer__grab" aria-hidden />
        <div className="qf-m-emoji-drawer__search">
          <div className="qf-m-emoji-drawer__search-field">
            <span className="qf-m-emoji-drawer__search-icon" aria-hidden>
              <Icon name="search" size="sm" />
            </span>
            <input
              ref={searchRef}
              type="search"
              data-testid="mobile-emoji-search"
              className="qf-m-emoji-drawer__search-input"
              placeholder="이모지 검색"
              aria-label="이모지 검색"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
        {searchResults === null ? (
          <div className="qf-m-emoji-drawer__tabs" role="tablist" aria-label="이모지 카테고리">
            {hasCustom ? (
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'custom'}
                aria-label="워크스페이스 커스텀 이모지"
                data-testid="mobile-emoji-tab-custom"
                className="qf-m-emoji-drawer__tab"
                onClick={() => setTab('custom')}
              >
                <img
                  src={customEmojis![0]!.url}
                  alt=""
                  style={{ width: 22, height: 22, objectFit: 'contain' }}
                />
              </button>
            ) : null}
            {EMOJI_CATEGORIES.map((c, i) => (
              <button
                key={c.label}
                type="button"
                role="tab"
                aria-selected={tab === i}
                aria-label={c.label}
                data-testid={`mobile-emoji-tab-${i}`}
                className="qf-m-emoji-drawer__tab"
                onClick={() => setTab(i)}
              >
                {c.emojis[0]}
              </button>
            ))}
          </div>
        ) : null}
        <div className="qf-m-emoji-drawer__grid">
          {searchResults !== null ? (
            <>
              <div className="qf-m-emoji-drawer__category-label">검색 결과</div>
              {searchResults.unicode.length === 0 && searchResults.custom.length === 0 ? (
                <p className="px-[var(--s-2)] py-[var(--s-4)] text-[length:var(--fs-13)] text-text-muted">
                  일치하는 이모지가 없습니다
                </p>
              ) : null}
              {chunk8([
                ...searchResults.custom.map((ce) => ({
                  key: ce.key,
                  token: ce.token,
                  url: ce.url,
                  name: ce.name,
                  glyph: null as string | null,
                })),
                ...searchResults.unicode.map((u) => ({
                  key: u.key,
                  token: u.token,
                  url: null as string | null,
                  name: u.token,
                  glyph: u.glyph,
                })),
              ]).map((row, ri) => (
                <div key={ri} className="qf-m-emoji-drawer__row">
                  {row.map((cell) => (
                    <button
                      key={cell.key}
                      type="button"
                      className="qf-m-emoji-drawer__cell"
                      aria-label={`${cell.name} 반응`}
                      onClick={() => pick(cell.token)}
                    >
                      {cell.glyph ?? (
                        <img
                          src={cell.url ?? ''}
                          alt=""
                          style={{ width: 28, height: 28, objectFit: 'contain' }}
                        />
                      )}
                    </button>
                  ))}
                </div>
              ))}
            </>
          ) : tab === 'custom' ? (
            <>
              <div className="qf-m-emoji-drawer__category-label">커스텀</div>
              {chunk8(customEmojis ?? []).map((row, ri) => (
                <div key={ri} className="qf-m-emoji-drawer__row">
                  {row.map((ce) => (
                    <button
                      key={ce.id}
                      type="button"
                      data-testid={`mobile-emoji-custom-${ce.name}`}
                      className="qf-m-emoji-drawer__cell"
                      aria-label={`:${ce.name}: 반응`}
                      onClick={() => pick(`:${ce.name}:`)}
                    >
                      <img
                        src={ce.url}
                        alt=""
                        style={{ width: 28, height: 28, objectFit: 'contain' }}
                      />
                    </button>
                  ))}
                </div>
              ))}
            </>
          ) : activeCategory ? (
            <>
              <div className="qf-m-emoji-drawer__category-label">{activeCategory.label}</div>
              {chunk8(activeCategory.emojis).map((row, ri) => (
                <div key={ri} className={cn('qf-m-emoji-drawer__row')}>
                  {row.map((g) => (
                    <button
                      key={g}
                      type="button"
                      className="qf-m-emoji-drawer__cell"
                      aria-label={`${g} 반응`}
                      onClick={() => pick(g)}
                    >
                      {g}
                    </button>
                  ))}
                </div>
              ))}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
