import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_PRIVACY,
  type PrivacySettings,
  type UpdatePrivacySettings,
} from '@qufox/shared-types';
import { apiRequest } from '../../lib/api';
import { qk } from '../../lib/query-keys';

/**
 * S77a (D14 / FR-PS-13): 프라이버시 설정 hooks(S76 useAppearanceSettings 패턴 mirror).
 *
 *   - usePrivacySettings: GET /me/settings/privacy(행 없으면 기본값 true/true/EVERYONE).
 *   - useUpdatePrivacySettings: PATCH 즉시 자동 저장(낙관적 갱신 → 실패 시 revert).
 *
 * 프라이버시 값은 DOM 부수효과가 없다(서버 도메인 게이트가 enforce). 따라서 외관/접근성과
 * 달리 applyToDOM 이 없으며, 캐시 갱신만으로 UI 가 즉시 반영된다.
 */
export function usePrivacySettings(enabled = true) {
  return useQuery({
    queryKey: qk.me.privacySettings(),
    enabled,
    queryFn: (): Promise<PrivacySettings> =>
      apiRequest<PrivacySettings>('/me/settings/privacy', { method: 'GET' }),
    staleTime: 60_000,
  });
}

export function useUpdatePrivacySettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdatePrivacySettings) =>
      apiRequest<PrivacySettings>('/me/settings/privacy', { method: 'PATCH', body: input }),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: qk.me.privacySettings() });
      const previous = qc.getQueryData<PrivacySettings>(qk.me.privacySettings()) ?? DEFAULT_PRIVACY;
      const optimistic: PrivacySettings = { ...previous, ...input };
      qc.setQueryData(qk.me.privacySettings(), optimistic);
      return { previous };
    },
    onError: (_err, _input, ctx) => {
      if (ctx?.previous) qc.setQueryData(qk.me.privacySettings(), ctx.previous);
    },
    onSuccess: (data) => {
      qc.setQueryData(qk.me.privacySettings(), data);
    },
  });
}
