import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ListNotificationPreferencesResponse,
  NotificationChannel,
  NotificationEventType,
  NotificationPreference,
  UpsertNotificationPreferenceRequest,
} from '@qufox/shared-types';
import { apiRequest } from '../../lib/api';
import { qk } from '../../lib/query-keys';

export const HARDCODED_DEFAULTS: Record<NotificationEventType, NotificationChannel> = {
  MENTION: 'BOTH',
  REPLY: 'BOTH',
  REACTION: 'TOAST',
  DIRECT: 'BOTH',
  FRIEND_REQUEST: 'BOTH',
};

export interface ResolvedDelivery {
  toast: boolean;
  browser: boolean;
}

export function channelToDelivery(channel: NotificationChannel): ResolvedDelivery {
  return {
    toast: channel === 'TOAST' || channel === 'BOTH',
    browser: channel === 'BROWSER' || channel === 'BOTH',
  };
}

/**
 * Task-019-D: resolve the effective delivery channel for (workspaceId,
 * eventType) given the user's preference list. 3-step fallback:
 * workspace-specific → global → hardcoded default. Mirrors
 * `NotificationPreferencesService.resolveChannel` on the backend so
 * client-side gating and server-side audit stay in sync.
 */
export function resolveChannel(
  prefs: NotificationPreference[] | undefined,
  workspaceId: string | null,
  eventType: NotificationEventType,
): NotificationChannel {
  if (prefs && prefs.length > 0) {
    const specific = prefs.find((p) => p.workspaceId === workspaceId && p.eventType === eventType);
    if (specific) return specific.channel;
    const global = prefs.find((p) => p.workspaceId === null && p.eventType === eventType);
    if (global) return global.channel;
  }
  return HARDCODED_DEFAULTS[eventType];
}

export function useNotificationPreferences() {
  return useQuery({
    queryKey: qk.me.notificationPreferences(),
    queryFn: async () => {
      const res = await apiRequest<ListNotificationPreferencesResponse>(
        '/me/notification-preferences',
        { method: 'GET' },
      );
      return res.preferences;
    },
    staleTime: 60_000,
  });
}

export function useUpsertNotificationPreference() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpsertNotificationPreferenceRequest) => {
      return apiRequest<{ id: string }>('/me/notification-preferences', {
        method: 'PUT',
        body: input,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.me.notificationPreferences() });
    },
  });
}
