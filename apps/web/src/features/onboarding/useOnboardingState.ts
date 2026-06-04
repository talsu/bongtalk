import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CompleteOnboardingRequest, OnboardingStateResponse } from '@qufox/shared-types';
import { useAuth } from '../auth/AuthProvider';
import { acceptRules, completeOnboarding, getOnboardingState } from './api';

/**
 * S71 (D13 / FR-W07·W08·W09): 워크스페이스 온보딩 서버 상태 훅. 기존 useOnboarding.ts(사이드바
 * 체크리스트)와 별개다 — 이 훅은 워크스페이스별 규칙/질문/웰컴 카탈로그 + 멤버 진행 상태를 읽어
 * OnboardingOverlay 의 마운트/resume 을 결정한다.
 */
export function useOnboardingState(slug: string | null | undefined) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['onboarding', 'state', slug ?? '', user?.id ?? ''] as const,
    queryFn: () => getOnboardingState(slug as string),
    enabled: !!slug && !!user?.id,
    staleTime: 60 * 1000,
  });
}

export function useAcceptRules(slug: string) {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: () => acceptRules(slug),
    onSuccess: (res) => {
      qc.setQueryData<OnboardingStateResponse>(
        ['onboarding', 'state', slug, user?.id ?? ''],
        (prev) => (prev ? { ...prev, rulesAcceptedAt: res.rulesAcceptedAt } : prev),
      );
    },
  });
}

export function useCompleteOnboarding(slug: string) {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: (body: CompleteOnboardingRequest) => completeOnboarding(slug, body),
    onSuccess: (res) => {
      qc.setQueryData<OnboardingStateResponse>(
        ['onboarding', 'state', slug, user?.id ?? ''],
        (prev) => (prev ? { ...prev, onboardingCompletedAt: res.onboardingCompletedAt } : prev),
      );
      // 채널 구독/역할 변경이 사이드바·멤버 목록에 반영되도록 관련 캐시 무효화.
      void qc.invalidateQueries({ queryKey: ['channels'] });
    },
  });
}

/**
 * 온보딩 오버레이를 표시해야 하는지 판정한다(Fork A-1). 규칙/질문/웰컴이 모두 비어 있으면
 * 표시하지 않는다(자동 완료 — 기존 워크스페이스 무회귀). OWNER 는 생성자라 표시하지 않는다.
 *   - Step1(규칙) 미완료: rules.length>0 && rulesAcceptedAt==null
 *   - Step2(관심사) 미완료: onboardingCompletedAt==null && (questions.length>0 || welcome 존재)
 */
export function shouldShowOnboarding(
  state: OnboardingStateResponse | undefined,
  myRole: string | null | undefined,
): boolean {
  if (!state) return false;
  if (myRole === 'OWNER') return false;
  const needsRules = state.rules.length > 0 && state.rulesAcceptedAt == null;
  const hasStep2or3 = state.questions.length > 0 || state.welcome != null;
  const needsCompletion = state.onboardingCompletedAt == null && (hasStep2or3 || needsRules);
  return needsRules || needsCompletion;
}
