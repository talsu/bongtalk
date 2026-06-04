import { useEffect, useMemo, useRef, useState } from 'react';
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
 *
 * a11y (S71 fix-forward):
 *  - BLK-2: 단계 전환 시 각 Step 루트(tabIndex=-1)에 포커스를 이동한다(useEffect[phase]).
 *  - HIGH-1: aria-live 진행 알림을 단계 내부가 아닌 Dialog 내 영속 위치에 단일 선언하고
 *    phase 변경 시 텍스트만 갱신한다(교체되는 Step 안에 두면 mount/unmount 로 알림이 끊긴다).
 *  - HIGH-2: block(규칙/관심사) 단계는 "닫을 수 없음" 사유를 Dialog description 으로 노출한다.
 *  - MAJOR-2: 진행 표시를 role=progressbar(aria-valuenow/min/max/valuetext)로 노출한다.
 *  - MINOR-1: 오버레이가 열린 동안 document.title 을 갱신하고 닫힐 때 복원한다.
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

  // a11y BLK-2: 단계 전환 시 현재 Step 루트로 포커스를 옮긴다. 각 Step 은 tabIndex=-1 루트에
  // 이 ref 를 붙인다(Step 교체로 mount 된 직후 focus — Radix 의 초기 진입 포커스 위에 덮어쓴다).
  const stepRootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (phase === 'closed') return;
    // 마운트 직후 한 틱 뒤 포커스(Radix 포커스 진입 이후에 이동).
    const id = window.requestAnimationFrame(() => stepRootRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [phase]);

  // a11y MINOR-1: 오버레이가 열린 동안 document.title 을 갱신하고 닫힐 때 복원한다.
  useEffect(() => {
    if (phase === 'closed') return;
    const prev = document.title;
    document.title = '워크스페이스 온보딩 | qufox';
    return () => {
      document.title = prev;
    };
  }, [phase]);

  if (phase === 'closed') return null;

  const totalSteps =
    (state.rules.length > 0 ? 1 : 0) +
    (state.questions.length > 0 ? 1 : 0) +
    (state.welcome != null ? 1 : 0);
  const stepIndex =
    phase === 'rules' ? 1 : phase === 'interests' ? (state.rules.length > 0 ? 2 : 1) : totalSteps;
  const maxSteps = Math.max(totalSteps, 1);
  const stepLabel = `${stepIndex} / ${maxSteps} 단계`;
  // a11y HIGH-2: 규칙/관심사 단계는 동의 전까지 닫을 수 없다 — 그 사유를 Dialog description 으로.
  const blockReason =
    phase === 'rules' || phase === 'interests' ? '규칙 동의 전에는 닫을 수 없습니다.' : undefined;

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
      description={blockReason}
    >
      {/* a11y HIGH-1 + MAJOR-2: 진행 알림을 Dialog 내 영속 위치에 단일 선언한다(Step 교체와
          무관하게 유지 — phase 변경 시 텍스트만 갱신). progressbar 가 시각/AT 양쪽에 단계를 노출. */}
      <div
        className="flex flex-col gap-[var(--s-1)]"
        role="progressbar"
        aria-valuenow={stepIndex}
        aria-valuemin={1}
        aria-valuemax={maxSteps}
        aria-valuetext={stepLabel}
        data-testid="onboarding-progress"
      >
        <p className="text-[length:var(--fs-12)] text-text-muted" aria-live="polite">
          {stepLabel}
        </p>
      </div>
      {phase === 'rules' ? (
        <StepRules
          ref={stepRootRef}
          rules={state.rules}
          pending={acceptRules.isPending}
          onAccept={() => void handleAcceptRules()}
        />
      ) : phase === 'interests' ? (
        <StepInterests
          ref={stepRootRef}
          questions={state.questions}
          pending={complete.isPending}
          onComplete={(answers) => void finishInterests(answers)}
          onSkip={() => void finishInterests([])}
        />
      ) : phase === 'welcome' && state.welcome ? (
        <StepWelcome ref={stepRootRef} welcome={state.welcome} onDone={() => setPhase('closed')} />
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
