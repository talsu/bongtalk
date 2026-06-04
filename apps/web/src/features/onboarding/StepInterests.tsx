import { forwardRef, useId, useState } from 'react';
import type { OnboardingAnswer, OnboardingQuestion } from '@qufox/shared-types';
import { Button } from '../../design-system/primitives';

/**
 * S71 (FR-W08): 온보딩 Step2 — 관심사 선택. SINGLE(라디오)·MULTI(체크박스)·SHORT_TEXT(입력)
 * 질문을 렌더하고, '계속' 시 선택을 answers 로 모아 complete 한다. '건너뛰기'는 빈 answers.
 *
 * a11y (S71 fix-forward):
 *  - BLK-2: 루트 div tabIndex=-1 + forwardRef(단계 전환 포커스 이동).
 *  - MAJOR-1: 소제목 <h3>(Dialog.Title h2 아래).
 *  - HIGH-3: isRequired 질문은 입력/그룹에 aria-required + sr-only "필수 항목" 라벨.
 *  - MAJOR-5: SHORT_TEXT textarea 는 aria-label 대신 aria-labelledby=legend id(legend 와의
 *    이중 발화 제거).
 *  - MINOR-2: SINGLE 옵션 컨테이너에 role="radiogroup" + aria-labelledby=legend id.
 */
export const StepInterests = forwardRef<
  HTMLDivElement,
  {
    questions: OnboardingQuestion[];
    pending: boolean;
    onComplete: (answers: OnboardingAnswer[]) => void;
    onSkip: () => void;
  }
>(function StepInterests({ questions, pending, onComplete, onSkip }, ref): JSX.Element {
  // questionId → 선택한 optionId 집합 / SHORT_TEXT 텍스트.
  const [selections, setSelections] = useState<Record<string, Set<string>>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});
  const headingId = useId();

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
    <div
      ref={ref}
      tabIndex={-1}
      aria-labelledby={headingId}
      className="flex flex-col gap-[var(--s-5)] outline-none"
      data-testid="onboarding-step-interests"
    >
      <h3 id={headingId} className="text-text-strong text-[length:var(--fs-18)] font-semibold">
        관심사 선택
      </h3>
      <div className="flex flex-col gap-[var(--s-5)]">
        {questions.map((q) => (
          <Question
            key={q.id}
            q={q}
            selected={selections[q.id]}
            text={texts[q.id] ?? ''}
            onToggle={(optionId) => toggleOption(q, optionId)}
            onText={(v) => setTexts((prev) => ({ ...prev, [q.id]: v }))}
          />
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
});

/** 질문 1개. legend 의 id 를 입력/그룹의 aria-labelledby 로 연결한다(이중 발화 방지). */
function Question({
  q,
  selected,
  text,
  onToggle,
  onText,
}: {
  q: OnboardingQuestion;
  selected: Set<string> | undefined;
  text: string;
  onToggle: (optionId: string) => void;
  onText: (value: string) => void;
}): JSX.Element {
  const legendId = useId();
  return (
    <fieldset className="qf-field flex flex-col gap-[var(--s-2)]">
      <legend id={legendId} className="text-text-strong font-medium text-[length:var(--fs-14)]">
        {q.label}
        {q.isRequired ? (
          <>
            <span aria-hidden="true" className="text-text-strong">
              {' '}
              *
            </span>
            <span className="sr-only"> (필수 항목)</span>
          </>
        ) : null}
      </legend>
      {q.type === 'SHORT_TEXT' ? (
        <textarea
          className="qf-input qf-textarea"
          rows={3}
          // a11y MAJOR-5: legend 와 중복 발화하지 않도록 aria-label 대신 aria-labelledby.
          aria-labelledby={legendId}
          aria-required={q.isRequired || undefined}
          value={text}
          onChange={(e) => onText(e.target.value)}
          data-testid={`q-text-${q.id}`}
        />
      ) : (
        <div
          className="flex flex-col gap-[var(--s-2)]"
          // a11y MINOR-2 + HIGH-3: SINGLE 은 radiogroup 으로 그룹화하고 필수면 aria-required.
          {...(q.type === 'SINGLE'
            ? { role: 'radiogroup', 'aria-labelledby': legendId, 'aria-required': q.isRequired }
            : {})}
        >
          {q.options.map((opt) => (
            <label
              key={opt.id}
              className="flex items-center gap-[var(--s-3)] text-[length:var(--fs-14)] text-foreground"
            >
              <input
                type={q.type === 'SINGLE' ? 'radio' : 'checkbox'}
                name={`q-${q.id}`}
                checked={!!selected?.has(opt.id)}
                onChange={() => onToggle(opt.id)}
                data-testid={`q-opt-${q.id}-${opt.id}`}
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}
