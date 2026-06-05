import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_APPEARANCE,
  type AppearanceSettings,
  type UpdateAppearanceSettings,
} from '@qufox/shared-types';
import { apiRequest } from '../../lib/api';
import { qk } from '../../lib/query-keys';
import { useAppearanceStore } from '../../stores/appearance-store';
import { applyAppearanceToDOM } from './applyAppearanceToDOM';

/**
 * S76 (D14 / FR-PS-09 + Fork B1/C1): 외관 설정 hooks.
 *
 *   - useAppearanceSettings: GET /me/settings/appearance. onSuccess(또는 select)로
 *     서버값을 DOM + 스토어에 반영해 서버 단일 출처를 보정한다(Fork C1).
 *   - useUpdateAppearanceSettings: PATCH 즉시 자동 저장(Fork B1). 낙관적으로 캐시/DOM/
 *     스토어를 갱신하고, 실패 시 직전 값으로 revert 한다(호출부가 토스트).
 */
export function useAppearanceSettings(enabled = true) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: qk.me.appearanceSettings(),
    enabled,
    queryFn: async (): Promise<AppearanceSettings> => {
      const data = await apiRequest<AppearanceSettings>('/me/settings/appearance', {
        method: 'GET',
      });
      // Fork C1: 서버값으로 DOM + 스토어 보정(서버 단일 출처). queryFn 안에서 적용해
      // 첫 로드 직후 깜빡임 없이 localStorage 즉시값을 서버값으로 덮는다.
      applyAppearanceToDOM(data);
      useAppearanceStore.getState().set(data);
      qc.setQueryData(qk.me.appearanceSettings(), data);
      return data;
    },
    staleTime: 60_000,
  });
}

export function useUpdateAppearanceSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateAppearanceSettings) =>
      apiRequest<AppearanceSettings>('/me/settings/appearance', {
        method: 'PATCH',
        body: input,
      }),
    // Fork B1: 낙관적 갱신 — 즉시 DOM/스토어/캐시 반영, 실패 시 revert.
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: qk.me.appearanceSettings() });
      const previous =
        qc.getQueryData<AppearanceSettings>(qk.me.appearanceSettings()) ??
        useAppearanceStore.getState().settings ??
        DEFAULT_APPEARANCE;
      const optimistic: AppearanceSettings = { ...previous, ...input };
      qc.setQueryData(qk.me.appearanceSettings(), optimistic);
      applyAppearanceToDOM(optimistic);
      useAppearanceStore.getState().set(optimistic);
      return { previous };
    },
    onError: (_err, _input, ctx) => {
      // 실패 → 직전 값으로 되돌린다(낙관적 revert). 호출부가 별도 토스트를 띄운다.
      const previous = ctx?.previous;
      if (previous) {
        qc.setQueryData(qk.me.appearanceSettings(), previous);
        applyAppearanceToDOM(previous);
        useAppearanceStore.getState().set(previous);
      }
    },
    onSuccess: (data) => {
      // 서버 권위값으로 최종 정합(낙관값과 다를 수 있는 클램프 등을 반영).
      qc.setQueryData(qk.me.appearanceSettings(), data);
      applyAppearanceToDOM(data);
      useAppearanceStore.getState().set(data);
    },
  });
}
