import { useEffect } from 'react';
import type { MessageDto } from '@qufox/shared-types';
import { Icon } from '../../design-system/primitives';

/**
 * Bottom sheet surfaced by long-press / swipe on a message row.
 * Uses DS qf-m-sheet / qf-m-sheet__item classes. Quick-reaction row
 * on top (5 presets), then menu items (Copy, Delete if mine).
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
}: {
  msg: MessageDto;
  isMine: boolean;
  onClose: () => void;
  onDelete: () => void;
  onCopy: () => void;
  onReact: (emoji: string) => void;
  onReply: () => void;
  // S103 (FR-MSG-06 모바일): '메시지 편집' — 편집 바텀시트를 연다. 미지정이면
  // (내 메시지 아님 · 낙관적 tmp- 행 · 삭제됨) 액션을 숨긴다(호출측이 게이트).
  onEdit?: () => void;
  // S35 (FR-TH-05): '스레드에서 답글' — 전체화면 스레드 패널을 연다. 미지정이면
  // (DM 등 스레드 비지원 컨텍스트) 액션을 숨긴다.
  onOpenThread?: () => void;
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      data-testid={`mobile-msg-sheet-${msg.id}`}
      className="fixed inset-0 z-[var(--z-modal,60)]"
      role="dialog"
      aria-modal="true"
    >
      <div className="qf-m-sheet-backdrop absolute inset-0" onClick={onClose} />
      <div className="qf-m-sheet qf-m-safe-bottom absolute bottom-0 left-0 right-0">
        <div className="qf-m-sheet__grab" aria-hidden />
        {/* Quick reaction row */}
        <div className="flex items-center justify-around py-[var(--s-3)]">
          {QUICK.map((e) => (
            <button
              key={e}
              type="button"
              data-testid={`mobile-quick-react-${e}`}
              onClick={() => onReact(e)}
              aria-label={`${QUICK_LABEL[e]} 반응`}
              className="text-[length:var(--fs-18)] px-[var(--s-3)] py-[var(--s-2)] rounded-[var(--r-md)] active:bg-bg-muted"
            >
              {e}
            </button>
          ))}
        </div>
        <div className="qf-m-sheet__divider" aria-hidden />
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
        {/* S35 (FR-TH-05): 스레드에서 답글 — 전체화면 스레드 패널 진입. 루트가
            아닌 답글에서도 동일 루트로 진입하도록 호출측이 parentMessageId 를
            해석한다(여기선 액션만 노출). */}
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
            <span>스레드에서 답글</span>
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
        {isMine ? (
          <button
            type="button"
            data-testid="mobile-msg-delete"
            onClick={onDelete}
            className="qf-m-sheet__item qf-m-sheet__item--danger"
          >
            <span className="qf-m-sheet__icon">
              <Icon name="trash" size="sm" />
            </span>
            <span>메시지 삭제</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
