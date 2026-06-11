import { useEffect, useRef, useState } from 'react';
import { Icon } from '../../design-system/primitives';
import { cn } from '../../lib/cn';
import { useSheetFocusTrap } from './useSheetFocusTrap';
import { useSheetHistoryMarker } from './useSheetHistoryMarker';
import { useSheetDragDismiss } from './useSheetDragDismiss';

/**
 * 071-M3 F2 (감사 A-48/B-81/B-82) — 서버 메뉴 바텀시트.
 *
 * 좌패널 server-header 탭으로 연다(DS mobile.css 주석 "탭하면 서버 메뉴 시트").
 * 데스크톱은 ChannelColumn 드롭다운/설정 오버레이로 분산된 진입점들을 모바일
 * 단일 시트로 모은다. 항목별 게이트는 호출측(MobileShell)이 콜백 미전달로
 * 표현한다(미전달 = 숨김 — MobileMessageSheet 와 동일 규약).
 *
 * 포커스 트랩은 MobileMessageSheet 의 마운트 1회 + onCloseRef 패턴(M1 리뷰
 * M-1), 하드웨어 back 은 공용 useSheetHistoryMarker(F1)를 쓴다.
 * '워크스페이스 나가기'는 파괴적 — M1 삭제와 동일한 제자리 2-step(3초 armed).
 */
export function MobileServerMenuSheet({
  workspaceName,
  onClose,
  onDirectory,
  onBrowse,
  onCreateChannel,
  onCreateCategory,
  onInvite,
  onManageInvites,
  onSettings,
  onLeave,
}: {
  workspaceName: string;
  onClose: () => void;
  /** 멤버 디렉터리(전 멤버). */
  onDirectory: () => void;
  /** 채널 둘러보기(전 멤버). */
  onBrowse: () => void;
  /** 채널 만들기 — canManageWorkspace 만 전달. */
  onCreateChannel?: () => void;
  /** 카테고리 추가 — canManageWorkspace 만 전달. */
  onCreateCategory?: () => void;
  /** 멤버 초대 — canModerate(MODERATOR+) 만 전달. */
  onInvite?: () => void;
  /** 초대 관리 — canModerate 만 전달. */
  onManageInvites?: () => void;
  /** 워크스페이스 설정 — canManageWorkspace 만 전달. */
  onSettings?: () => void;
  /** 워크스페이스 나가기 — OWNER 는 미전달(서버도 거부). */
  onLeave?: () => void;
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  useSheetHistoryMarker(true, onClose);
  // 071-M5 H3: 트랩 블록을 공용 useSheetFocusTrap 으로 치환(동작 무변경).
  useSheetFocusTrap(panelRef, onClose);
  // 071-M5 H8 (정찰 ②): grab 드래그 닫기 — 임계 통과 시 기존 onClose 경로만 재사용.
  const grabRef = useSheetDragDismiss(panelRef, onClose);

  const [leaveArmed, setLeaveArmed] = useState(false);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
    };
  }, []);

  const item = (
    testId: string,
    icon: Parameters<typeof Icon>[0]['name'],
    label: string,
    onClick: () => void,
    danger = false,
  ): JSX.Element => (
    <button
      type="button"
      data-testid={testId}
      className={cn('qf-m-sheet__item', danger && 'qf-m-sheet__item--danger')}
      onClick={onClick}
    >
      <span className="qf-m-sheet__icon">
        <Icon name={icon} size="sm" />
      </span>
      <span>{label}</span>
    </button>
  );

  return (
    <div
      data-testid="mobile-server-menu-sheet"
      className="fixed inset-0 z-[var(--z-modal,60)]"
      role="dialog"
      aria-modal="true"
      aria-label={`${workspaceName} 메뉴`}
    >
      {/* 071-M5 H7 (정찰 ①): 등장 모션 — 백드롭 fade + 시트 slide-up(enter-only). */}
      <div className="qf-m-sheet-backdrop qfa-backdrop-in absolute inset-0" onClick={onClose} />
      <div
        ref={panelRef}
        className="qf-m-sheet qfa-sheet-in qf-m-safe-bottom absolute bottom-0 left-0 right-0 z-[var(--z-modal)]"
      >
        <div ref={grabRef} className="qf-m-sheet__grab" aria-hidden />
        <div className="qf-m-section">
          <div>{workspaceName}</div>
        </div>
        {item('mobile-server-menu-directory', 'users', '멤버 디렉터리', onDirectory)}
        {item('mobile-server-menu-browse', 'compass', '채널 둘러보기', onBrowse)}
        {onInvite ? item('mobile-server-menu-invite', 'user-plus', '멤버 초대', onInvite) : null}
        {onManageInvites
          ? item('mobile-server-menu-invites', 'link', '초대 관리', onManageInvites)
          : null}
        {onCreateChannel
          ? item('mobile-server-menu-create-channel', 'plus-circle', '채널 만들기', onCreateChannel)
          : null}
        {onCreateCategory
          ? item('mobile-server-menu-create-category', 'folder', '카테고리 추가', onCreateCategory)
          : null}
        {onSettings
          ? item('mobile-server-menu-settings', 'settings', '워크스페이스 설정', onSettings)
          : null}
        {onLeave ? (
          <button
            type="button"
            data-testid="mobile-server-menu-leave"
            data-armed={leaveArmed ? 'true' : undefined}
            className={cn(
              'qf-m-sheet__item qf-m-sheet__item--danger',
              leaveArmed && 'bg-[color:var(--bg-selected)] font-semibold',
            )}
            onClick={() => {
              if (!leaveArmed) {
                setLeaveArmed(true);
                if (armTimerRef.current) clearTimeout(armTimerRef.current);
                armTimerRef.current = setTimeout(() => setLeaveArmed(false), 3000);
                return;
              }
              if (armTimerRef.current) clearTimeout(armTimerRef.current);
              onLeave();
            }}
          >
            <span className="qf-m-sheet__icon">
              <Icon name="logout" size="sm" />
            </span>
            <span>{leaveArmed ? '한 번 더 탭하면 나갑니다' : '워크스페이스 나가기'}</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
