import { useEffect, useRef, useState } from 'react';
import type { MessageDto } from '@qufox/shared-types';
import { Icon } from '../../design-system/primitives';
import { cn } from '../../lib/cn';
import { useSheetFocusTrap } from './useSheetFocusTrap';
import { useSheetHistoryMarker } from './useSheetHistoryMarker';
import { useSheetDragDismiss } from './useSheetDragDismiss';
// 071-M5 H12 (정찰 ⑤clock24h): 시각 헤더 12/24시간제 반영 — 데스크톱 MessageItem
// 과 동일한 스토어 구독 + 공유 포맷터 재사용.
import { useClock24h } from '../../stores/appearance-store';
import { formatClockPart } from '../../features/messages/formatMessageTime';

/**
 * Bottom sheet surfaced by long-press / swipe on a message row.
 * Uses DS qf-m-sheet / qf-m-sheet__item classes. Quick-reaction row
 * on top (5 presets + 더보기 → 이모지 드로어), then menu items.
 *
 * 071-M1 D9:
 *   - 액션 확장: 핀/고정 해제·저장 토글·리마인더·읽지 않음으로 표시·신고
 *     (각 옵셔널 — 호출측이 게이트를 통과한 경우에만 전달, 미전달 시 숨김).
 *   - 삭제 2-step confirm: 첫 탭은 무장(armed) 상태로 카피를 바꾸고, 3초 안의
 *     두 번째 탭만 실제 삭제한다(데스크톱 Delete 2-step 과 동일 의도 — 우발
 *     삭제 방지. 모달 confirm 대신 제자리 확인이라 흐름이 끊기지 않는다).
 *   - 포커스 트랩(WAI-ARIA dialog): 열릴 때 시트 첫 버튼으로 포커스 이동,
 *     Tab/Shift+Tab 은 시트 안에서 순환, 닫히면 열기 전 포커스로 복귀.
 */

const QUICK = ['👍', '❤️', '😂', '🎉', '🙏'] as const;

// A-08: 이모지 버튼은 글리프만 보여 스크린리더가 코드포인트를 읽어버린다.
// 각 프리셋에 한국어 의미 레이블을 부여해 "좋아요/하트/웃음/축하/감사 반응"으로
// 읽히게 한다(반응 추가 동작임을 명시).
const QUICK_LABEL: Record<(typeof QUICK)[number], string> = {
  '👍': '좋아요',
  '❤️': '하트',
  '😂': '웃음',
  '🎉': '축하',
  '🙏': '감사',
};

/** D9: 삭제 무장(armed) 유지 시간 — 지나면 1단계로 복귀(우발 삭제 방지). */
const DELETE_ARM_WINDOW_MS = 3000;

