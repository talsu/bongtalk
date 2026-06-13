import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { usePutUserEmojiPreference } from '../emojis/useCustomEmojis';

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

/**
 * 072-N0 (감사 D05 mock 6800-6808, FR-PK03): 스킨톤 스와치 메타. 1=기본 + 2-6 톤.
 * `swatch` 는 미리보기에 쓰는 대표 글리프(✋ 손)에 톤 수정자를 입힌 글리프이고,
 * `label` 은 스크린리더용 한국어 명칭이다(스와치는 role="radio"·aria-label).
 */
const SKIN_TONE_OPTIONS: { tone: number; label: string }[] = [
  { tone: 1, label: '기본 피부톤' },
  { tone: 2, label: '밝은 피부톤' },
  { tone: 3, label: '연한 피부톤' },
  { tone: 4, label: '중간 피부톤' },
  { tone: 5, label: '진한 피부톤' },
  { tone: 6, label: '어두운 피부톤' },
];

/**
 * 072-N0 (감사 D05 mock 6742-6747, FR-PK03): 피커 검색 필터. 컴포저 ':' 자동완성의
 * filterEmojis 와 같은 "소문자 includes" 매칭 규칙을 따르되, 피커의 풀은 큐레이션
 * 유니코드 글리프(shortcode 이름 없음)와 커스텀 이모지 slug 두 종류라 입력 형태가
 * 달라 별도 순수 함수로 둔다(autocomplete 의 filterEmojis 는 EmojiCandidate[] 전제).
 *   - 커스텀 이모지: slug(name) 부분 일치.
 *   - 큐레이션 글리프: shortcode 이름이 없으므로 글리프 자체 포함 여부로만 매칭한다
 *     (이모지 글리프를 직접 입력하는 경우 대비 — 텍스트 질의에는 자연히 비매칭).
 */
export function filterPickerEmojis(glyphs: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return glyphs;
  return glyphs.filter((g) => g.toLowerCase().includes(q));
}

