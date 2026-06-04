import { apiRequest } from '../../lib/api';
import type {
  AcceptRulesResponse,
  AdminQuestionsResponse,
  AdminRulesResponse,
  AdminWelcomeResponse,
  CompleteOnboardingRequest,
  CompleteOnboardingResponse,
  OnboardingQuestion,
  OnboardingStateResponse,
  ReorderRulesRequest,
  UpsertQuestionRequest,
  UpsertWelcomeRequest,
  UpsertWorkspaceRuleRequest,
  WorkspaceRule,
} from '@qufox/shared-types';

// S71 (D13 / FR-W07·W08·W09): 워크스페이스 온보딩 FE API. 경로는 PRD 정본대로 :slug 를 쓴다
// (applications API 선례 — 다른 워크스페이스 API 의 :id 와 별개).

/** FR-W07·W08·W09: 멤버 온보딩 상태 + 규칙/질문/웰컴 카탈로그. */
export function getOnboardingState(slug: string): Promise<OnboardingStateResponse> {
  return apiRequest(`/workspaces/${slug}/onboarding`);
}

/** FR-W07: 규칙 동의. */
export function acceptRules(slug: string): Promise<AcceptRulesResponse> {
  return apiRequest(`/workspaces/${slug}/onboarding/accept-rules`, { method: 'POST' });
}

/** FR-W08: 관심사 완료(채널 구독 + 역할 부여 + 웰컴 enqueue). '건너뛰기'는 빈 answers. */
export function completeOnboarding(
  slug: string,
  body: CompleteOnboardingRequest,
): Promise<CompleteOnboardingResponse> {
  return apiRequest(`/workspaces/${slug}/onboarding/complete`, { method: 'POST', body });
}

// ── 관리자 CRUD(ADMIN+) ──────────────────────────────────────────────────────

export function listRules(slug: string): Promise<AdminRulesResponse> {
  return apiRequest(`/workspaces/${slug}/onboarding/admin/rules`);
}

export function createRule(slug: string, body: UpsertWorkspaceRuleRequest): Promise<WorkspaceRule> {
  return apiRequest(`/workspaces/${slug}/onboarding/admin/rules`, { method: 'POST', body });
}

export function updateRule(
  slug: string,
  ruleId: string,
  body: UpsertWorkspaceRuleRequest,
): Promise<WorkspaceRule> {
  return apiRequest(`/workspaces/${slug}/onboarding/admin/rules/${ruleId}`, {
    method: 'PATCH',
    body,
  });
}

export function deleteRule(slug: string, ruleId: string): Promise<void> {
  return apiRequest(`/workspaces/${slug}/onboarding/admin/rules/${ruleId}`, { method: 'DELETE' });
}

export function reorderRules(slug: string, body: ReorderRulesRequest): Promise<AdminRulesResponse> {
  return apiRequest(`/workspaces/${slug}/onboarding/admin/rules/reorder`, { method: 'POST', body });
}

export function listQuestions(slug: string): Promise<AdminQuestionsResponse> {
  return apiRequest(`/workspaces/${slug}/onboarding/admin/questions`);
}

export function createQuestion(
  slug: string,
  body: UpsertQuestionRequest,
): Promise<OnboardingQuestion> {
  return apiRequest(`/workspaces/${slug}/onboarding/admin/questions`, { method: 'POST', body });
}

export function updateQuestion(
  slug: string,
  questionId: string,
  body: UpsertQuestionRequest,
): Promise<OnboardingQuestion> {
  return apiRequest(`/workspaces/${slug}/onboarding/admin/questions/${questionId}`, {
    method: 'PATCH',
    body,
  });
}

export function deleteQuestion(slug: string, questionId: string): Promise<void> {
  return apiRequest(`/workspaces/${slug}/onboarding/admin/questions/${questionId}`, {
    method: 'DELETE',
  });
}

export function getWelcome(slug: string): Promise<AdminWelcomeResponse> {
  return apiRequest(`/workspaces/${slug}/onboarding/admin/welcome`);
}

export function upsertWelcome(
  slug: string,
  body: UpsertWelcomeRequest,
): Promise<AdminWelcomeResponse> {
  return apiRequest(`/workspaces/${slug}/onboarding/admin/welcome`, { method: 'PUT', body });
}
