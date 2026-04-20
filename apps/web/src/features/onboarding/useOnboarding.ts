import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../../lib/api';
import { useAuth } from '../auth/AuthProvider';

export type OnboardingStatus = {
  workspaces: number;
  channels: number;
  invitesIssued: number;
  messagesSent: number;
};

/**
 * Task-016-C-1: sidebar onboarding checklist. Server endpoint returns
 * raw counts; the checklist card does the "satisfied?" gating locally.
 * Cache at 5 min because the four counts change on user actions that
 * already invalidate sibling queries (create-workspace, send-message,
 * issue-invite) — staleness is bounded by cross-cache coincidence.
 */
export function useOnboardingStatus() {
  const { user } = useAuth();
  return useQuery({
    // task-016 reviewer safeguard: key by viewer id so the cache
    // never cross-populates between user sessions.
    queryKey: ['me', 'onboarding-status', user?.id ?? ''] as const,
    queryFn: () => apiRequest<OnboardingStatus>('/me/onboarding-status'),
    staleTime: 5 * 60 * 1000,
    enabled: !!user?.id,
  });
}

const DISMISSED_KEY = 'qufox.onboarding.dismissed';

export function isOnboardingDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function dismissOnboarding(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, 'true');
  } catch {
    /* localStorage full — accept transient un-dismiss on next load. */
  }
}

export function isOnboardingComplete(s: OnboardingStatus | undefined): boolean {
  if (!s) return false;
  return s.workspaces >= 1 && s.channels >= 2 && s.invitesIssued >= 1 && s.messagesSent >= 1;
}
