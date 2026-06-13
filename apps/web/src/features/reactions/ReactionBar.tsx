import { useCallback, useState } from 'react';
import type { ReactionSummary } from '@qufox/shared-types';
import { cn } from '../../lib/cn';
import { Tooltip } from '../../design-system/primitives';
import { EmojiPicker, type CustomEmojiOption } from './EmojiPicker';

// 072-N0 (FR-RE04, audit 2026-06-13-desktop-uiux-audit.md): 반응 칩 hover 툴팁
// 라벨을 산출한다. Stage1 이 ReactionSummary 에 previewUsers(≤5·안정정렬)를 추가했다.
//   - previewUsers 가 있으면 "A, B, C 외 N명이 반응"(N = count - 표시인원, ≤0 이면 생략).
//   - previewUsers 가 없거나 비면(구 API·미채움 경로) "N명이 반응"으로 graceful 폴백.
// previewUsers 는 forward-compat optional 이라 옵셔널 접근으로 방어한다.
function reactionTooltipLabel(r: ReactionSummary): string {
  const preview = r.previewUsers ?? [];
  if (preview.length === 0) {
    return `${r.count}명이 반응`;
  }
  const names = preview.map((u) => u.displayName ?? u.username);
  const remaining = r.count - names.length;
  return remaining > 0
    ? `${names.join(', ')} 외 ${remaining}명이 반응`
    : `${names.join(', ')}님이 반응`;
}

type Props = {
  reactions: ReactionSummary[];
  onToggle: (emoji: string, currentlyByMe: boolean) => void;
  /** Controlled picker state so the message toolbar can open it. */
  pickerOpen?: boolean;
  onPickerOpenChange?: (open: boolean) => void;
  /** task-037-D workspace emoji pack forwarded to the picker. */
  customEmojis?: CustomEmojiOption[];
  /**
   * S42 (FR-PK01/PK03/PK04): 피커에 그대로 전달되는 퀵 반응 / 최근 이모지 / 기본
   * 스킨톤. 호출부가 emoji-picker-data 로부터 사용자 우선·없으면 워크스페이스 기본을
   * 이미 합성해 넘긴다(피커는 받은 대로 노출). 미제공 시 피커는 종전 동작 그대로.
   */
  quickReactions?: string[];
  recentEmojis?: string[];
  defaultSkinTone?: number;
  /**
   * S40 (FR-RE05): 한 이모지의 전체 reactor 목록 모달을 여는 콜백(선택). 제공되면
   * 각 칩 옆에 "N명 보기" 보조 버튼이 추가로 렌더된다 — 칩 본체의 기본 클릭은
   * 그대로 토글(FR-RE01)을 유지하고, reactor 목록 열기는 별도 affordance 로 분리해
   * 토글 동작 회귀를 막는다(additive·미제공 시 기존 동작 그대로).
   */
  onShowReactors?: (emoji: string) => void;
};

