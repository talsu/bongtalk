import { useEffect, useRef, useState } from 'react';
import { Dialog, Icon } from '../../design-system/primitives';
import { EmojiPicker } from '../reactions/EmojiPicker';
import {
  useCustomStatus,
  useSetCustomStatus,
  useClearCustomStatus,
} from './useCustomStatus';
import type { StatusPreset } from '@qufox/shared-types';
import { cn } from '../../lib/cn';

/**
 * 072-N2-1 (FR-P04/P17 · FR-PS-05): 데스크톱 커스텀 상태 편집 모달.
 *
 * 종전 데스크톱은 커스텀 상태(이모지+텍스트+만료) 편집 진입점이 없었다(서버·훅은
 * 완비). 이 모달이 BottomBar presence 드롭다운·설정 프로필 탭의 공용 편집 표면이다.
 * EmojiPicker(reactions)를 재사용해 이모지를 고르고, 텍스트(≤100)·만료 프리셋 6종을
 * 받아 useSetCustomStatus 로 저장한다(프리셋→서버가 timezone 기준 expiresAt 계산).
 */
const PRESET_OPTIONS: { value: StatusPreset; label: string }[] = [
  { value: 'dont_clear', label: '지우지 않음' },
  { value: 'thirty_min', label: '30분' },
  { value: 'one_hour', label: '1시간' },
  { value: 'four_hours', label: '4시간' },
  { value: 'today', label: '오늘' },
  { value: 'this_week', label: '이번 주' },
];

const TEXT_MAX = 100;

export function CustomStatusModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (_open: boolean) => void;
}): JSX.Element {
  const { data: current } = useCustomStatus();
  const setStatus = useSetCustomStatus();
  const clearStatus = useClearCustomStatus();
  const [text, setText] = useState('');
  const [emoji, setEmoji] = useState<string | null>(null);
  const [preset, setPreset] = useState<StatusPreset>('dont_clear');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emojiBtnRef = useRef<HTMLButtonElement>(null);

  // 모달이 열릴 때 현재 상태로 초기화(닫힐 때 정리).
  useEffect(() => {
    if (open) {
      setText(current?.text ?? '');
      setEmoji(current?.emoji ?? null);
      setPreset('dont_clear');
      setError(null);
      setEmojiOpen(false);
    }
  }, [open, current]);

  const pending = setStatus.isPending || clearStatus.isPending;

  const onSave = async (): Promise<void> => {
    if (pending) return;
    setError(null);
    const trimmed = text.trim();
    // 텍스트·이모지 둘 다 비면 지우기와 동일하게 처리.
    if (!trimmed && !emoji) {
      await onClear();
      return;
    }
    try {
      await setStatus.mutateAsync({
        text: trimmed || null,
        emoji: emoji || null,
        preset,
      });
      onOpenChange(false);
    } catch {
      setError('상태를 저장하지 못했습니다. 잠시 후 다시 시도해주세요.');
    }
  };

  const onClear = async (): Promise<void> => {
    if (pending) return;
    setError(null);
    try {
      await clearStatus.mutateAsync();
      onOpenChange(false);
    } catch {
      setError('상태를 지우지 못했습니다. 잠시 후 다시 시도해주세요.');
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="커스텀 상태 설정"
      description="이모지와 메시지로 지금 상태를 알려보세요."
      className="w-[min(92vw,26rem)]"
    >
      <div data-testid="custom-status-modal" className="flex flex-col gap-[var(--s-3)]">
        <div className="relative flex items-center gap-[var(--s-2)]">
          <button
            ref={emojiBtnRef}
            type="button"
            data-testid="custom-status-emoji-btn"
            aria-label="상태 이모지 선택"
            aria-expanded={emojiOpen}
            onClick={() => setEmojiOpen((v) => !v)}
            className="qf-btn qf-btn--ghost qf-btn--icon shrink-0"
          >
            {emoji ? (
              <span className="text-[length:var(--fs-18)]">{emoji}</span>
            ) : (
              <Icon name="emoji" size="sm" />
            )}
          </button>
          <input
            type="text"
            data-testid="custom-status-text"
            aria-label="상태 메시지"
            placeholder="무슨 일이 있나요?"
            value={text}
            maxLength={TEXT_MAX}
            onChange={(e) => setText(e.target.value)}
            className="qf-input flex-1"
          />
          {emoji ? (
            <button
              type="button"
              aria-label="이모지 제거"
              data-testid="custom-status-emoji-clear"
              onClick={() => setEmoji(null)}
              className="qf-row-iconbtn shrink-0"
            >
              <Icon name="x" size="sm" />
            </button>
          ) : null}
          {emojiOpen ? (
            <EmojiPicker
              className="absolute left-0 top-[calc(100%+var(--s-1))] z-overlay"
              onSelect={(e) => {
                setEmoji(e);
                setEmojiOpen(false);
              }}
              onDismiss={() => setEmojiOpen(false)}
            />
          ) : null}
        </div>

        <label className="flex items-center justify-between gap-[var(--s-2)] text-[length:var(--fs-13)]">
          <span className="text-text-secondary">자동 삭제</span>
          <select
            data-testid="custom-status-expiry"
            aria-label="상태 자동 삭제 시점"
            value={preset}
            onChange={(e) => setPreset(e.target.value as StatusPreset)}
            className={cn('qf-input w-[10rem]')}
          >
            {PRESET_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        {error ? (
          <div role="alert" className="text-[length:var(--fs-12)] text-[color:var(--danger)]">
            {error}
          </div>
        ) : null}

        <div className="flex justify-between gap-[var(--s-2)]">
          <button
            type="button"
            data-testid="custom-status-clear"
            disabled={pending || (!current?.text && !current?.emoji)}
            onClick={() => void onClear()}
            className="qf-btn qf-btn--ghost"
          >
            상태 지우기
          </button>
          <div className="flex gap-[var(--s-2)]">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="qf-btn qf-btn--ghost"
            >
              취소
            </button>
            <button
              type="button"
              data-testid="custom-status-save"
              disabled={pending}
              onClick={() => void onSave()}
              className="qf-btn qf-btn--primary"
            >
              저장
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
