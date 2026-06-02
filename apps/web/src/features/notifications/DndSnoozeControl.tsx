import { useId, useState } from 'react';
import { SNOOZE_PRESET_OPTIONS, snoozeUntil, type DndSnoozePreset } from './dndSnooze';

/**
 * S48 (D06 / FR-MN-11): DND Snooze(임시 방해 금지) 컨트롤.
 *
 * 30분/1시간/2시간/내일 오전/Custom 중 선택 → onSnooze(ISO) 로 위임(상위가
 * PATCH /me/settings/notifications { dndUntil } 호출). 현재 snooze 상태(dndUntil)
 * 표시 + 해제(onClear → dndUntil null). Custom 은 datetime-local 입력으로 받는다.
 *
 * push 스킵은 VAPID defer 라 미구현 — 본 컨트롤은 WS fanout 멘션 억제(서버 게이트)에
 * 대응한다. DS 토큰 + 기존 qf-* 만(raw hex/px 0).
 *
 * S48 fix-forward(a11y):
 *   - A-01: 프리셋을 radiogroup 으로 노출(role=radio + aria-checked). 현재 active
 *     snooze 의 preset 을 dndUntil ↔ snoozeUntil(preset) 일치로 추론해 표시한다.
 *   - A-02: snooze 상태를 **항상 DOM 에 존재하는** 고정 aria-live 컨테이너로 통지
 *     (내부 텍스트만 조건부 — SR 가 전이를 항상 듣도록).
 *   - A-03: 해제 버튼 aria-label. A-04: 직접설정 버튼 aria-expanded/aria-controls.
 *   - A-05: custom datetime 클라 검증(60초 미만/Invalid → 한국어 에러 + aria-invalid
 *     + role=alert), min/max attr(now+60s ~ now+7일). 서버 영어 메시지 노출 방지.
 */
export interface DndSnoozeControlProps {
  dndUntil: string | null;
  onSnooze: (_iso: string) => void;
  onClear: () => void;
  disabled?: boolean;
}

/** datetime-local input 의 value 형식("YYYY-MM-DDTHH:mm")으로 로컬 시각을 포맷. */
function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

const SNOOZE_MAX_MS = 7 * 24 * 60 * 60_000;
const SNOOZE_MIN_MS = 60_000;