export function ReactionBar({
  reactions,
  onToggle,
  pickerOpen: controlledOpen,
  onPickerOpenChange,
  customEmojis,
  quickReactions,
  recentEmojis,
  defaultSkinTone,
  onShowReactors,
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

  // S41 (FR-EM06): 한 반응 칩의 시각 토큰을 결정한다.
  //   - url 이 있으면(살아있는 커스텀 이모지) <img> 칩.
  //   - emoji 가 `:name:` 슬러그인데 url 이 없으면(삭제된 커스텀 이모지 →
  //     customEmojiId=null 로 풀림) [삭제된 이모지] placeholder.
  //   - 그 외(유니코드) 글리프 텍스트.
  const isCustomToken = (emoji: string): boolean => /^:[a-z0-9_]{2,32}:$/.test(emoji);

  // S41 fix-forward (HIGH): 자기 토글의 낙관 업데이트는 reaction payload 에 아직
  // url 이 없다(서버 reaction:updated 가 도착하기 전까지 useReactions 가
  // {emoji,count,byMe} 만 채움). 워크스페이스 이모지 팩(customEmojis — 피커에 이미
  // 주입됨)에서 `:name:` → url 을 직접 해석해, 방금 추가한 살아있는 커스텀 이모지가
  // "[삭제된 이모지]" 로 깜빡이는 회귀를 막는다. 팩에도 없으면(진짜 삭제됨)
  // placeholder 로 폴백한다.
  const customUrlByToken = new Map<string, string>(
    (customEmojis ?? []).map((ce) => [`:${ce.name}:`, ce.url]),
  );
  const resolveUrl = (r: ReactionSummary): string | null =>
    r.url ?? customUrlByToken.get(r.emoji) ?? null;
  const isDeletedCustom = (r: ReactionSummary): boolean => isCustomToken(r.emoji) && !resolveUrl(r);

  // S39 (SHOULD 4 a11y): 칩 카운트 변경을 스크린리더에 과통지 없이 알리는 요약 문장.
  // aria-live="polite" + aria-atomic 영역에 현재 집계를 한 줄로 싣는다(reaction:updated
  // 로 reactions prop 이 바뀌면 SR 이 변경분만 읽음). 삭제된 커스텀 이모지는 슬러그를
  // 그대로 읽되 "삭제된 이모지" 를 덧붙인다.
  const liveSummary = hasAny
    ? reactions
        .map((r) => {
          const label = isDeletedCustom(r) ? `${r.emoji} (삭제된 이모지)` : r.emoji;
          return `${label} ${r.count}명`;
        })
        .join(', ')
    : '';

  return (
    <div data-testid="reaction-bar" className="qf-reactions relative">
      {reactions.map((r) => {
        // S41 fix-forward: payload url 부재 시 워크스페이스 팩에서 해석(낙관 깜빡임 방지).
        const url = resolveUrl(r);
        const deleted = isCustomToken(r.emoji) && !url;
        return (
          <span key={r.emoji} className="inline-flex items-center">
            {/* 072-N0 (FR-RE04): 데스크톱 hover/focus 시 반응자 미리보기 툴팁(DS
                .qf-tooltip — Radix Tooltip 프리미티브). Radix 는 포인터 hover·키보드
                focus 에서만 열리고 터치는 발화하지 않으므로, 모바일(qf-m-*) 터치 동작은
                그대로 보존된다(데스크톱 전용 affordance). asChild 로 칩 버튼 위에 합성돼
                data-testid·aria-label 등 기존 속성은 유지된다. */}
            <Tooltip label={reactionTooltipLabel(r)} side="top">
              <button
                type="button"
                data-testid={`reaction-${r.emoji}`}
                data-bymine={r.byMe ? 'true' : 'false'}
                data-custom={r.customEmojiId ? 'true' : undefined}
                data-deleted={deleted ? 'true' : undefined}
                onClick={() => onToggle(r.emoji, r.byMe)}
                aria-pressed={r.byMe}
                // S39 (SHOULD 4): 칩의 의미를 완결문으로 — 이모지·인원수·내 반응 여부.
                // 내부 토큰은 aria-hidden 으로 가려 이중 읽기를 막는다. S41(FR-EM06):
                // 삭제된 커스텀 이모지면 라벨에 슬러그 + "삭제된 이모지" 를 싣는다.
                aria-label={`${
                  deleted ? `${r.emoji} 삭제된 이모지` : r.emoji
                } 반응, ${r.count}명, ${r.byMe ? '내가 반응함' : '반응 안 함'}`}
                className={cn('qf-reaction', r.byMe && 'qf-reaction--me')}
              >
                {url ? (
                  // S41 (FR-EM06): 살아있는 커스텀 이모지 — CSS 고정크기 <img> 칩.
                  <img
                    src={url}
                    alt={r.emoji}
                    aria-hidden="true"
                    className="qf-emoji-custom qf-emoji-custom--reaction"
                    style={{ width: 18, height: 18, objectFit: 'contain' }}
                  />
                ) : isCustomToken(r.emoji) ? (
                  // S41 (FR-EM06): 삭제된 커스텀 이모지 — [삭제된 이모지] placeholder
                  // (회색 박스 + 물음표). 원래 슬러그는 title 툴팁으로 보존한다.
                  <span
                    aria-hidden="true"
                    title={r.emoji}
                    data-testid={`reaction-deleted-${r.emoji}`}
                  >
                    ⬚?
                  </span>
                ) : (
                  <span aria-hidden="true">{r.emoji}</span>
                )}
                <span className="tabular-nums" aria-hidden="true">
                  {r.count}
                </span>
              </button>
            </Tooltip>
            {onShowReactors ? (
              <button
                type="button"
                data-testid={`reaction-reactors-${r.emoji}`}
                onClick={() => onShowReactors(r.emoji)}
                // S40 (FR-RE05): reactor 목록 dialog 를 여는 보조 버튼. 토글 칩과
                // 분리해 클릭 의미 충돌을 막는다. SR 에는 "N명 본다"는 의도를 알린다.
                // S40 fix-forward (MINOR): 인접 칩이 이미 이모지를 발화하므로 이 버튼의
                // aria-label 에서 이모지를 빼 이중 발화를 막는다.
                aria-haspopup="dialog"
                aria-label={`${r.count}명의 반응자 목록 보기`}
                // S40 fix-forward (SERIOUS a11y+DS): opacity-70 은 대비 4.06:1(<4.5)
                // 미달 + DS .qf-reaction hover 가 bg/border 전환이라 opacity 미정의였다.
                // 색 토큰(--text-muted → --text-secondary hover)으로 교체해 대비를
                // 통과시키고 DS hover 언어와 정합시킨다. 칩과의 시각 분리는 유지된다.
                className="qf-reaction text-[color:var(--text-muted)] hover:text-[color:var(--text-secondary)]"
              >
                <span aria-hidden="true">⋯</span>
              </button>
            ) : null}
          </span>
        );
      })}
      {hasAny ? (
        <button
          type="button"
          data-testid="reaction-add-btn"
          onClick={() => setOpen(!open)}
          aria-label="리액션 추가"
          aria-expanded={open}
          // S39 (SHOULD 4): "+" 버튼이 이모지 선택 dialog 를 연다는 것을 SR 에 알린다.
          aria-haspopup="dialog"
          className="qf-reaction"
        >
          +
        </button>
      ) : null}
      {/* S39 (SHOULD 4): 카운트 변경 SR 요약(시각적 비표시). 과통지 방지를 위해
          polite + atomic 으로 현재 집계 한 줄만 갱신한다. */}
      <span data-testid="reaction-live" className="sr-only" aria-live="polite" aria-atomic="true">
        {liveSummary}
      </span>
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
          customEmojis={customEmojis}
          quickReactions={quickReactions}
          recentEmojis={recentEmojis}
          defaultSkinTone={defaultSkinTone}
        />
      ) : null}
    </div>
  );
}
