import { forwardRef, useId, useMemo, useState } from 'react';
import type { WorkspaceRule } from '@qufox/shared-types';
import { Button } from '../../design-system/primitives';

/**
 * S71 (FR-W07): 온보딩 Step1 — 규칙 동의. 각 규칙을 체크박스 라벨로 노출하고, 전부 체크해야
 * "동의하고 계속" 버튼이 활성화된다(전체 동의 강제).
 *
 * a11y (S71 fix-forward):
 *  - BLK-2: 루트 div 는 tabIndex=-1 + forwardRef 로, 단계 전환 시 오버레이가 포커스를 이동한다.
 *  - MAJOR-1: 소제목은 <h3>(Dialog.Title 이 h2 라 그 아래 계층).
 *  - MAJOR-4: "동의하고 계속" 은 disabled 대신 aria-disabled 로 — 미완료 시 onClick early-return
 *    하고 aria-describedby 로 비활성 사유("모든 규칙에 동의해야 함")를 노출한다(AT 가 버튼을
 *    인지하되 비활성 이유를 알 수 있게).
 */
export const StepRules = forwardRef<
  HTMLDivElement,
  {
    rules: WorkspaceRule[];
    pending: boolean;
    onAccept: () => void;
  }
>(function StepRules({ rules, pending, onAccept }, ref): JSX.Element {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const allChecked = useMemo(() => rules.every((r) => checked[r.id]), [rules, checked]);
  const headingId = useId();
  const acceptHintId = useId();
  const disabled = !allChecked || pending;

  return (
    <div
      ref={ref}
      tabIndex={-1}
      aria-labelledby={headingId}
      className="flex flex-col gap-[var(--s-5)] outline-none"
      data-testid="onboarding-step-rules"
    >
      <h3 id={headingId} className="text-text-strong text-[length:var(--fs-18)] font-semibold">
        커뮤니티 규칙
      </h3>
      <ul className="flex flex-col gap-[var(--s-3)]">
        {rules.map((rule, i) => (
          <li key={rule.id} className="qf-field">
            <label className="flex items-start gap-[var(--s-3)] text-[length:var(--fs-14)] text-foreground">
              <input
                type="checkbox"
                className="mt-[var(--s-1)]"
                checked={!!checked[rule.id]}
                onChange={(e) => setChecked((prev) => ({ ...prev, [rule.id]: e.target.checked }))}
                data-testid={`rule-check-${i}`}
              />
              <span className="flex flex-col gap-[var(--s-1)]">
                <span className="text-text-strong font-medium">
                  {i + 1}. {rule.title}
                </span>
                {rule.description ? (
                  <span className="text-text-muted text-[length:var(--fs-13)]">
                    {rule.description}
                  </span>
                ) : null}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <p id={acceptHintId} className="sr-only">
        계속하려면 모든 규칙에 동의해야 합니다.
      </p>
      <div className="flex justify-end">
        <Button
          variant="primary"
          aria-disabled={disabled}
          aria-describedby={!allChecked ? acceptHintId : undefined}
          onClick={() => {
            // a11y MAJOR-4: disabled 대신 aria-disabled — 미완료/처리중이면 동작만 막는다.
            if (disabled) return;
            onAccept();
          }}
          data-testid="onboarding-accept-rules"
        >
          {pending ? '처리 중…' : '동의하고 계속'}
        </Button>
      </div>
    </div>
  );
});