export function DndSnoozeControl({
  dndUntil,
  onSnooze,
  onClear,
  disabled,
}: DndSnoozeControlProps): JSX.Element {
  const [customOpen, setCustomOpen] = useState(false);
  const [customValue, setCustomValue] = useState('');
  const [customError, setCustomError] = useState<string | null>(null);
  const customPanelId = useId();
  const customErrorId = useId();

  // 만료 여부(query-time): dndUntil 이 과거면 활성 snooze 가 아니다.
  const active = dndUntil !== null && new Date(dndUntil).getTime() > Date.now();

  // A-01: 현재 active snooze 가 어떤 프리셋과 일치하는지 추론(aria-checked 용).
  // dndUntil 이 특정 preset 의 산정값과 정확히 일치할 때만 그 preset 을 selected 로 본다.
  const selectedPreset: DndSnoozePreset | null = (() => {
    if (!active || dndUntil === null) return null;
    const target = new Date(dndUntil).getTime();
    for (const o of SNOOZE_PRESET_OPTIONS) {
      if (snoozeUntil(o.value).getTime() === target) return o.value;
    }
    return null;
  })();

  const applyPreset = (preset: DndSnoozePreset): void => {
    onSnooze(snoozeUntil(preset).toISOString());
  };

  const applyCustom = (): void => {
    if (customValue.length === 0) {
      setCustomError('종료 시각을 입력해 주세요.');
      return;
    }
    const d = new Date(customValue);
    if (Number.isNaN(d.getTime())) {
      setCustomError('올바른 날짜·시각을 입력해 주세요.');
      return;
    }
    const delta = d.getTime() - Date.now();
    if (delta < SNOOZE_MIN_MS) {
      setCustomError('지금으로부터 최소 1분 이후 시각을 선택해 주세요.');
      return;
    }
    if (delta > SNOOZE_MAX_MS) {
      setCustomError('최대 7일 이내의 시각을 선택해 주세요.');
      return;
    }
    setCustomError(null);
    onSnooze(d.toISOString());
    setCustomOpen(false);
    setCustomValue('');
  };

  const now = Date.now();
  const minValue = toDatetimeLocalValue(new Date(now + SNOOZE_MIN_MS));
  const maxValue = toDatetimeLocalValue(new Date(now + SNOOZE_MAX_MS));

  return (
    <div className="flex flex-col gap-[var(--s-3)]" data-testid="dnd-snooze">
      {/* A-02: 항상 DOM 에 존재하는 고정 aria-live 컨테이너 — 내부 텍스트만 조건부. */}
      <div aria-live="polite" aria-atomic="true">
        {active ? (
          <div
            className="flex items-center justify-between gap-[var(--s-3)] rounded-[var(--r-md)] bg-bg-subtle px-[var(--s-4)] py-[var(--s-3)]"
            data-testid="dnd-snooze-active"
          >
            <span className="text-[length:var(--fs-14)] text-foreground">
              {new Date(dndUntil as string).toLocaleString()} 까지 방해 금지
            </span>
            <button
              type="button"
              disabled={disabled}
              onClick={onClear}
              data-testid="dnd-snooze-clear"
              aria-label="방해 금지 해제"
              className="qf-btn qf-btn--secondary qf-btn--sm"
            >
              해제
            </button>
          </div>
        ) : (
          <p className="text-[length:var(--fs-12)] text-text-muted" data-testid="dnd-snooze-idle">
            현재 임시 방해 금지가 꺼져 있습니다.
          </p>
        )}
      </div>

      {/* A-01: 프리셋 radiogroup. */}
      <div
        role="radiogroup"
        aria-label="방해 금지 기간"
        className="flex flex-wrap gap-[var(--s-2)]"
      >
        {SNOOZE_PRESET_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selectedPreset === o.value}
            disabled={disabled}
            onClick={() => applyPreset(o.value)}
            data-testid={`dnd-snooze-preset-${o.value}`}
            className="qf-btn qf-btn--secondary qf-btn--sm"
          >
            {o.label}
          </button>
        ))}
        <button
          type="button"
          disabled={disabled}
          onClick={() => setCustomOpen((v) => !v)}
          aria-expanded={customOpen}
          aria-controls={customPanelId}
          data-testid="dnd-snooze-custom-toggle"
          className="qf-btn qf-btn--ghost qf-btn--sm"
        >
          직접 설정
        </button>
      </div>

      {customOpen && (
        <div
          id={customPanelId}
          className="flex flex-col gap-[var(--s-2)]"
          data-testid="dnd-snooze-custom"
        >
          <div className="flex items-center gap-[var(--s-2)]">
            <input
              type="datetime-local"
              value={customValue}
              disabled={disabled}
              min={minValue}
              max={maxValue}
              aria-label="방해 금지 종료 시각"
              aria-invalid={customError !== null}
              aria-describedby={customError !== null ? customErrorId : undefined}
              data-testid="dnd-snooze-custom-input"
              className="qf-input"
              onChange={(e) => {
                setCustomValue(e.target.value);
                if (customError !== null) setCustomError(null);
              }}
            />
            <button
              type="button"
              disabled={disabled}
              onClick={applyCustom}
              data-testid="dnd-snooze-custom-apply"
              className="qf-btn qf-btn--primary qf-btn--sm"
            >
              적용
            </button>
          </div>
          {customError !== null && (
            <p
              id={customErrorId}
              role="alert"
              className="text-[length:var(--fs-12)] text-danger"
              data-testid="dnd-snooze-custom-error"
            >
              {customError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
