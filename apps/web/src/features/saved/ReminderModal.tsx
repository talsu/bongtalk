import { useEffect, useState } from 'react';
import { Dialog, Button, Input } from '../../design-system/primitives';
import {
  REMINDER_PRESETS,
  browserTimezone,
  computeReminderAt,
  type ReminderPresetKey,
} from './reminderPresets';

// S53 (D10 / FR-PS-09): 리마인더 설정 모달. 프리셋(30분/1시간/내일 9시/다음 주 월
// 9시/직접 입력) 선택 후 "설정" 시 UTC ISO 를 부모에 넘긴다. 프리셋 시각은 사용자
// timezone(없으면 브라우저 tz) 기준으로 계산한다. 설정 클릭 시 최초 1회
// Notification.requestPermission() 을 호출한다(sensible default — 권한이 없어도
// 서버 토스트로 폴백).

type Props = {
  open: boolean;
  // 항목 컨텍스트(헤더 설명용).
  channelName: string;
  // 이미 설정된 리마인더가 있으면 "해제" 버튼 노출(reminderAt non-null).
  hasReminder: boolean;
  onClose: () => void;
  // 설정: reminderAt(UTC ISO). 해제: null.
  onSubmit: (reminderAt: string | null) => void;
};

export function ReminderModal({
  open,
  channelName,
  hasReminder,
  onClose,
  onSubmit,
}: Props): JSX.Element | null {
  const [selected, setSelected] = useState<ReminderPresetKey>('in30m');
  // 직접 입력(datetime-local) 값.
  const [customLocal, setCustomLocal] = useState('');

  useEffect(() => {
    if (open) {
      setSelected('in30m');
      setCustomLocal('');
    }
  }, [open]);

  if (!open) return null;

  // 프리셋 계산 기준 timezone. User.timezone 은 현재 /me/profile DTO 에 노출되지
  // 않으므로 브라우저 tz 를 쓴다(S28 서버 timezone 노출은 후속 작업 — TODO).
  const tz = browserTimezone();

  const requestNotifPermission = (): void => {
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        void Notification.requestPermission();
      }
    } catch {
      // 권한 요청 실패는 무해(서버 토스트 폴백).
    }
  };

  const canSubmit =
    selected !== 'custom' || (customLocal.length > 0 && !Number.isNaN(Date.parse(customLocal)));

  const submit = (): void => {
    if (!canSubmit) return;
    requestNotifPermission();
    let reminderAt: string | null;
    if (selected === 'custom') {
      // datetime-local 값은 사용자 로컬 벽시계 → Date 가 로컬 tz 로 해석해 UTC ISO 생성.
      const parsed = new Date(customLocal);
      if (Number.isNaN(parsed.getTime())) return;
      reminderAt = parsed.toISOString();
    } else {
      reminderAt = computeReminderAt(selected, new Date(), tz);
    }
    onSubmit(reminderAt);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onClose();
      }}
      title="리마인더 설정"
      description={`#${channelName} 의 저장 항목을 나중에 다시 알려드립니다.`}
    >
      <div data-testid="reminder-modal" className="qf-field">
        <span className="qf-field__label">언제 알릴까요?</span>
        <div
          className="flex flex-col gap-[var(--s-2)]"
          role="radiogroup"
          aria-label="리마인더 시각"
        >
          {REMINDER_PRESETS.map((p) => (
            <label
              key={p.key}
              className="flex items-center gap-[var(--s-2)] text-text-secondary"
              style={{ font: '400 var(--fs-14) var(--font-sans)' }}
            >
              <input
                type="radio"
                name="reminder-preset"
                data-testid={`reminder-preset-${p.key}`}
                checked={selected === p.key}
                onChange={() => setSelected(p.key)}
              />
              {p.label}
            </label>
          ))}
          <label
            className="flex items-center gap-[var(--s-2)] text-text-secondary"
            style={{ font: '400 var(--fs-14) var(--font-sans)' }}
          >
            <input
              type="radio"
              name="reminder-preset"
              data-testid="reminder-preset-custom"
              checked={selected === 'custom'}
              onChange={() => setSelected('custom')}
            />
            직접 입력
          </label>
          {selected === 'custom' ? (
            <Input
              type="datetime-local"
              data-testid="reminder-custom-input"
              aria-label="직접 입력 시각"
              value={customLocal}
              onChange={(e) => setCustomLocal(e.target.value)}
            />
          ) : null}
        </div>
      </div>

      <div className="qf-modal__footer">
        {hasReminder ? (
          <Button
            type="button"
            variant="ghost"
            data-testid="reminder-clear"
            onClick={() => {
              onSubmit(null);
              onClose();
            }}
          >
            리마인더 해제
          </Button>
        ) : null}
        <Button type="button" variant="ghost" onClick={onClose}>
          취소
        </Button>
        <Button
          type="button"
          data-testid="reminder-submit"
          variant="primary"
          disabled={!canSubmit}
          onClick={submit}
        >
          설정
        </Button>
      </div>
    </Dialog>
  );
}
