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
  const [presetTouched, setPresetTouched] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emojiBtnRef = useRef<HTMLButtonElement>(null);
  const prevOpenRef = useRef(false);
  // 사용자가 폼을 편집했는지(ref — 렌더/deps 영향 없음).
  const dirtyRef = useRef(false);

  // 072-N2(리뷰 HIGH): 열림 동안 refetchOnWindowFocus 등으로 current 가 바뀌어도
  // 편집 중 입력을 덮어쓰지 않는다. 단, current 가 open 이후 늦게 도착하거나(첫 fetch)
  // 폼이 아직 pristine 이면 최신 current 로 채운다(편집 시작 전까지만).
  useEffect(() => {
    const justOpened = open && !prevOpenRef.current;
    prevOpenRef.current = open;
    if (!open) return;
    if (justOpened) {
      setText(current?.text ?? '');
      setEmoji(current?.emoji ?? null);
      setPreset('dont_clear');
      setPresetTouched(false);
      setError(null);
      setEmojiOpen(false);
      dirtyRef.current = false;
      return;
    }
    // 열린 상태에서 current 변경 — 아직 편집 전(pristine)일 때만 재반영.
    if (!dirtyRef.current) {
      setText(current?.text ?? '');
      setEmoji(current?.emoji ?? null);
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
      // 072-N2(리뷰 MEDIUM): 사용자가 만료 옵션을 건드리지 않았고 기존 상태에 만료가
      // 설정돼 있으면, 그 expiresAt 을 보존한다(텍스트/이모지만 수정 시 만료가 'dont_clear'
      // 로 초기화되는 회귀 방지). 건드렸으면 선택 프리셋을 보낸다.
      const expiryPart =
        !presetTouched && current?.expiresAt
          ? { expiresAt: current.expiresAt }
          : { preset };
      await setStatus.mutateAsync({
        text: trimmed || null,
        emoji: emoji || null,
        ...expiryPart,
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
      <div
        data-testid="custom-status-modal"
        className="flex flex-col gap-[var(--s-3)]"
        onKeyDown={(e) => {
          // 072-N2(리뷰 HIGH): 이모지 피커가 열린 상태의 Esc 는 피커만 닫고 Dialog 가
          // 닫히지 않게 막는다(종전엔 Esc 가 Dialog 까지 전파돼 편집 내용 폐기). 피커가
          // 닫혀 있으면 전파를 허용해 Dialog 가 Esc 로 닫힌다(접근성 탈출 경로 보존).
          if (e.key === 'Escape' && emojiOpen) {
            e.stopPropagation();
            setEmojiOpen(false);
            emojiBtnRef.current?.focus();
          }
        }}
      >
        <div className="relative flex items-center gap-[var(--s-2)]">
          <button
            ref={emojiBtnRef}
            type="button"
            data-testid="custom-status-emoji-btn"
            aria-label="상태 이모지 선택"
            aria-haspopup="dialog"
            aria-expanded={emojiOpen}
            aria-controls={emojiOpen ? 'custom-status-emoji-picker' : undefined}
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
            onChange={(e) => {
              setText(e.target.value);
              dirtyRef.current = true;
            }}
            className="qf-input flex-1"
          />
          {emoji ? (
            <button
              type="button"
              aria-label="이모지 제거"
              data-testid="custom-status-emoji-clear"
              onClick={() => {
                setEmoji(null);
                dirtyRef.current = true;
              }}
              className="qf-row-iconbtn shrink-0"
            >
              <Icon name="x" size="sm" />
            </button>
          ) : null}
          {emojiOpen ? (
            <EmojiPicker
              id="custom-status-emoji-picker"
              className="absolute left-0 top-[calc(100%+var(--s-1))] z-overlay"
              onSelect={(e) => {
                // 072-N2(리뷰 LOW): 커스텀 이모지 토큰(':slug:')은 거르고 유니코드만
                // 받는다(커스텀 팩 미전달이라 정상 경로엔 없으나 방어적).
                if (!e.startsWith(':')) {
                  setEmoji(e);
                  dirtyRef.current = true;
                }
                setEmojiOpen(false);
                emojiBtnRef.current?.focus();
              }}
              onDismiss={() => {
                // 072-N2(리뷰 MEDIUM): 피커 닫힐 때 트리거 버튼으로 포커스 복귀.
                setEmojiOpen(false);
                emojiBtnRef.current?.focus();
              }}
            />
          ) : null}
        </div>

        <label className="flex items-center justify-between gap-[var(--s-2)] text-[length:var(--fs-13)]">
          <span className="text-text-secondary">자동 삭제</span>
          <select
            data-testid="custom-status-expiry"
            aria-label="상태 자동 삭제 시점"
            value={preset}
            onChange={(e) => {
              setPreset(e.target.value as StatusPreset);
              setPresetTouched(true);
              dirtyRef.current = true;
            }}
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
