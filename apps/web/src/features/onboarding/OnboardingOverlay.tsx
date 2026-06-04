import { useMemo, useState } from 'react';
import type { OnboardingAnswer, OnboardingStateResponse } from '@qufox/shared-types';
import { Dialog } from '../../design-system/primitives';
import { useAcceptRules, useCompleteOnboarding } from './useOnboardingState';
import { StepRules } from './StepRules';
import { StepInterests } from './StepInterests';
import { StepWelcome } from './StepWelcome';

type Phase = 'rules' | 'interests' | 'welcome' | 'closed';

/**
 * S71 (D13 / FR-W07·W08·W09): 워크스페이스 온보딩 전체화면 모달. 신규 멤버가 첫 진입 시
 * 규칙 동의(Step1) → 관심사(Step2) → 웰컴(Step3) 순서로 진행한다. 각 단계는 데이터가 비어 있으면
 * 건너뛴다(Fork A-1). rulesAcceptedAt/onboardingCompletedAt 으로 resume 단계를 복원한다.
 *
 * Dialog(Radix)가 focus trap + aria-modal + 포커스 진입을 제공한다. 규칙/관심사 단계는 닫기를
 * 막는다(block — onOpenChange 의 false 무시). 웰컴 단계만 닫기를 허용한다.
 */
export function OnboardingOverlay({
  slug,
  state,
}: {
  slug: string;
  state: OnboardingStateResponse;
}): JSX.Element | null {
  const acceptRules = useAcceptRules(slug);
  const complete = useCompleteOnboarding(slug);

  // 초기 phase 를 서버 상태로부터 복원(resume).
  const initialPhase = useMemo<Phase>(() => {
    const needsRules = state.rules.length > 0 && state.rulesAcceptedAt == null;
    if (needsRules) return 'rules';
    if (state.onboardingCompletedAt == null && state.questions.length > 0) return 'interests';
    if (state.onboardingCompletedAt == null && state.welcome != null) return 'welcome';
    // 규칙만 있고 동의도 끝났는데 step2/3 가 없으면 complete 을 한 번 호출해 마감한다.
    if (state.onboardingCompletedAt == null) return 'interests';
    return 'closed';
  }, [state]);

  const [phase, setPhase] = useState<Phase>(initialPhase);

  if (phase === 'closed') return null;

  const totalSteps =
    (state.rules.length > 0 ? 1 : 0) +
    (state.questions.length > 0 ? 1 : 0) +
    (state.welcome != null ? 1 : 0);
  const stepIndex =
    phase === 'rules' ? 1 : phase === 'interests' ? (state.rules.length > 0 ? 2 : 1) : totalSteps;
  const stepLabel = `${stepIndex} / ${Math.max(totalSteps, 1)} 단계`;

  async function handleAcceptRules(): Promise<void> {
    await acceptRules.mutateAsync();
    advanceFromRules();
  }

  function advanceFromRules(): void {
    if (state.questions.length > 0) setPhase('interests');
    else void finishInterests([]);
  }

  async function finishInterests(answers: OnboardingAnswer[]): Promise<void> {
    await complete.mutateAsync({ answers });
    if (state.welcome != null) setPhase('welcome');
    else setPhase('closed');
  }

  return (
    <Dialog
      open
      // 규칙/관심사 단계는 닫기를 막는다(block). 웰컴 단계만 허용.
      onOpenChange={(open) => {
        if (!open && phase === 'welcome') setPhase('closed');
      }}
      title="워크스페이스 온보딩"
      className="w-[min(560px,94vw)]"
    >
      {phase === 'rules' ? (
        <StepRules
          rules={state.rules}
          stepLabel={stepLabel}
          pending={acceptRules.isPending}
          onAccept={() => void handleAcceptRules()}
        />
      ) : phase === 'interests' ? (
        <StepInterests
          questions={state.questions}
          stepLabel={stepLabel}
          pending={complete.isPending}
          onComplete={(answers) => void finishInterests(answers)}
          onSkip={() => void finishInterests([])}
        />
      ) : phase === 'welcome' && state.welcome ? (
        <StepWelcome
          welcome={state.welcome}
          stepLabel={stepLabel}
          onDone={() => setPhase('closed')}
        />
      ) : null}
    </Dialog>
  );
}

/**
 * Shell 마운트 게이트. 표시 조건(shouldShowOnboarding)을 만족할 때만 OnboardingOverlay 를
 * 렌더한다. 조건 판정은 useOnboardingState 결과를 받은 상위(OnboardingHost)가 한다.
 */
export function OnboardingOverlayGate({
  slug,
  state,
  show,
}: {
  slug: string;
  state: OnboardingStateResponse | undefined;
  show: boolean;
}): JSX.Element | null {
  if (!show || !state) return null;
  return <OnboardingOverlay slug={slug} state={state} />;
}
