import { Icon } from '../../../design-system/primitives';
import { cn } from '../../../lib/cn';
import type { EphemeralMessage as EphemeralMessageData } from './useEphemeralMessages';

/**
 * S80 (D15 / FR-SC-05) — EPHEMERAL 슬래시 응답(발신자 전용 인라인 시스템 메시지).
 *
 * MessageItem 의 행 레이아웃을 따르되, 재전송/공유/편집/삭제 같은 메시지 액션은 두지
 * 않는다(개인 전용·비영속·"나만 보임"). 구분 배경 + 아이콘으로 일반 메시지와 시각적으로
 * 구분하고, 닫기(X) 버튼만 제공한다. 에러(파싱 실패 등)는 danger 톤 + alert 아이콘으로
 * 강조한다.
 *
 * a11y: role=status + aria-live=polite 로 스크린리더가 새 ephemeral 응답을 읽도록 한다
 * (S78 공유 announcer 와 일관 — 행동 유도형이 아닌 확인/안내라 polite). 닫기 버튼은
 * aria-label 로 의미를 노출한다.
 */
export function EphemeralMessage({
  msg,
  onDismiss,
}: {
  msg: EphemeralMessageData;
  onDismiss: () => void;
}): JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={`ephemeral-${msg.id}`}
      data-error={msg.error ? 'true' : undefined}
      className={cn(
        // 구분 배경(bg-bg-subtle 유효 토큰) + 라운드 + 좌측 강조. raw hex/px 금지.
        'qf-ephemeral group flex items-start gap-2 rounded-md bg-bg-subtle px-3 py-2',
        'border border-border-subtle text-sm',
      )}
    >
      <Icon
        name={msg.error ? 'alert' : 'info'}
        className={cn('mt-0.5 shrink-0', msg.error ? 'text-[color:var(--danger-400)]' : 'text-text-muted')}
      />
      <div className="min-w-0 flex-1">
        <span className="mr-2 text-xs font-medium text-text-muted">나만 보임</span>
        <span className={cn('break-words', msg.error ? 'text-[color:var(--danger-400)]' : 'text-text-secondary')}>
          {msg.content}
        </span>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="알림 닫기"
        data-testid={`ephemeral-dismiss-${msg.id}`}
        className="qf-btn qf-btn--ghost qf-btn--sm shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
      >
        <Icon name="x" />
      </button>
    </div>
  );
}
