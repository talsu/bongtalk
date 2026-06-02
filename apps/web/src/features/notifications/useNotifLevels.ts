import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ChannelNotificationPreference,
  GlobalNotificationSettings,
  MuteDurationKey,
  NotifLevel,
  PutChannelNotificationPreferenceRequest,
  PutServerNotificationPreferenceRequest,
  ServerNotificationPreference,
  UpdateGlobalNotificationSettingsRequest,
} from '@qufox/shared-types';
import { apiRequest } from '../../lib/api';
import { qk } from '../../lib/query-keys';

/**
 * S46 (D06 / FR-MN-05/06/07/08): NotifLevel 3계층 알림 설정 hooks.
 *
 * 글로벌(/me/settings/notifications) → 서버(/workspaces/:id/notification-preferences)
 * → 채널(/workspaces/:id/channels/:chid/notification-preferences). 기존
 * useNotificationPreferences(TOAST/BROWSER)와는 별개 축이라 그대로 둔다.
 */

// ── 글로벌 ───────────────────────────────────────────────────────────────────

export function useGlobalNotificationSettings() {
  return useQuery({
    queryKey: qk.me.globalNotificationSettings(),
    queryFn: () =>
      apiRequest<GlobalNotificationSettings>('/me/settings/notifications', { method: 'GET' }),
    staleTime: 60_000,
  });
}

export function useUpdateGlobalNotificationSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateGlobalNotificationSettingsRequest) =>
      apiRequest<GlobalNotificationSettings>('/me/settings/notifications', {
        method: 'PATCH',
        body: input,
      }),
    onSuccess: (data) => {
      qc.setQueryData(qk.me.globalNotificationSettings(), data);
    },
  });
}

// ── 서버 ─────────────────────────────────────────────────────────────────────

export function useServerNotificationPref(wsId: string) {
  return useQuery({
    queryKey: qk.me.serverNotificationPref(wsId),
    queryFn: () =>
      apiRequest<ServerNotificationPreference>(`/workspaces/${wsId}/notification-preferences`, {
        method: 'GET',
      }),
    enabled: Boolean(wsId),
    staleTime: 30_000,
  });
}

export function usePutServerNotificationPref(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PutServerNotificationPreferenceRequest) =>
      apiRequest<ServerNotificationPreference>(`/workspaces/${wsId}/notification-preferences`, {
        method: 'PUT',
        body: input,
      }),
    onSuccess: (data) => {
      qc.setQueryData(qk.me.serverNotificationPref(wsId), data);
    },
  });
}

export function useUnmuteServer(wsId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiRequest<ServerNotificationPreference>(`/workspaces/${wsId}/notification-preferences`, {
        method: 'DELETE',
      }),
    onSuccess: (data) => {
      qc.setQueryData(qk.me.serverNotificationPref(wsId), data);
    },
  });
}

// ── 채널 ─────────────────────────────────────────────────────────────────────

export function useChannelNotificationPref(wsId: string, chId: string) {
  return useQuery({
    queryKey: qk.me.channelNotificationPref(wsId, chId),
    queryFn: () =>
      apiRequest<ChannelNotificationPreference>(
        `/workspaces/${wsId}/channels/${chId}/notification-preferences`,
        { method: 'GET' },
      ),
    enabled: Boolean(wsId && chId),
    staleTime: 30_000,
  });
}

export function usePutChannelNotificationPref(wsId: string, chId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PutChannelNotificationPreferenceRequest) =>
      apiRequest<ChannelNotificationPreference | { categoryId: string; channelIds: string[] }>(
        `/workspaces/${wsId}/channels/${chId}/notification-preferences`,
        { method: 'PUT', body: input },
      ),
    onSuccess: () => {
      // 채널 단건 + 사이드바 뮤트(me/mutes)를 함께 무효화한다(카테고리 일괄도 포함).
      qc.invalidateQueries({ queryKey: qk.me.channelNotificationPref(wsId, chId) });
      qc.invalidateQueries({ queryKey: ['me', 'mutes'] });
    },
  });
}

// ── 공유 상수 (UI 라디오/기간 선택) ──────────────────────────────────────────

/** S46: NotifLevel 라디오 옵션(라벨은 PRD 카피). */
export const NOTIF_LEVEL_OPTIONS: ReadonlyArray<{
  value: NotifLevel;
  label: string;
  hint: string;
}> = [
  { value: 'ALL', label: '모든 메시지', hint: '모든 새 메시지에 알림을 받습니다.' },
  {
    value: 'MENTIONS',
    label: '멘션만',
    hint: '직접 @멘션과 키워드에만 알림을 받습니다.',
  },
  {
    value: 'NOTHING',
    label: '알림 없음',
    hint: '메시지는 읽기 전까지 배지로 표시되나 알림은 오지 않습니다.',
  },
];

/** S46 (FR-MN-06/07/08): 뮤트 기간 선택지(서버/채널 공통). */
export const MUTE_DURATION_OPTIONS: ReadonlyArray<{ value: MuteDurationKey; label: string }> = [
  { value: '15m', label: '15분' },
  { value: '1h', label: '1시간' },
  { value: '8h', label: '8시간' },
  { value: '24h', label: '24시간' },
  { value: 'forever', label: '영구' },
];
