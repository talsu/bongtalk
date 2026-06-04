import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { NotificationPreference } from '@qufox/shared-types';
import { connect, disconnect, getLastEventId, setLastEventId } from '../../lib/socket';
import { getAccessToken } from '../../lib/api';
import { useUI } from '../../stores/ui-store';
import { useAuth } from '../auth/AuthProvider';
import { installRealtimeDispatcher, DISPATCHED_EVENTS } from './dispatcher';
import { installChannelSync } from './useChannelSync';
import { qk } from '../../lib/query-keys';
import { resolveChannel } from '../notifications/useNotificationPreferences';
import { useFaviconBadge } from '../notifications/useFaviconBadge';
import { useBadgeResync } from '../notifications/useBadgeResync';
import type { Socket } from 'socket.io-client';

export type RealtimeStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';

/**
 * Owns the single-app socket lifecycle. Installed once at the Shell root.
 * A central `dispatcher` is the ONLY thing that mutates React Query state
 * in response to server events — other hooks consume the resulting cache.
 *
 * Connection-level side-effects kept here:
 *   - tracking the most recent envelope id into localStorage for replay
 *   - presence heartbeat every 15s
 *   - status flag for the UI
 */
export function useRealtimeConnection(): { status: RealtimeStatus; replaying: boolean } {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [status, setStatus] = useState<RealtimeStatus>('idle');
  const [replaying, setReplaying] = useState(false);
  // S47 (FR-MN-20): 배지 재동기화 hook 이 소켓 reconnect 를 구독하도록 현재 소켓을
  // state 로 노출한다. favicon/title 배지(useFaviconBadge)는 소켓과 무관하게 마운트.
  const [socket, setSocket] = useState<Socket | null>(null);
  useFaviconBadge();
  useBadgeResync(socket);
  // AuthProvider holds `user` in React state (never in the query cache).
  // The dispatcher is installed once per socket lifetime and needs a
  // stable getter — capture the current viewer via a ref that tracks
  // the latest user without forcing a dispatcher reinstall.
  const viewerIdRef = useRef<string | null>(user?.id ?? null);
  viewerIdRef.current = user?.id ?? null;

  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;

    setStatus('connecting');
    const socket = connect(token, getLastEventId());
    setSocket(socket);

    socket.on('connect', () => setStatus('connected'));
    socket.on('disconnect', () => setStatus('disconnected'));
    socket.on('connect_error', () => setStatus('disconnected'));

    // S72 fix-forward (reviewer H1 = realtime BLOCKER): 워크스페이스 삭제 시 서버는
    // ws:workspace_deleted 를 룸에 emit 한 직후 같은 이벤트로 룸 소켓을 강제 disconnect
    // 한다(MembershipRevocationListener). 서버 emit 순서를 disconnect 보다 앞으로 고정했지만,
    // 네트워크/노드 경합으로 disconnect 가 먼저 도착하면 ws:workspace_deleted dispatcher
    // 핸들러가 영영 실행되지 못해(워크스페이스 스코프 이벤트는 reconnect replay 안 됨)
    // 사이드바·라우팅이 stale 해진다. disconnect 직전 서버가 보내는
    // connection.error{code:'workspace_deleted'} 를 이중 안전망으로 받아, 현재 보고 있던
    // 워크스페이스면 홈(/dm)으로 리다이렉트하고 내 워크스페이스 목록을 무효화한다(슬러그는
    // 현재 경로에서, id 는 캐시된 목록에서 역해석).
    socket.on('connection.error', (e: { code?: string } | undefined) => {
      if (e?.code !== 'workspace_deleted') return;
      qc.invalidateQueries({ queryKey: ['workspaces', 'mine'] });
      if (typeof window === 'undefined') return;
      const match = /^\/w\/([^/]+)/.exec(window.location.pathname);
      const activeSlug = match?.[1];
      if (!activeSlug) return;
      const mine = qc.getQueryData<{ workspaces: Array<{ id: string; slug: string }> }>([
        'workspaces',
        'mine',
      ]);
      const active = mine?.workspaces.find((w) => w.slug === activeSlug);
      if (active) qc.invalidateQueries({ queryKey: qk.workspaces.detail(active.id) });
      window.history.pushState({}, '', '/dm');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    // Cache-mutation side of realtime (single dispatcher).
    // DispatcherContext gives the unread-bump path awareness of both
    // the viewer and the currently-open channel so the dispatcher skips
    // bumps for self-authored messages AND for messages that arrive on
    // the channel the user is actively reading (Discord semantic: "I
    // saw it, it's read"). MessageColumn writes activeChannelId into
    // the UI store on mount / unmount.
    const detach = installRealtimeDispatcher(socket, qc, {
      // Was `qc.getQueryData(['auth','me'])` — but AuthProvider keeps
      // the user in React state, not the query cache, so that lookup
      // always returned undefined and the unread-bump block below was
      // silently skipped for every incoming message. Read from the
      // ref populated above.
      viewerId: () => viewerIdRef.current,
      activeChannelId: () => useUI.getState().activeChannelId,
      // Task-011-B: resolve mention → URL for the toast "jump" action.
      // The channel-list cache holds name; we resolve slug from the
      // workspace list which is always fetched after auth. If any lookup
      // fails (dispatcher fires before the cache is populated), return
      // null so the toast still shows — just without a clickable jump.
      resolveMentionUrl: ({ workspaceId, channelId, messageId }) => {
        const workspaces = qc.getQueryData<{ workspaces: Array<{ id: string; slug: string }> }>([
          'workspaces',
        ]);
        const wsSlug = workspaces?.workspaces.find((w) => w.id === workspaceId)?.slug;
        if (!wsSlug) return null;
        const channels = qc.getQueryData<{
          categories: Array<{ channels: Array<{ id: string; name: string }> }>;
          uncategorized: Array<{ id: string; name: string }>;
        }>(['workspaces', workspaceId, 'channels']);
        const all = [
          ...(channels?.uncategorized ?? []),
          ...(channels?.categories.flatMap((c) => c.channels) ?? []),
        ];
        const chName = all.find((c) => c.id === channelId)?.name;
        if (!chName) return null;
        return `/w/${wsSlug}/${chName}?msg=${encodeURIComponent(messageId)}`;
      },
      navigate: (url: string) => {
        // useNavigate can't be used outside a React component; fall back
        // to pushState + a custom event so the Router picks it up.
        window.history.pushState({}, '', url);
        window.dispatchEvent(new PopStateEvent('popstate'));
      },
      // Task-019-D: look up the user's notification preference for
      // (workspace, eventType) from the already-fetched cache. The
      // resolver is synchronous; miss → hardcoded fallback.
      resolveNotificationChannel: (workspaceId, eventType) => {
        const prefs = qc.getQueryData<NotificationPreference[]>(qk.me.notificationPreferences());
        return resolveChannel(prefs, workspaceId, eventType);
      },
    });

    // S10 (FR-RT-06/07/23): 재연결 동기화 오케스트레이터. dispatcher 와 같은
    // 소켓 생명주기로 설치합니다. 채널 → wsId 라우팅은 이미 fetch 된
    // workspaces/channels 캐시에서 해석합니다(miss 면 gap-fetch 없이 SYNCED
    // 종료 + 버퍼 flush — 다음 채널 진입의 정상 로드가 흡수).
    const detachSync = installChannelSync(socket, qc, {
      resolveChannelRoute: (channelId: string) => {
        const workspaces = qc.getQueryData<{ workspaces: Array<{ id: string }> }>(['workspaces']);
        for (const w of workspaces?.workspaces ?? []) {
          const channels = qc.getQueryData<{
            categories: Array<{ channels: Array<{ id: string }> }>;
            uncategorized: Array<{ id: string }>;
          }>(['workspaces', w.id, 'channels']);
          const all = [
            ...(channels?.uncategorized ?? []),
            ...(channels?.categories.flatMap((c) => c.channels) ?? []),
          ];
          if (all.some((c) => c.id === channelId)) return { wsId: w.id };
        }
        // 워크스페이스 채널에서 못 찾으면 DM(global) 로 라우팅(wsId=null).
        return { wsId: null };
      },
    });

    // Independent side: track envelope.id into localStorage so a later
    // reconnect can ask the server for replay-after.
    const trackId = (e: { id?: string }): void => {
      if (typeof e?.id === 'string') setLastEventId(e.id);
    };
    for (const t of DISPATCHED_EVENTS) socket.on(t, trackId);

    socket.on('replay.complete', () => setReplaying(false));
    socket.on('replay.truncated', () => setReplaying(false));

    const ping = setInterval(() => socket.emit('presence:ping'), 15_000);
    if (getLastEventId()) setReplaying(true);

    return () => {
      clearInterval(ping);
      for (const t of DISPATCHED_EVENTS) socket.off(t, trackId);
      detachSync();
      detach();
      disconnect();
      setSocket(null);
    };
  }, [qc]);

  return { status, replaying };
}
