import { useId, useState } from 'react';
import * as RDialog from '@radix-ui/react-dialog';
import { Button, Input } from '../../design-system/primitives';
import { cn } from '../../lib/cn';

/**
 * S14 (FR-CH-05): 비공개→공개 전환 2단계 confirm 모달.
 *
 * 파괴적·되돌릴 수 없는 변경(이전 공유 파일이 전 멤버에게 공개)이므로
 * 서버 confirmName 토큰 검증과 짝을 이루는 클라이언트 게이트다:
 *   ① 경고 카피 노출.
 *   ② 채널 이름 재입력 — 정확히 일치할 때만 "공개로 전환" 버튼 활성화.
 *   ③ role="alertdialog" + aria-modal + aria-labelledby/aria-describedby
 *      로 스크린리더에 파괴적 확인 다이얼로그임을 알린다.
 *   ④ 모바일은 qf-m-modal--fullscreen 로 전체화면 전환.
 *
 * DS 4파일은 수정하지 않고 qf-* 와 토큰 클래스만 사용한다. role="alertdialog"
 * 는 공유 Dialog 프리미티브가 노출하지 않아(항상 dialog) 여기서 Radix
 * Content 에 직접 지정한다.
 */
export function ChannelPrivacyConfirmModal({
  open,
  channelName,
  submitting,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  channelName: string;
  submitting: boolean;
  /** 일치 확인된 채널 이름을 confirmName 으로 넘긴다(서버 토큰). */
  onConfirm: (confirmName: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const titleId = useId();
  const descId = useId();
  const [typed, setTyped] = useState('');
  const matches = typed === channelName;
  const canConfirm = matches && !submitting;

  return (
    <RDialog.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setTyped('');
          onCancel();
        }
      }}
    >
      <RDialog.Portal>
        <RDialog.Overlay className="qf-modal-backdrop !fixed !inset-0" />
        <RDialog.Content
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descId}
          data-testid="channel-privacy-confirm"
          className={cn(
            'qf-modal qf-m-modal--fullscreen fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2',
          )}
          onEscapeKeyDown={() => {
            setTyped('');
            onCancel();
          }}
        >
          <div className="qf-modal__header">
            <RDialog.Title id={titleId} className="qf-modal__title">
              공개 채널로 전환할까요?
            </RDialog.Title>
          </div>
          <div className="qf-modal__body pb-[var(--s-6)]">
            <p
              id={descId}
              className="mt-[var(--s-2)] text-[length:var(--fs-13)] text-text-secondary"
            >
              공개로 전환하면 이전 공유 파일이 전 멤버에게 공개됩니다. 되돌릴 수 없습니다.
            </p>
            <div className="qf-field mt-[var(--s-5)]">
              <label className="qf-field__label" htmlFor="channel-privacy-confirm-name">
                계속하려면 채널 이름 <strong>{channelName}</strong> 을(를) 입력하세요.
              </label>
              <Input
                id="channel-privacy-confirm-name"
                data-testid="channel-privacy-confirm-name"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={channelName}
                autoComplete="off"
                aria-invalid={typed.length > 0 && !matches}
              />
              <p className="qf-field__hint">
                {typed.length > 0 && !matches
                  ? '채널 이름이 일치하지 않습니다.'
                  : '정확히 일치해야 전환할 수 있습니다.'}
              </p>
            </div>
            <div className="qf-modal__footer">
              <Button
                type="button"
                variant="ghost"
                data-testid="channel-privacy-confirm-cancel"
                onClick={() => {
                  setTyped('');
                  onCancel();
                }}
              >
                취소
              </Button>
              <Button
                type="button"
                variant="danger"
                data-testid="channel-privacy-confirm-submit"
                disabled={!canConfirm}
                onClick={() => onConfirm(typed)}
              >
                {submitting ? '전환 중…' : '공개로 전환'}
              </Button>
            </div>
          </div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
