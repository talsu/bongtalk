import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ChangeEmailRequest,
  ChangeEmailResponse,
  ChangePasswordRequest,
  DeactivateAccountRequest,
  ReactivateAccountRequest,
  SessionListResponse,
  TotpDisableRequest,
  TotpSetupResponse,
  TotpVerifyResponse,
  TwoFactorStatus,
} from '@qufox/shared-types';
import { apiRequest } from '../../lib/api';
import { qk } from '../../lib/query-keys';

/**
 * S77b (D14 / FR-PS-15·20): 보안 설정 hooks — 자격증명 변경 · TOTP 2FA · 세션.
 *
 * 자격증명 변경(POST)은 캐시 부수효과가 없고, 2FA/세션은 mutation 성공 시 관련 쿼리를
 * invalidate 한다. 모든 호출은 lib/api 의 apiRequest 를 거쳐 401 시 refresh→재시도한다.
 */

export function useTwoFactorStatus(enabled = true) {
  return useQuery({
    queryKey: qk.me.twoFactorStatus(),
    enabled,
    queryFn: (): Promise<TwoFactorStatus> =>
      apiRequest<TwoFactorStatus>('/me/2fa', { method: 'GET' }),
    staleTime: 30_000,
  });
}

export function useSessions(enabled = true) {
  return useQuery({
    queryKey: qk.me.sessions(),
    enabled,
    queryFn: (): Promise<SessionListResponse> =>
      apiRequest<SessionListResponse>('/me/sessions', { method: 'GET' }),
    staleTime: 10_000,
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (input: ChangePasswordRequest): Promise<void> =>
      apiRequest<void>('/users/me/change-password', { method: 'POST', body: input }),
  });
}

export function useChangeEmail() {
  return useMutation({
    mutationFn: (input: ChangeEmailRequest): Promise<ChangeEmailResponse> =>
      apiRequest<ChangeEmailResponse>('/users/me/change-email', { method: 'POST', body: input }),
  });
}

export function useTotpSetup() {
  return useMutation({
    mutationFn: (): Promise<TotpSetupResponse> =>
      apiRequest<TotpSetupResponse>('/me/2fa/totp/setup', { method: 'POST' }),
  });
}

export function useTotpVerify() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code: string): Promise<TotpVerifyResponse> =>
      apiRequest<TotpVerifyResponse>('/me/2fa/totp/verify', { method: 'POST', body: { code } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.me.twoFactorStatus() });
      void qc.invalidateQueries({ queryKey: qk.me.sessions() });
    },
  });
}

export function useTotpDisable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TotpDisableRequest): Promise<void> =>
      apiRequest<void>('/me/2fa/totp', { method: 'DELETE', body: input }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.me.twoFactorStatus() });
    },
  });
}

export function useRevokeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string): Promise<void> =>
      apiRequest<void>(`/me/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.me.sessions() });
    },
  });
}

export function useRevokeAllSessions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (): Promise<void> => apiRequest<void>('/me/sessions', { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.me.sessions() });
    },
  });
}

// S77c (D14 / FR-PS-16): 계정 비활성화. 성공 시 서버가 session:revoked 를 emit 하고 모든 세션을
// 끊으므로, 호출부(AdvancedSettingsPage)가 직후 자동 로그아웃 + 로그인 이동을 수행한다.
export function useDeactivateAccount() {
  return useMutation({
    mutationFn: (input: DeactivateAccountRequest): Promise<void> =>
      apiRequest<void>('/users/me/deactivate', { method: 'POST', body: input, retryOn401: false }),
  });
}

// S77c (D14 / FR-PS-16): 계정 재활성화. 비활성 계정은 로그인 차단되므로 자격증명을 직접 받는
// 공개 엔드포인트다(retryOn401 불필요 — 인증 컨텍스트 없음).
export function useReactivateAccount() {
  return useMutation({
    mutationFn: (input: ReactivateAccountRequest): Promise<void> =>
      apiRequest<void>('/users/me/reactivate', { method: 'POST', body: input, retryOn401: false }),
  });
}
