import { useState } from 'react';
import type { OnboardingAnswer, OnboardingQuestion } from '@qufox/shared-types';
import { Button } from '../../design-system/primitives';

/**
 * S71 (FR-W08): 온보딩 Step2 — 관심사 선택. SINGLE(라디오)·MULTI(체크박스)·SHORT_TEXT(입력)
 * 질문을 렌더하고, '계속' 시 선택을 answers 로 모아 complete 한다. '건너뛰기'는 빈 answers.
 * a11y: 각 질문 fieldset/legend + 진행 단계 표시.
 */
export function StepInterests({
  questions,
  stepLabel,
  pending,
  onComplete,
  onSkip,
}: {
  questions: OnboardingQuestion[];
  stepLabel: string;
  pending: boolean;
  onComplete: (answers: OnboardingAnswer[]) => void;
  onSkip: () => void;
}): JSX.Element {
  // questionId → 선택한 optionId 집합 / SHORT_TEXT 텍스트.
  const [selections, setSelections] = useState<Record<string, Set<string>>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});

  function toggleOption(q: OnboardingQuestion, optionId: string): void {
    setSelections((prev) => {
      const cur = new Set(prev[q.id] ?? []);
      if (q.type === 'SINGLE') {
        cur.clear();
        cur.add(optionId);
      } else if (cur.has(optionId)) {
        cur.delete(optionId);
      } else {
        cur.add(optionId);
      }
      return { ...prev, [q.id]: cur };
    });
  }

  function buildAnswers(): OnboardingAnswer[] {
    return questions.map((q) => {
      if (q.type === 'SHORT_TEXT') {
        return { questionId: q.id, optionIds: [], text: texts[q.id] ?? '' };
      }
      return { questionId: q.id, optionIds: [...(selections[q.id] ?? [])] };
    });
  }

  return (
    <div className="flex flex-col gap-[var(--s-5)]" data-testid="onboarding-step-interests">
      <p className="text-[length:var(--fs-12)] text-text-muted" aria-live="polite">
        {stepLabel}
      </p>
      <h2 className="text-text-strong text-[length:var(--fs-18)] font-semibold">관심사 선택</h2>
      <div className="flex flex-col gap-[var(--s-5)]">
        {questions.map((q) => (
          <fieldset key={q.id} className="qf-field flex flex-col gap-[var(--s-2)]">
            <legend className="text-text-strong font-medium text-[length:var(--fs-14)]">
              {q.label}
              {q.isRequired ? <span className="text-text-strong"> *</span> : null}
            </legend>
            {q.type === 'SHORT_TEXT' ? (
              <textarea
                className="qf-input"
                rows={3}
                aria-label={q.label}
                value={texts[q.id] ?? ''}
                onChange={(e) => setTexts((prev) => ({ ...prev, [q.id]: e.target.value }))}
                data-testid={`q-text-${q.id}`}
              />
            ) : (
              <div className="flex flex-col gap-[var(--s-2)]">
                {q.options.map((opt) => (
                  <label
                    key={opt.id}
                    className="flex items-center gap-[var(--s-3)] text-[length:var(--fs-14)] text-foreground"
                  >
                    <input
                      type={q.type === 'SINGLE' ? 'radio' : 'checkbox'}
                      name={`q-${q.id}`}
                      checked={!!selections[q.id]?.has(opt.id)}
                      onChange={() => toggleOption(q, opt.id)}
                      data-testid={`q-opt-${q.id}-${opt.id}`}
                    />
                    <span>{opt.label}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        ))}
      </div>
      <div className="flex justify-end gap-[var(--s-2)]">
        <Button variant="ghost" disabled={pending} onClick={onSkip} data-testid="onboarding-skip">
          건너뛰기
        </Button>
        <Button
          variant="primary"
          disabled={pending}
          onClick={() => onComplete(buildAnswers())}
          data-testid="onboarding-complete"
        >
          {pending ? '처리 중…' : '계속'}
        </Button>
      </div>
    </div>
  );
}
