import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CustomStatusView, SetCustomStatusInput, StatusPreset } from '@qufox/shared-types';
import { apiRequest } from '../../lib/api';
import { qk } from '../../lib/query-keys';

/**
 * S28 (FR-P04 + FR-P17): 구조화 커스텀 상태(text + emoji + expiresAt) 훅.
 *
 *   GET    /users/me/status  → { text, emoji, expiresAt }  (서버가 lazy 만료 적용)
 *   PUT    /users/me/status  { text?, emoji?, expiresAt?, preset?, timezone? }
 *   DELETE /users/me/status
 *
 * 프리셋('오늘 자정'/30분/1시간/이번주 등)은 클라이언트가 브라우저 timezone 으로
 * 절대 UTC expiresAt 을 계산해 보내는 것을 1차 경로로 삼는다(가장 신뢰도 높음).
 * preset + timezone 을 그대로 넘기면 서버가 동일 기준으로 계산한다(fallback).
 *
 * contract HIGH fix-forward: CustomStatusView / StatusPreset / SetCustomStatusInput
 * 의 단일 출처는 @qufox/shared-types 다(api/web drift 제거). 로컬 재정의를 제거하고
 * import 후 재노출한다(기존 import 경로 호환).
 */
export type { CustomStatusView, SetCustomStatusInput, StatusPreset };

/** 브라우저의 IANA timezone(예: "Asia/Seoul"). 실패 시 'UTC'. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function useCustomStatus() {
  return useQuery({
    queryKey: qk.me.customStatus(),
    queryFn: async (): Promise<CustomStatusView> =>
      apiRequest<CustomStatusView>('/users/me/status', { method: 'GET' }),
    staleTime: 30_000,
  });
}

export function useSetCustomStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SetCustomStatusInput): Promise<CustomStatusView> => {
      // timezone 미지정 시 브라우저 tz 를 주입해 프리셋 계산을 안정화한다.
      const body: SetCustomStatusInput = {
        ...input,
        timezone: input.timezone ?? browserTimezone(),
      };
      return apiRequest<CustomStatusView>('/users/me/status', { method: 'PUT', body });
    },
    onSuccess: (data) => {
      qc.setQueryData<CustomStatusView>(qk.me.customStatus(), data);
      // /me/profile 의 customStatus(텍스트)도 동기화.
      qc.setQueryData<{ customStatus: string | null } | undefined>(qk.me.profile(), (prev) =>
        prev ? { ...prev, customStatus: data.text } : prev,
      );
    },
  });
}

export function useClearCustomStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<CustomStatusView> =>
      apiRequest<CustomStatusView>('/users/me/status', { method: 'DELETE' }),
    onSuccess: (data) => {
      qc.setQueryData<CustomStatusView>(qk.me.customStatus(), data);
      qc.setQueryData<{ customStatus: string | null } | undefined>(qk.me.profile(), (prev) =>
        prev ? { ...prev, customStatus: null } : prev,
      );
    },
  });
}
