import { useCallback, useState } from 'react';
import type { ReactionSummary } from '@qufox/shared-types';
import { cn } from '../../lib/cn';
import { EmojiPicker, type CustomEmojiOption } from './EmojiPicker';

type Props = {
  reactions: ReactionSummary[];
  onToggle: (emoji: string, currentlyByMe: boolean) => void;
  /** Controlled picker state so the message toolbar can open it. */
  pickerOpen?: boolean;
  onPickerOpenChange?: (open: boolean) => void;
  /** task-037-D workspace emoji pack forwarded to the picker. */
  customEmojis?: CustomEmojiOption[];
};

export function ReactionBar({
  reactions,
  onToggle,
  pickerOpen: controlledOpen,
  onPickerOpenChange,
  customEmojis,
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

  // S39 (SHOULD 4 a11y): 칩 카운트 변경을 스크린리더에 과통지 없이 알리는 요약 문장.
  // aria-live="polite" + aria-atomic 영역에 현재 집계를 한 줄로 싣는다(reaction:updated
  // 로 reactions prop 이 바뀌면 SR 이 변경분만 읽음).
  const liveSummary = hasAny ? reactions.map((r) => `${r.emoji} ${r.count}명`).join(', ') : '';

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
          // S39 (SHOULD 4): 칩의 의미를 완결문으로 — 이모지·인원수·내 반응 여부.
          // 내부 <span> emoji 는 aria-hidden 으로 가려 이모지 이중 읽기를 막는다.
          aria-label={`${r.emoji} 반응, ${r.count}명, ${r.byMe ? '내가 반응함' : '반응 안 함'}`}
          className={cn('qf-reaction', r.byMe && 'qf-reaction--me')}
        >
          <span aria-hidden="true">{r.emoji}</span>
          <span className="tabular-nums" aria-hidden="true">
            {r.count}
          </span>
        </button>
      ))}
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
        />
      ) : null}
    </div>
  );
}
