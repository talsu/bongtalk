import type { NotifLevel } from '@qufox/shared-types';
import { NOTIF_LEVEL_OPTIONS } from './useNotifLevels';

/**
 * S46 (D06 / FR-MN-05/06/07/08): NotifLevel(ALL/MENTIONS/NOTHING) 라디오 그룹.
 *
 * 글로벌/서버/채널 알림 설정 화면이 공유한다. DS 토큰 + 기존 qf-* 클래스만 쓴다
 * (신규 DS 클래스 0). value=null(채널 상속) 은 호출부가 별도 옵션으로 처리한다 —
 * 본 컴포넌트는 3값만 받는다.
 */
export interface NotifLevelRadioProps {
  name: string;
  value: NotifLevel;
  onChange: (_next: NotifLevel) => void;
  disabled?: boolean;
}

export function NotifLevelRadio({
  name,
  value,
  onChange,
  disabled,
}: NotifLevelRadioProps): JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label="알림 수준"
      className="flex flex-col gap-[var(--s-2)]"
      data-testid={`notif-level-radio-${name}`}
    >
      {NOTIF_LEVEL_OPTIONS.map((opt) => (
        <label
          key={opt.value}
          className="flex cursor-pointer items-start gap-[var(--s-3)] rounded-[var(--r-md)] border border-border-subtle p-[var(--s-3)]"
          data-active={opt.value === value}
        >
          <input
            type="radio"
            name={name}
            value={opt.value}
            checked={opt.value === value}
            disabled={disabled}
            onChange={() => onChange(opt.value)}
            data-testid={`notif-level-${name}-${opt.value}`}
            className="mt-[var(--s-1)]"
          />
          <span className="flex flex-col">
            <span className="text-[length:var(--fs-14)] font-medium text-text">{opt.label}</span>
            <span className="text-[length:var(--fs-12)] text-text-muted">{opt.hint}</span>
          </span>
        </label>
      ))}
    </div>
  );
}
