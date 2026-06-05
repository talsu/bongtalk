import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_APPEARANCE,
  type AppearanceSettings,
  type UpdateAppearanceSettings,
} from '@qufox/shared-types';
import { apiRequest } from '../../lib/api';
import { qk } from '../../lib/query-keys';
import { useAppearanceStore } from '../../stores/appearance-store';
import { useTheme } from '../../design-system/theme/ThemeProvider';
import { applyAppearanceToDOM, themeToPreference } from './applyAppearanceToDOM';

/**
 * S76 (D14 / FR-PS-09 + Fork B1/C1): 외관 설정 hooks.
 *
 *   - useAppearanceSettings: GET /me/settings/appearance. 서버값을 ThemeProvider(테마 단일
 *     소유자) + DOM(density) + 스토어(clock24h)에 반영해 서버 단일 출처를 보정한다(Fork C1).
 *   - useUpdateAppearanceSettings: PATCH 즉시 자동 저장(Fork B1). 낙관적으로 캐시/테마/DOM/
 *     스토어를 갱신하고, 실패 시 직전 값으로 revert 한다(호출부가 토스트).
 *
 * F-M2: 테마는 ThemeProvider.setPreference 로 라우팅한다(SYSTEM 라이브 추종 + 단일 소유).
 * F-P1: applyAppearanceToDOM 은 값이 실제로 바뀐 경우에만 호출해 중복 적용을 피한다.
 */

/** previous/next 의 시각 적용 대상(theme/density)이 동일하면 재적용을 건너뛴다(F-P1). */
function applyIfChanged(
  prev: AppearanceSettings | undefined,
  next: AppearanceSettings,
  setPreference: (p: ReturnType<typeof themeToPreference>) => void,
): void {
  if (!prev || prev.theme !== next.theme) {
    // 테마 단일 소유자(ThemeProvider)에 라우팅 — SYSTEM 은 prefers-color-scheme 라이브 추종.
    setPreference(themeToPreference(next.theme));
  }
  if (!prev || prev.density !== next.density) {
    applyAppearanceToDOM(next);
  }
}

export function useAppearanceSettings(enabled = true) {
  const qc = useQueryClient();
  const { setPreference } = useTheme();
  return useQuery({
    queryKey: qk.me.appearanceSettings(),
    enabled,
    queryFn: async (): Promise<AppearanceSettings> => {
      const data = await apiRequest<AppearanceSettings>('/me/settings/appearance', {
        method: 'GET',
      });
      // Fork C1: 서버값으로 테마/DOM/스토어 보정(서버 단일 출처). 반환값은 react-query 가
      // 자동으로 캐시에 쓰므로(F-P1) 별도 setQueryData 는 두지 않는다.
      const prev = qc.getQueryData<AppearanceSettings>(qk.me.appearanceSettings());
      applyIfChanged(prev, data, setPreference);
      useAppearanceStore.getState().set(data);
      return data;
    },
    staleTime: 60_000,
  });
}

export function useUpdateAppearanceSettings() {
  const qc = useQueryClient();
  const { setPreference } = useTheme();
  return useMutation({
    mutationFn: (input: UpdateAppearanceSettings) =>
      apiRequest<AppearanceSettings>('/me/settings/appearance', {
        method: 'PATCH',
        body: input,
      }),
    // Fork B1: 낙관적 갱신 — 즉시 테마/DOM/스토어/캐시 반영, 실패 시 revert.
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: qk.me.appearanceSettings() });
      const previous =
        qc.getQueryData<AppearanceSettings>(qk.me.appearanceSettings()) ??
        useAppearanceStore.getState().settings ??
        DEFAULT_APPEARANCE;
      const optimistic: AppearanceSettings = { ...previous, ...input };
      qc.setQueryData(qk.me.appearanceSettings(), optimistic);
      applyIfChanged(previous, optimistic, setPreference);
      useAppearanceStore.getState().set(optimistic);
      return { previous };
    },
    onError: (_err, _input, ctx) => {
      // 실패 → 직전 값으로 되돌린다(낙관적 revert). 호출부가 별도 토스트를 띄운다.
      const previous = ctx?.previous;
      if (previous) {
        const current = qc.getQueryData<AppearanceSettings>(qk.me.appearanceSettings());
        qc.setQueryData(qk.me.appearanceSettings(), previous);
        applyIfChanged(current, previous, setPreference);
        useAppearanceStore.getState().set(previous);
      }
    },
    onSuccess: (data) => {
      // 서버 권위값으로 최종 정합(낙관값과 다를 수 있는 클램프 등을 반영). 낙관값과 동일하면
      // applyIfChanged 가 재적용을 skip 한다(F-P1 — onMutate 와 합쳐 PATCH 1회당 최대 1회 적용).
      const current = qc.getQueryData<AppearanceSettings>(qk.me.appearanceSettings());
      qc.setQueryData(qk.me.appearanceSettings(), data);
      applyIfChanged(current, data, setPreference);
      useAppearanceStore.getState().set(data);
    },
  });
}
