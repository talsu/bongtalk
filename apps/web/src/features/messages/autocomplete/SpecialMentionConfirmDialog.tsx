import { useId } from 'react';
import * as RDialog from '@radix-ui/react-dialog';
import { Button } from '../../../design-system/primitives';
import { cn } from '../../../lib/cn';
import type { SpecialMentionKey } from './specialMention';

/**
 * S18 (FR-MSG-14) — 대규모 특수 멘션 전송 전 확인 dialog.
 *
 * `@everyone`(멤버수 >= EVERYONE_CONFIRM_THRESHOLD) / `@here`
 * (>= BULK_MENTION_CONFIRM_THRESHOLD)로 보낼 때, 실수 fanout 을 막기 위해
 * 한 번 더 확인을 받습니다. 임계값 판정은 needsSpecialMentionConfirm 가
 * 담당하고, 본 컴포넌트는 표시/확인 UI 만 맡습니다.
 *
 * DS 정합(S18 리뷰 BLOCKER DS-1/DS-2): ChannelPrivacyConfirmModal 과 동일한
 * Radix + DS 패턴을 따릅니다.
 *   - `!important` 없이 `qf-modal-backdrop`(DS 가 이미 fixed/inset-0/z-index 제공)
 *     + `qf-modal`(DS 가 z-index 제공) + Radix 중앙정렬 유틸만 사용합니다.
 *   - header / body / footer 는 `qf-modal`(flex column)의 형제 노드로 배치합니다
 *     (footer 를 body 안에 중첩하지 않습니다 — DS 의 border-top/margin-top 정합).
 *   - role="alertdialog" + aria-modal + 포커스 트랩은 유지합니다(파괴적 확인).
 *
 * 수신자 수(S18 리뷰 MAJOR): 컴포저 컨텍스트에는 정확한 "채널 온라인 멤버 수"
 * 가 없습니다(presence 는 워크스페이스 스코프, 채널 멤버 수 소스 없음). 잘못된
 * 숫자를 약속하지 않도록 멘션 종류별 대상 범위만 완곡하게 안내합니다.
 * 정확한 채널 멤버 수 노출 + threshold-source 정합은 carryover.
 */
const COPY: Record<SpecialMentionKey, { title: string; body: string }> = {
  here: {
    title: '@here 로 알릴까요?',
    body: '이 채널에서 지금 온라인인 멤버 전원에게 알림이 갑니다. 계속할까요?',
  },
  everyone: {
    title: '@everyone 로 알릴까요?',
    body: '워크스페이스의 모든 멤버에게 알림이 갑니다. 계속할까요?',
  },
};

export function SpecialMentionConfirmDialog({
  open,
  mentionKey,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  mentionKey: SpecialMentionKey | null;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element | null {
  const titleId = useId();
  const descId = useId();
  if (!mentionKey) return null;
  const copy = COPY[mentionKey];

  return (
    <RDialog.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) onCancel();
      }}
    >
      <RDialog.Portal>
        <RDialog.Overlay className="qf-modal-backdrop" />
        <RDialog.Content
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descId}
          data-testid="special-mention-confirm"
          data-mention-key={mentionKey}
          className={cn('qf-modal fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2')}
          onEscapeKeyDown={() => onCancel()}
        >
          <div className="qf-modal__header">
            <RDialog.Title id={titleId} className="qf-modal__title">
              {copy.title}
            </RDialog.Title>
          </div>
          <div className="qf-modal__body">
            <p
              id={descId}
              className="mt-[var(--s-2)] text-[length:var(--fs-13)] text-text-secondary"
            >
              {copy.body}
            </p>
          </div>
          <div className="qf-modal__footer">
            <Button
              type="button"
              variant="ghost"
              data-testid="special-mention-confirm-cancel"
              onClick={onCancel}
            >
              취소
            </Button>
            <Button
              type="button"
              variant="primary"
              data-testid="special-mention-confirm-submit"
              onClick={onConfirm}
            >
              보내기
            </Button>
          </div>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
