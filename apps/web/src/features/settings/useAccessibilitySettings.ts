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
 *
 * F10 (perf MODERATE / S76 F-P1 패턴): applyAccessibilityToDOM 은 reduceMotion/highContrast
 * 가 실제로 바뀐 경우에만 호출해 중복 DOM write 를 피한다(onMutate+onSuccess 무조건 2회 →
 * 변경분만 적용).
 */

/** prev/next 의 적용 대상(reduceMotion/highContrast)이 동일하면 재적용을 건너뛴다(F10). */
function applyIfChanged(
  prev: AccessibilitySettings | undefined,
  next: AccessibilitySettings,
): void {
  if (!prev || prev.reduceMotion !== next.reduceMotion || prev.highContrast !== next.highContrast) {
    applyAccessibilityToDOM(next);
  }
}

export function useAccessibilitySettings(enabled = true) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: qk.me.accessibilitySettings(),
    enabled,
    queryFn: async (): Promise<AccessibilitySettings> => {
      const data = await apiRequest<AccessibilitySettings>('/me/settings/accessibility', {
        method: 'GET',
      });
      const prev = qc.getQueryData<AccessibilitySettings>(qk.me.accessibilitySettings());
      applyIfChanged(prev, data);
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
    // 낙관적 갱신 — 즉시 DOM/캐시 반영(변경분만), 실패 시 revert.
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: qk.me.accessibilitySettings() });
      const previous =
        qc.getQueryData<AccessibilitySettings>(qk.me.accessibilitySettings()) ??
        DEFAULT_ACCESSIBILITY;
      const optimistic: AccessibilitySettings = { ...previous, ...input };
      qc.setQueryData(qk.me.accessibilitySettings(), optimistic);
      applyIfChanged(previous, optimistic);
      return { previous };
    },
    onError: (_err, _input, ctx) => {
      const previous = ctx?.previous;
      if (previous) {
        const current = qc.getQueryData<AccessibilitySettings>(qk.me.accessibilitySettings());
        qc.setQueryData(qk.me.accessibilitySettings(), previous);
        applyIfChanged(current, previous);
      }
    },
    onSuccess: (data) => {
      // onMutate 가 이미 낙관적으로 적용했으므로, 서버 응답이 동일하면 applyIfChanged 가 skip 한다
      // (F10 — PATCH 1회당 DOM write 최대 1회).
      const current = qc.getQueryData<AccessibilitySettings>(qk.me.accessibilitySettings());
      qc.setQueryData(qk.me.accessibilitySettings(), data);
      applyIfChanged(current, data);
    },
  });
}
