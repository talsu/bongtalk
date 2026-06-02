import { useEffect, useMemo, useRef, useState } from 'react';
import { detectTrigger, type Trigger, type TriggerKind } from './detectTrigger';
import { rankMembers, type RankableMember } from './rankMembers';
import { filterChannels, type RankableChannel } from './filterChannels';
import { filterEmojis, type EmojiCandidate } from './filterEmojis';
import { UNICODE_EMOJI_CANDIDATES } from './emojiShortcodes';
import { specialMentionItems, type SpecialMentionItem, type WorkspaceRole } from './specialMention';
import { nextActiveIndex, type NavDirection } from './listboxNav';

/**
 * S18 (FR-RC03/04/05/06) — 컴포저 자동완성 오케스트레이션 훅.
 *
 * detectTrigger(텍스트, 캐럿) → kind 별로 후보를 만들고(debounce 150ms),
 * activedescendant 인덱스를 관리합니다. 데이터 소스(멤버/채널/이모지/온라인/
 * 최근)는 호출부가 주입합니다 — 서버 검색 엔드포인트는 신설하지 않고
 * 클라이언트 필터/정렬만 수행합니다.
 */
export const AUTOCOMPLETE_DEBOUNCE_MS = 150;

const MENTION_LIMIT = 8;
const CHANNEL_LIMIT = 8;
// S42 (FR-PK02): 이모지 자동완성 후보 상한을 10 으로 낮춘다(종전 12). 유니코드 +
// 커스텀 이름 + 커스텀 별칭이 혼합되어도 최대 10개만 노출한다.
const EMOJI_LIMIT = 10;

export type MentionRow =
  | { type: 'special'; item: SpecialMentionItem }
  | { type: 'member'; member: RankableMember; online: boolean };

export type ChannelRow = { type: 'channel'; channel: RankableChannel };
export type EmojiRow = { type: 'emoji'; emoji: EmojiCandidate };
export type AutocompleteRow = MentionRow | ChannelRow | EmojiRow;

export type AutocompleteState =
  | { open: false }
  | {
      open: true;
      kind: TriggerKind;
      trigger: Trigger;
      rows: AutocompleteRow[];
      activeIndex: number;
    };

export type AutocompleteSources = {
  members: RankableMember[];
  channels: RankableChannel[];
  customEmojis: EmojiCandidate[];
  online: Set<string>;
  recentMembers: string[];
  recentEmojis: string[];
  role: WorkspaceRole;
};

type UseAutocompleteInput = {
  text: string;
  caret: number;
  sources: AutocompleteSources;
  /** Global DM 등 자동완성을 끄고 싶을 때. */
  enabled?: boolean;
};

export type UseAutocompleteResult = {
  state: AutocompleteState;
  move: (direction: NavDirection) => void;
  setActiveIndex: (index: number) => void;
  /** 현재 active 행. 없으면 null. */
  activeRow: AutocompleteRow | null;
  close: () => void;
};

function buildMentionRows(query: string, sources: AutocompleteSources): MentionRow[] {
  const specials = specialMentionItems(sources.role, query).map(
    (item): MentionRow => ({ type: 'special', item }),
  );
  const members = rankMembers({
    members: sources.members,
    query,
    online: sources.online,
    recent: sources.recentMembers,
    limit: MENTION_LIMIT,
  }).map(
    (member): MentionRow => ({
      type: 'member',
      member,
      online: sources.online.has(member.userId),
    }),
  );
  return [...specials, ...members];
}

/**
 * 순수: 텍스트/캐럿/소스 → 트리거 평가 + 행 조립. 훅은 debounce 후 이 함수를
 * 호출할 뿐이라, 트리거 감지·행 조립·특수멘션 게이트의 합성을 단위 테스트로
 * 직접 검증할 수 있습니다(node 환경, DOM 렌더 불필요).
 */
export function assembleRows(
  text: string,
  caret: number,
  sources: AutocompleteSources,
  enabled = true,
): { trigger: Trigger | null; rows: AutocompleteRow[] } {
  const trigger = enabled ? detectTrigger(text, caret) : null;
  if (!trigger) return { trigger: null, rows: [] };
  return { trigger, rows: buildRows(trigger.kind, trigger.query, sources) };
}

function buildRows(
  kind: TriggerKind,
  query: string,
  sources: AutocompleteSources,
): AutocompleteRow[] {
  if (kind === 'mention') return buildMentionRows(query, sources);
  if (kind === 'channel') {
    return filterChannels({ channels: sources.channels, query, limit: CHANNEL_LIMIT }).map(
      (channel): ChannelRow => ({ type: 'channel', channel }),
    );
  }
  return filterEmojis({
    unicode: UNICODE_EMOJI_CANDIDATES,
    custom: sources.customEmojis,
    recent: sources.recentEmojis,
    query,
    limit: EMOJI_LIMIT,
  }).map((emoji): EmojiRow => ({ type: 'emoji', emoji }));
}

export function useAutocomplete({
  text,
  caret,
  sources,
  enabled = true,
}: UseAutocompleteInput): UseAutocompleteResult {
  // debounce 150ms: 입력 후 일정 시간 멈춰야 트리거를 평가한다.
  const [debounced, setDebounced] = useState<{ text: string; caret: number }>({ text, caret });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setDebounced({ text, caret });
    }, AUTOCOMPLETE_DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [text, caret]);

  const { trigger, rows } = useMemo(
    () => assembleRows(debounced.text, debounced.caret, sources, enabled),
    [enabled, debounced.text, debounced.caret, sources],
  );

  // S18 리뷰 NIT: 사용자가 Esc 로 닫았던 팝업은 "새 트리거" 가 시작될 때만
  // 다시 연다. 이전엔 caret 이동(bare ArrowLeft/Right)만으로도 dismissed 가
  // 리셋돼 같은 토큰 위에서 화살표를 누르면 팝업이 되살아났다. trigger.start /
  // trigger.kind 가 바뀐 경우 = 다른 트리거로 이동한 것이므로 그때만 재오픈한다.
  useEffect(() => {
    setDismissed(false);
  }, [trigger?.start, trigger?.kind]);

  // 트리거/행이 바뀌면 active 를 첫 항목으로 리셋.
  useEffect(() => {
    setActiveIndex(0);
  }, [trigger?.kind, trigger?.start, rows.length]);

  const open = !dismissed && trigger !== null && rows.length > 0;

  const state: AutocompleteState = open
    ? {
        open: true,
        kind: trigger!.kind,
        trigger: trigger!,
        rows,
        activeIndex: Math.min(activeIndex, rows.length - 1),
      }
    : { open: false };

  const move = (direction: NavDirection): void => {
    if (!open) return;
    setActiveIndex((cur) => nextActiveIndex(cur, direction, rows.length));
  };

  const activeRow = open ? (rows[Math.min(activeIndex, rows.length - 1)] ?? null) : null;

  return {
    state,
    move,
    setActiveIndex,
    activeRow,
    close: () => setDismissed(true),
  };
}
