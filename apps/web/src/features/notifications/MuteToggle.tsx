import type { MuteDurationKey } from '@qufox/shared-types';
import { MUTE_DURATION_OPTIONS } from './useNotifLevels';

/**
 * S46 (D06 / FR-MN-06/07/08): 뮤트 토글 + 기간 선택.
 *
 * 레이블/부제는 PRD 정본 카피("채널 뮤트" — "배지와 미읽 표시가 모두 숨겨집니다.
 * 직접 멘션은 Inbox에서 확인하세요."). scope='server' 면 "서버 뮤트" 로 바꾼다.
 * DS 토큰 + 기존 qf-* 만(신규 DS 클래스 0).
 */
export interface MuteToggleProps {
  scope: 'server' | 'channel';
  isMuted: boolean;
  muteUntil: string | null;
  duration: MuteDurationKey;
  onToggle: (_next: boolean) => void;
  onDurationChange: (_next: MuteDurationKey) => void;
  disabled?: boolean;
}

export function MuteToggle({
  scope,
  isMuted,
  muteUntil,
  duration,
  onToggle,
  onDurationChange,
  disabled,
}: MuteToggleProps): JSX.Element {
  const title = scope === 'channel' ? '채널 뮤트' : '서버 뮤트';
  const subtitle = '배지와 미읽 표시가 모두 숨겨집니다. 직접 멘션은 Inbox에서 확인하세요.';
  return (
    <div className="flex flex-col gap-[var(--s-2)]" data-testid={`mute-toggle-${scope}`}>
      <label className="flex items-start gap-[var(--s-3)]">
        <input
          type="checkbox"
          checked={isMuted}
          disabled={disabled}
          onChange={(e) => onToggle(e.target.checked)}
          data-testid={`mute-toggle-${scope}-checkbox`}
          className="mt-[var(--s-1)]"
        />
        <span className="flex flex-col">
          <span className="text-[length:var(--fs-14)] font-medium text-text">{title}</span>
          <span className="text-[length:var(--fs-12)] text-text-muted">{subtitle}</span>
          {isMuted && muteUntil && (
            <span className="text-[length:var(--fs-12)] text-text-muted">
              {new Date(muteUntil).toLocaleString()} 까지
            </span>
          )}
          {isMuted && !muteUntil && (
            <span className="text-[length:var(--fs-12)] text-text-muted">영구 뮤트</span>
          )}
        </span>
      </label>
      {isMuted && (
        <select
          aria-label="뮤트 기간"
          value={duration}
          disabled={disabled}
          data-testid={`mute-duration-${scope}`}
          className="qf-input w-fit"
          onChange={(e) => onDurationChange(e.target.value as MuteDurationKey)}
        >
          {MUTE_DURATION_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
