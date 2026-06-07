import { useEffect, useMemo, useRef, useState } from 'react';
import type { SlashCommandItem } from '@qufox/shared-types';
import { detectTrigger, type Trigger, type TriggerKind } from './detectTrigger';
import { rankMembers, type RankableMember } from './rankMembers';
import { filterChannels, type RankableChannel } from './filterChannels';
import { filterEmojis, type EmojiCandidate } from './filterEmojis';
import { filterSlashCommands } from './filterSlashCommands';
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
// S79 (FR-SC-01): 슬래시 커맨드 후보 상한(PRD D15: 최대 10개·스크롤 가능).
const SLASH_LIMIT = 10;

/**
 * S88a (FR-MN-03): `@` 자동완성에 노출할 워크스페이스 역할 후보. colorHex 는 표시용,
 * mentionable 은 가시성 게이트용(non-mentionable 역할은 OWNER/ADMIN 에게만 노출).
 */
export type RoleCandidate = {
  id: string;
  name: string;
  colorHex: string | null;
  mentionable: boolean;
};

export type MentionRow =
  | { type: 'special'; item: SpecialMentionItem }
  | { type: 'member'; member: RankableMember; online: boolean }
  | { type: 'role'; role: RoleCandidate };

export type ChannelRow = { type: 'channel'; channel: RankableChannel };
export type EmojiRow = { type: 'emoji'; emoji: EmojiCandidate };
export type SlashCommandRow = { type: 'slash'; command: SlashCommandItem };
export type AutocompleteRow = MentionRow | ChannelRow | EmojiRow | SlashCommandRow;

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
  // S79 (FR-SC-01): 슬래시 커맨드 후보(빌트인 상수 + 워크스페이스 커스텀 병합).
  // useSlashCommands 훅의 GET 응답을 호출부가 주입한다.
  slashCommands: SlashCommandItem[];
  online: Set<string>;
  recentMembers: string[];
  recentEmojis: string[];
  role: WorkspaceRole;
  // S88a (FR-MN-03): 워크스페이스 역할 후보(@ 자동완성용). 호출부(MessageComposer)가
  // listRoles 응답을 주입한다. 미지정이면 역할 행을 노출하지 않는다(기존 동작).
  roles?: RoleCandidate[];
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
  /**
   * S78 reviewer FF3 (a11y): 트리거(@/#/:)는 활성(미해제)인데 결과가 0건이라
   * 팝업이 열리지 않는 상태. 팝업은 rows>0 일 때만 열리므로 이 신호가 없으면
   * SR 사용자는 "결과 없음"을 알 수 없다(시각 사용자는 빈 팝업 부재로 추정).
   * 호출부(MessageComposer)가 이 신호로 "검색 결과가 없습니다"를 공지한다.
   * 활성 트리거가 없거나(=null) 결과가 1건 이상이면 null.
   */
  emptyTriggerKind: TriggerKind | null;
};

/**
 * S88a (FR-MN-03): `@` 자동완성에 노출할 역할 행을 만든다.
 *
 * 가시성(서버가 최종 권위 · 보수적 클라 규칙):
 *   - mentionable 역할은 모두 노출(누구나 멘션 가능).
 *   - non-mentionable 역할은 actor 가 OWNER/ADMIN 일 때만 노출(MENTION_EVERYONE 추정 —
 *     specialMention 의 canUseSpecialMention 패턴과 일관).
 *
 * 이름 prefix(case-insensitive) 로 필터하고 MENTION_LIMIT 으로 cap 한다.
 */
function buildRoleRows(query: string, sources: AutocompleteSources): MentionRow[] {
  if (!sources.roles || sources.roles.length === 0) return [];
  const canMentionRestricted = sources.role === 'OWNER' || sources.role === 'ADMIN';
  const q = query.toLowerCase();
  return sources.roles
    .filter((r) => r.mentionable || canMentionRestricted)
    .filter((r) => q.length === 0 || r.name.toLowerCase().startsWith(q))
    .slice(0, MENTION_LIMIT)
    .map((role): MentionRow => ({ type: 'role', role }));
}

function buildMentionRows(query: string, sources: AutocompleteSources): MentionRow[] {
  const specials = specialMentionItems(sources.role, query).map(
    (item): MentionRow => ({ type: 'special', item }),
  );
  const roles = buildRoleRows(query, sources);
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
  // 순서: 특수멘션(@everyone/@here) → 역할 → 멤버.
  return [...specials, ...roles, ...members];
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
  // S79: exhaustive switch — 새 TriggerKind 추가 시 default 의 never 할당이
  // 컴파일 에러를 내 분기 누락을 막는다.
  switch (kind) {
    case 'mention':
      return buildMentionRows(query, sources);
    case 'channel':
      return filterChannels({ channels: sources.channels, query, limit: CHANNEL_LIMIT }).map(
        (channel): ChannelRow => ({ type: 'channel', channel }),
      );
    case 'emoji':
      return filterEmojis({
        unicode: UNICODE_EMOJI_CANDIDATES,
        custom: sources.customEmojis,
        recent: sources.recentEmojis,
        query,
        limit: EMOJI_LIMIT,
      }).map((emoji): EmojiRow => ({ type: 'emoji', emoji }));
    case 'slash':
      return filterSlashCommands(sources.slashCommands, query, SLASH_LIMIT).map(
        (command): SlashCommandRow => ({ type: 'slash', command }),
      );
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
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

  // FF3: 트리거 활성(미해제)인데 결과 0건 → 팝업은 닫혀 있지만 "결과 없음"을
  // SR 에 알려야 하는 상태. 사용자가 Esc 로 해제(dismissed)했으면 알리지 않는다.
  const emptyTriggerKind =
    !dismissed && trigger !== null && rows.length === 0 ? trigger.kind : null;

  return {
    state,
    move,
    setActiveIndex,
    activeRow,
    close: () => setDismissed(true),
    emptyTriggerKind,
  };
}
