import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_ACCESSIBILITY,
  type AccessibilitySettings,
  type UpdateAccessibilitySettings,
} from '@qufox/shared-types';
import { apiRequest } from '../../lib/api';
import { qk } from '../../lib/query-keys';
import { applyAccessibilityToDOM } from './applyAccessibilityToDOM';

/**
 * S77a (D14 / FR-PS-12): 접근성 설정 hooks(S76 useAppearanceSettings 패턴 mirror).
 *
 *   - useAccessibilitySettings: GET /me/settings/accessibility. 서버값을 DOM(documentElement
 *     의 data-reduce-motion/data-high-contrast)에 반영해 서버 단일 출처를 보정한다.
 *   - useUpdateAccessibilitySettings: PATCH 즉시 자동 저장(낙관적 갱신 → 실패 시 revert).
 *
 * 서버에 설정 레코드가 없으면 GET 이 기본값(false/false)을 반환하고, app CSS 의
 * `@media (prefers-reduced-motion: reduce)` 가 OS 우선 동작을 담당한다(서버값이 단일 출처).
 */
export function useAccessibilitySettings(enabled = true) {
  return useQuery({
    queryKey: qk.me.accessibilitySettings(),
    enabled,
    queryFn: async (): Promise<AccessibilitySettings> => {
      const data = await apiRequest<AccessibilitySettings>('/me/settings/accessibility', {
        method: 'GET',
      });
      applyAccessibilityToDOM(data);
      return data;
    },
    staleTime: 60_000,
  });
}

export function useUpdateAccessibilitySettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateAccessibilitySettings) =>
      apiRequest<AccessibilitySettings>('/me/settings/accessibility', {
        method: 'PATCH',
        body: input,
      }),
    // 낙관적 갱신 — 즉시 DOM/캐시 반영, 실패 시 revert.
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: qk.me.accessibilitySettings() });
      const previous =
        qc.getQueryData<AccessibilitySettings>(qk.me.accessibilitySettings()) ??
        DEFAULT_ACCESSIBILITY;
      const optimistic: AccessibilitySettings = { ...previous, ...input };
      qc.setQueryData(qk.me.accessibilitySettings(), optimistic);
      applyAccessibilityToDOM(optimistic);
      return { previous };
    },
    onError: (_err, _input, ctx) => {
      const previous = ctx?.previous;
      if (previous) {
        qc.setQueryData(qk.me.accessibilitySettings(), previous);
        applyAccessibilityToDOM(previous);
      }
    },
    onSuccess: (data) => {
      qc.setQueryData(qk.me.accessibilitySettings(), data);
      applyAccessibilityToDOM(data);
    },
  });
}
