import { useRef } from 'react';
import { Icon } from '../../design-system/primitives';
import { type MuteDurationKey } from '../../features/channels/useMutes';
import { MUTE_DURATIONS } from '../../features/channels/ChannelList';
import { useSheetFocusTrap } from './useSheetFocusTrap';
import { useSheetHistoryMarker } from './useSheetHistoryMarker';
import { useSheetDragDismiss } from './useSheetDragDismiss';

/**
 * 071-M3 F5 (FR-CH-17 모바일 / 감사 B-12·B-26) — 채널 롱프레스 시트.
 *
 * 좌패널 채널 행 롱프레스로 연다. 데스크톱 ChannelList 컨텍스트 메뉴의 뮤트
 * 항목 구성을 시트로 이식: 비뮤트 시 duration 6종(15분~무기한), 뮤트 시 해제.
 * 071-M4 (FR-RS-09): '읽음으로 표시' 추가 — 데스크톱 우클릭 메뉴와 동등 경로.
 * 채널 push 알림 설정(레벨 라디오)은 전 플랫폼 신규 표면이라 보류(M4+).
 */
export function MobileChannelSheet({
  channelName,
  muted,
  hasUnread,
  onClose,
  onMute,
  onUnmute,
  onMarkRead,
}: {
  channelName: string;
  muted: boolean;
  /** FR-RS-09: 읽지 않음이 있을 때만 '읽음으로 표시' 노출(0건 no-op 숨김). */
  hasUnread: boolean;
  onClose: () => void;
  onMute: (duration: MuteDurationKey) => void;
  onUnmute: () => void;
  onMarkRead: () => void;
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  useSheetHistoryMarker(true, onClose);
  // 071-M5 H3: 트랩 블록을 공용 useSheetFocusTrap 으로 치환(동작 무변경).
  useSheetFocusTrap(panelRef, onClose);
  // 071-M5 H8 (정찰 ②): grab 드래그 닫기 — 임계 통과 시 기존 onClose 경로만 재사용.
  const grabRef = useSheetDragDismiss(panelRef, onClose);

  return (
    <div
      data-testid={`mobile-channel-sheet-${channelName}`}
      className="fixed inset-0 z-[var(--z-modal,60)]"
      role="dialog"
      aria-modal="true"
      aria-label={`#${channelName} 채널 옵션`}
    >
      {/* 071-M5 H7 (정찰 ①): 등장 모션 — 백드롭 fade + 시트 slide-up(enter-only). */}
      <div className="qf-m-sheet-backdrop qfa-backdrop-in absolute inset-0" onClick={onClose} />
      <div
        ref={panelRef}
        className="qf-m-sheet qfa-sheet-in qf-m-safe-bottom absolute bottom-0 left-0 right-0 z-[var(--z-modal)]"
      >
        <div ref={grabRef} className="qf-m-sheet__grab" aria-hidden />
        <div className="qf-m-section">
          <div># {channelName}</div>
        </div>
        {hasUnread ? (
          <button
            type="button"
            data-testid="mobile-channel-mark-read"
            className="qf-m-sheet__item"
            onClick={onMarkRead}
          >
            <span className="qf-m-sheet__icon">
              <Icon name="check" size="sm" />
            </span>
            <span>읽음으로 표시</span>
          </button>
        ) : null}
        {muted ? (
          <button
            type="button"
            data-testid="mobile-channel-unmute"
            className="qf-m-sheet__item"
            onClick={onUnmute}
          >
            <span className="qf-m-sheet__icon">
              <Icon name="bell" size="sm" />
            </span>
            <span>뮤트 해제</span>
          </button>
        ) : (
          MUTE_DURATIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              data-testid={`mobile-channel-mute-${opt.key}`}
              className="qf-m-sheet__item"
              aria-label={opt.ariaLabel}
              onClick={() => onMute(opt.key)}
            >
              <span className="qf-m-sheet__icon">
                <Icon name="bell-off" size="sm" />
              </span>
              <span>뮤트 — {opt.label}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
