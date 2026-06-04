import { useMemo, useState } from 'react';
import type { WorkspaceRule } from '@qufox/shared-types';
import { Button } from '../../design-system/primitives';

/**
 * S71 (FR-W07): 온보딩 Step1 — 규칙 동의. 각 규칙을 체크박스 라벨로 노출하고, 전부 체크해야
 * "동의하고 계속" 버튼이 활성화된다(전체 동의 강제). a11y: 진행 단계 표시 + 체크박스 라벨.
 */
export function StepRules({
  rules,
  stepLabel,
  pending,
  onAccept,
}: {
  rules: WorkspaceRule[];
  stepLabel: string;
  pending: boolean;
  onAccept: () => void;
}): JSX.Element {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const allChecked = useMemo(() => rules.every((r) => checked[r.id]), [rules, checked]);

  return (
    <div className="flex flex-col gap-[var(--s-5)]" data-testid="onboarding-step-rules">
      <p className="text-[length:var(--fs-12)] text-text-muted" aria-live="polite">
        {stepLabel}
      </p>
      <h2 className="text-text-strong text-[length:var(--fs-18)] font-semibold">커뮤니티 규칙</h2>
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
      <div className="flex justify-end">
        <Button
          variant="primary"
          disabled={!allChecked || pending}
          onClick={onAccept}
          data-testid="onboarding-accept-rules"
        >
          {pending ? '처리 중…' : '동의하고 계속'}
        </Button>
      </div>
    </div>
  );
}