function filterCustomEmojis(
  customEmojis: CustomEmojiOption[] | undefined,
  query: string,
): CustomEmojiOption[] {
  const list = customEmojis ?? [];
  const q = query.trim().toLowerCase();
  if (q.length === 0) return list;
  return list.filter((ce) => ce.name.toLowerCase().includes(q));
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
   * S78 reviewer (a11y MEDIUM): 호출부가 트리거 버튼의 aria-controls 로 이
   * 패널을 가리킬 수 있도록 외부에서 주입하는 DOM id. 미제공 시 id 없음.
   */
  id?: string;
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
  id,
  customEmojis,
  quickReactions,
  recentEmojis,
  defaultSkinTone,
}: Props): JSX.Element {
  const hasCustom = (customEmojis?.length ?? 0) > 0;
  const hasRecent = (recentEmojis?.length ?? 0) > 0;
  const hasQuick = (quickReactions?.length ?? 0) > 0;
  const [tab, setTab] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  // 072-N0 (FR-PK03): 스킨톤은 로컬 낙관 상태로 둬 스와치 클릭 즉시 미리보기에
  // 반영하고, 동시에 PUT /me/emoji-preferences 로 영속화한다. 서버가 응답하면
  // usePutUserEmojiPreference 가 emoji-picker-data 쿼리를 무효화해 defaultSkinTone
  // prop 이 재수렴하므로, prop 변경 시 로컬 상태를 동기화한다(외부 갱신·다른 기기).
  const [tone, setTone] = useState(defaultSkinTone ?? 1);
  useEffect(() => {
    setTone(defaultSkinTone ?? 1);
  }, [defaultSkinTone]);
  const putPref = usePutUserEmojiPreference();
  const onPickTone = (next: number): void => {
    if (next === tone) return;
    setTone(next); // 낙관 미리보기
    putPref.mutate({ defaultSkinTone: next });
  };

  // 072-N0 (FR-PK03, 감사 D05 mock 6742-6747): 검색 질의. 큐레이션 글리프 + 커스텀
  // slug 를 filterPickerEmojis/filterCustomEmojis 로 좁힌다. 질의가 있으면 탭 무관
  // 통합 검색 그리드를 노출해 도달성을 보완한다(감사 finding "카테고리/세트 범위").
  const [search, setSearch] = useState('');
  const trimmedSearch = search.trim();
  const isSearching = trimmedSearch.length > 0;
  const searchCurated = useMemo(() => {
    if (!isSearching) return [];
    const all = EMOJI_CATEGORIES.flatMap((c) => c.emojis);
    // 중복 글리프(여러 카테고리에 동일 글리프) 제거 후 필터.
    const unique = Array.from(new Set(all));
    return filterPickerEmojis(unique, trimmedSearch).map((g) => applySkinTone(g, tone));
  }, [isSearching, trimmedSearch, tone]);
  const searchCustom = useMemo(
    () => (isSearching ? filterCustomEmojis(customEmojis, trimmedSearch) : []),
    [isSearching, customEmojis, trimmedSearch],
  );

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

  // S42 fix-forward (HIGH): 앞쪽 특수 탭(recent/custom) 개수가 변동하면 활성 탭이
  // 가리키던 카테고리가 밀려 stale 인덱스가 된다. 특수 탭 개수가 바뀔 때 선택 탭을
  // 0(첫 탭)으로 리셋해 범위초과 인덱싱과 잘못된 탭 활성을 함께 방지한다.
  const specialTabCount = (hasRecent ? 1 : 0) + (hasCustom ? 1 : 0);
  useEffect(() => {
    setTab(0);
  }, [specialTabCount]);

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
  // S42 fix-forward (HIGH): 피커가 열린 채 specialTabs 개수가 변동(예: 마지막 커스텀
  // 이모지 삭제로 custom 탭 소멸·또는 데이터 비동기 도착)하면 stale tab 으로 산출한
  // curatedIndex 가 [0, EMOJI_CATEGORIES.length-1] 범위를 벗어나 undefined.emojis
  // 접근으로 throw → 메시지 행 언마운트 크래시였다. (b) tabs 개수 변동 시 tab 을 0 으로
  // 리셋하고, (a) 그래도 같은 렌더에서 stale 값을 쓰는 한 틱을 위해 인덱싱 전 clamp 한다.
  const rawCuratedIndex = tab - specialTabs.length;
  const curatedIndex = Math.min(Math.max(rawCuratedIndex, 0), EMOJI_CATEGORIES.length - 1);

  return (
    <div
      ref={rootRef}
      id={id}
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
          role="group"
          aria-label="퀵 반응"
          className="flex items-center gap-[var(--s-1)] border-b border-border-subtle pb-[var(--s-2)]"
        >
          {quickReactions?.map((e) => (
            <button
              key={`quick-${e}`}
              type="button"
              data-testid={`emoji-quick-${e}`}
              aria-label={e}
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
      {/* 072-N0 (감사 D05 mock 6742-6747): 이모지 검색창. 입력 시 탭을 숨기고
          큐레이션 + 커스텀 통합 결과 그리드를 노출한다. qf-input 토큰 폼만 사용. */}
      <input
        type="text"
        data-testid="emoji-picker-search"
        aria-label="이모지 검색"
        placeholder="이모지 검색"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="qf-input !h-8 !px-[var(--s-3)] text-[length:var(--fs-13)]"
      />
      {isSearching ? null : (
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
      )}
      {isSearching ? (
        // 072-N0 (감사 D05 mock 6742-6747): 검색 결과 — 커스텀(slug 일치) 먼저,
        // 이어 큐레이션 글리프. 빈 결과면 안내 문구를 노출한다.
        searchCurated.length + searchCustom.length === 0 ? (
          <p
            data-testid="emoji-picker-search-empty"
            className="px-[var(--s-1)] py-[var(--s-3)] text-center text-[length:var(--fs-12)] text-text-muted"
          >
            결과 없음
          </p>
        ) : (
          <div
            className="grid grid-cols-8 gap-[var(--s-1)]"
            data-testid="emoji-picker-search-grid"
            role="group"
            aria-label="이모지 검색 결과"
          >
            {searchCustom.map((ce) => {
              const token = `:${ce.name}:`;
              return (
                <button
                  key={`search-custom-${ce.id}`}
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
                    style={{ width: 32, height: 32, objectFit: 'contain' }}
                  />
                </button>
              );
            })}
            {searchCurated.map((toned) => (
              <button
                key={`search-${toned}`}
                type="button"
                data-testid={`emoji-pick-${toned}`}
                aria-pressed={isActive?.(toned) ?? undefined}
                onClick={() => onSelect(toned)}
                className={cn(
                  'qf-menu__item !p-[var(--s-1)] text-center text-[length:var(--fs-15)]',
                  isActive?.(toned) && 'bg-bg-selected',
                )}
              >
                {toned}
              </button>
            ))}
          </div>
        )
      ) : recentTabActive ? (
        <div
          className="grid grid-cols-8 gap-[var(--s-1)]"
          data-testid="emoji-picker-recent-grid"
          role="group"
          aria-label="최근 사용한 이모지"
        >
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
      {/* 072-N0 (FR-PK03, 감사 D05 mock 6800-6808): 스킨톤 선택 푸터. 6종 스와치를
          radiogroup 으로 노출한다. 선택 시 PUT /me/emoji-preferences 로 영속화하고
          (usePutUserEmojiPreference) applySkinTone 으로 미리보기(✋)를 즉시 갱신한다.
          스와치 색상은 인라인 hex/rgba 대신 톤 글리프를 직접 렌더해 토큰 규칙을 지킨다. */}
      <div
        data-testid="emoji-picker-skintone"
        role="radiogroup"
        aria-label="기본 스킨톤"
        className="flex items-center justify-center gap-[var(--s-1)] border-t border-border-subtle pt-[var(--s-2)]"
      >
        {SKIN_TONE_OPTIONS.map(({ tone: t, label }) => {
          const selected = t === tone;
          return (
            <button
              key={`skintone-${t}`}
              type="button"
              role="radio"
              data-testid={`emoji-skintone-${t}`}
              aria-label={label}
              aria-checked={selected}
              disabled={putPref.isPending}
              onClick={() => onPickTone(t)}
              className={cn(
                'qf-menu__item !p-[var(--s-1)] text-center text-[length:var(--fs-15)]',
                selected && 'bg-bg-selected',
              )}
            >
              {applySkinTone('✋', t)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