export function MobileMessageSheet({
  msg,
  isMine,
  onClose,
  onDelete,
  onCopy,
  onReact,
  onReply,
  onEdit,
  onOpenThread,
  onMoreReactions,
  onEditHistory,
  onPin,
  onUnpin,
  onToggleSave,
  isSaved,
  onSetReminder,
  onMarkUnread,
  onReport,
}: {
  msg: MessageDto;
  isMine: boolean;
  onClose: () => void;
  onDelete: () => void;
  onCopy: () => void;
  onReact: (emoji: string) => void;
  /** 071-M2 E6 (M1 리뷰 M-4): '답장' = 스레드 답글. DM/tmp 행은 미전달 → 숨김. */
  onReply?: () => void;
  // S103 (FR-MSG-06 모바일): '메시지 편집' — 편집 바텀시트를 연다. 미지정이면
  // (내 메시지 아님 · 낙관적 tmp- 행 · 삭제됨) 액션을 숨긴다(호출측이 게이트).
  onEdit?: () => void;
  // S35 (FR-TH-05): '스레드에서 답글' — 전체화면 스레드 패널을 연다. 미지정이면
  // (DM 등 스레드 비지원 컨텍스트) 액션을 숨긴다.
  onOpenThread?: () => void;
  /** D9: 퀵반응 5종 밖 — 이모지 드로어 열기(호출측이 시트 닫고 드로어 오픈). */
  onMoreReactions?: () => void;
  /** D9(FR-PS-05): 메시지 고정. 권한/상태 게이트는 호출측. */
  onPin?: () => void;
  onUnpin?: () => void;
  /** D9(FR-PS-07/13): 개인 저장 토글 — isSaved 가 현재 상태. */
  onToggleSave?: (currentlySaved: boolean) => void;
  isSaved?: boolean;
  /** D9(FR-KS-08 계열): 저장 + 리마인더 설정 모달 열기. */
  onSetReminder?: () => void;
  /** D9(FR-RS-08): 이 메시지 직전으로 읽음 커서 후진. */
  onMarkUnread?: () => void;
  /** D9(FR-RM11): 타인 메시지 신고(모달은 호출측). */
  onReport?: () => void;
  /** 071-M3 F6 (FR-MSG-08): 편집 이력 — edited 행에서만 호출측이 전달. */
  onEditHistory?: () => void;
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  // 071-M5 H12: 시각 헤더의 12/24시간제 설정 구독.
  const clock24h = useClock24h();
  // D9: 삭제 2-step — armed 면 카피가 확인 문구로 바뀌고, 창 안의 재탭만 삭제.
  const [deleteArmed, setDeleteArmed] = useState(false);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
    };
  }, []);

  // 071-M5 H3: 포커스 트랩(열림 첫 포커서블·Tab 순환·Esc·닫힘 복귀)을 공용 훅으로
  // 치환(동작 무변경 — D9 트랩 블록이 훅의 정본이다. M1 리뷰 M-1 마운트 1회 패턴 내장).
  useSheetFocusTrap(panelRef, onClose);
  // 071-M5 H4 (M3 F1 규약): 하드웨어 back 이 화면 이탈 대신 시트만 닫는다.
  useSheetHistoryMarker(true, onClose);
  // 071-M5 H8 (정찰 ②): grab 드래그 닫기 — 임계 통과 시 기존 onClose 경로만 재사용.
  const grabRef = useSheetDragDismiss(panelRef, onClose);

  const handleDeleteTap = (): void => {
    if (!deleteArmed) {
      setDeleteArmed(true);
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
      armTimerRef.current = setTimeout(() => setDeleteArmed(false), DELETE_ARM_WINDOW_MS);
      return;
    }
    if (armTimerRef.current) clearTimeout(armTimerRef.current);
    onDelete();
  };

  return (
    <div
      data-testid={`mobile-msg-sheet-${msg.id}`}
      className="fixed inset-0 z-[var(--z-modal,60)]"
      role="dialog"
      aria-modal="true"
      aria-label="메시지 동작"
    >
      {/* 071-M5 H7 (정찰 ①): 등장 모션 — 백드롭 fade + 시트 slide-up(enter-only). */}
      <div className="qf-m-sheet-backdrop qfa-backdrop-in absolute inset-0" onClick={onClose} />
      {/* H-1(071-M0 C2): 백드롭(z=--z-modal-bg=60)이 z-auto 시트를 덮어 항목 탭을
          가로채던 BLOCKER — 시트를 --z-modal(61)로 올린다. */}
      <div
        ref={panelRef}
        className="qf-m-sheet qfa-sheet-in qf-m-safe-bottom absolute bottom-0 left-0 right-0 z-[var(--z-modal)]"
      >
        <div ref={grabRef} className="qf-m-sheet__grab" aria-hidden />
        {/* 071-M4 (FR-MSG-10/12 모바일): 시트 헤더에 전송 시각 노출 — grouped 행
            (hover HH:MM 데스크톱 전용)에서도 시각 확인 경로를 제공한다. title 은
            ISO 전체 시각(FR-MSG-12 hover tooltip 동등). */}
        <div
          className="qf-m-section"
          data-testid="mobile-sheet-time"
          title={new Date(msg.createdAt).toISOString()}
        >
          {/* 071-M5 H12 (정찰 ⑤clock24h): 시각부를 공유 formatClockPart 로 교체해
              12/24시간제 설정을 반영한다(M4 헤더의 '날짜+시각' 구성은 유지). */}
          <div>
            {new Date(msg.createdAt).toLocaleString('ko-KR', { month: 'short', day: 'numeric' })}{' '}
            {formatClockPart(new Date(msg.createdAt), clock24h)}
          </div>
        </div>
        {/* Quick reaction row — 071-M0 C12(감사 B-45): 임의 버튼(37×33)이 44px 터치
            플로어를 위반했다. DS 정본 qf-m-react-row/chip(44×44)으로 교체. */}
        <div className="qf-m-react-row justify-around">
          {QUICK.map((e) => (
            <button
              key={e}
              type="button"
              data-testid={`mobile-quick-react-${e}`}
              onClick={() => onReact(e)}
              aria-label={`${QUICK_LABEL[e]} 반응`}
              className="qf-m-react-chip"
            >
              {e}
            </button>
          ))}
          {/* D9: 퀵 5종 밖 → 이모지 드로어. */}
          {onMoreReactions ? (
            <button
              type="button"
              data-testid="mobile-more-reactions"
              onClick={onMoreReactions}
              aria-label="더 많은 이모지로 반응"
              className="qf-m-react-chip"
            >
              <Icon name="plus-circle" size="sm" />
            </button>
          ) : null}
        </div>
        <div className="qf-m-sheet__divider" aria-hidden />
        {/* M6 리뷰 M-4: 넘침 스크롤은 메뉴 영역 내부로 한정 — grab/시각 헤더/
            퀵 반응 행은 고정 유지(드래그 닫기 표면 보존, M5 H11 불변식). */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* 071-M2 E6 (M1 리뷰 M-4): '답장' = 스레드 답글 단일 경로 — 종전의
            데드엔드 replyTarget 배너('답장')와 '스레드에서 답글' 중복을 통합. */}
          {onReply ? (
            <button
              type="button"
              data-testid="mobile-msg-reply"
              onClick={onReply}
              className="qf-m-sheet__item"
            >
              <span className="qf-m-sheet__icon">
                <Icon name="reply" size="sm" />
              </span>
              <span>답장</span>
            </button>
          ) : null}
          {onOpenThread ? (
            <button
              type="button"
              data-testid="mobile-msg-open-thread"
              onClick={onOpenThread}
              className="qf-m-sheet__item"
            >
              <span className="qf-m-sheet__icon">
                <Icon name="thread" size="sm" />
              </span>
              <span>스레드 보기</span>
            </button>
          ) : null}
          <button
            type="button"
            data-testid="mobile-msg-copy"
            onClick={onCopy}
            className="qf-m-sheet__item"
          >
            <span className="qf-m-sheet__icon">
              <Icon name="copy" size="sm" />
            </span>
            <span>메시지 복사</span>
          </button>
          {/* D9(FR-PS-07/13): 개인 저장 토글 — 저장됨이면 해제 카피. */}
          {onToggleSave ? (
            <button
              type="button"
              data-testid="mobile-msg-save"
              onClick={() => onToggleSave(isSaved === true)}
              className="qf-m-sheet__item"
            >
              <span className={cn('qf-m-sheet__icon', isSaved && 'text-[color:var(--accent)]')}>
                <Icon name="bookmark" size="sm" />
              </span>
              <span>{isSaved ? '저장 해제' : '나중에 보기 저장'}</span>
            </button>
          ) : null}
          {/* D9: 저장 후 리마인더 설정 모달(호출측 소유). */}
          {onSetReminder ? (
            <button
              type="button"
              data-testid="mobile-msg-reminder"
              onClick={onSetReminder}
              className="qf-m-sheet__item"
            >
              <span className="qf-m-sheet__icon">
                <Icon name="clock" size="sm" />
              </span>
              <span>리마인더 설정</span>
            </button>
          ) : null}
          {/* D9(FR-PS-05): 채널 핀 고정/해제 — 권한 게이트는 호출측. */}
          {onPin ? (
            <button
              type="button"
              data-testid="mobile-msg-pin"
              onClick={onPin}
              className="qf-m-sheet__item"
            >
              <span className="qf-m-sheet__icon">
                <Icon name="pin" size="sm" />
              </span>
              <span>메시지 고정</span>
            </button>
          ) : null}
          {onUnpin ? (
            <button
              type="button"
              data-testid="mobile-msg-unpin"
              onClick={onUnpin}
              className="qf-m-sheet__item"
            >
              <span className="qf-m-sheet__icon">
                <Icon name="pin" size="sm" />
              </span>
              <span>메시지 고정 해제</span>
            </button>
          ) : null}
          {/* 071-M3 F6 (FR-MSG-08): 편집 이력 — edited 행 한정. */}
          {onEditHistory ? (
            <button
              type="button"
              data-testid="mobile-msg-edit-history"
              onClick={onEditHistory}
              className="qf-m-sheet__item"
            >
              <span className="qf-m-sheet__icon">
                <Icon name="clock" size="sm" />
              </span>
              <span>편집 이력</span>
            </button>
          ) : null}
          {/* D9(FR-RS-08): 이 메시지부터 다시 읽기. */}
          {onMarkUnread ? (
            <button
              type="button"
              data-testid="mobile-msg-mark-unread"
              onClick={onMarkUnread}
              className="qf-m-sheet__item"
            >
              <span className="qf-m-sheet__icon">
                <Icon name="eye-off" size="sm" />
              </span>
              <span>읽지 않음으로 표시</span>
            </button>
          ) : null}
          {/* S103 (FR-MSG-06 모바일): 내 메시지 편집. 호출측이 isMine·!tmp-·!deleted
            게이트를 통과한 경우에만 onEdit 을 전달한다(미전달 시 숨김). */}
          {onEdit ? (
            <button
              type="button"
              data-testid="mobile-msg-edit"
              onClick={onEdit}
              className="qf-m-sheet__item"
            >
              <span className="qf-m-sheet__icon">
                <Icon name="edit" size="sm" />
              </span>
              <span>메시지 편집</span>
            </button>
          ) : null}
          {/* D9(FR-RM11): 타인 메시지 신고. */}
          {onReport ? (
            <button
              type="button"
              data-testid="mobile-msg-report"
              onClick={onReport}
              className="qf-m-sheet__item qf-m-sheet__item--danger"
            >
              <span className="qf-m-sheet__icon">
                <Icon name="alert" size="sm" />
              </span>
              <span>메시지 신고</span>
            </button>
          ) : null}
          {isMine ? (
            <button
              type="button"
              data-testid="mobile-msg-delete"
              data-armed={deleteArmed ? 'true' : undefined}
              onClick={handleDeleteTap}
              aria-live="polite"
              className={cn(
                'qf-m-sheet__item qf-m-sheet__item--danger',
                // armed 강조는 DS 토큰만 사용(bg-selected + 굵기) — raw rgba 금지.
                deleteArmed && 'bg-[color:var(--bg-selected)] font-semibold',
              )}
            >
              <span className="qf-m-sheet__icon">
                <Icon name="trash" size="sm" />
              </span>
              <span>{deleteArmed ? '한 번 더 탭하면 삭제됩니다' : '메시지 삭제'}</span>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
