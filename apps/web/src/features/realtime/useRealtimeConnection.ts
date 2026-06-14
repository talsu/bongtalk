import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type {
  DndScheduleResponse,
  GlobalNotificationSettings,
  NotificationPreference,
} from '@qufox/shared-types';
import { connect, disconnect, getLastEventId, setLastEventId } from '../../lib/socket';
import { shouldSuppressNotificationToast } from '../notifications/notificationDndGate';
import { getAccessToken, forceLogout } from '../../lib/api';
import { useUI } from '../../stores/ui-store';
import { useAuth } from '../auth/AuthProvider';
import { installRealtimeDispatcher, DISPATCHED_EVENTS } from './dispatcher';
import { installChannelSync } from './useChannelSync';
import { qk } from '../../lib/query-keys';
import { resolveChannel } from '../notifications/useNotificationPreferences';
import { useFaviconBadge } from '../notifications/useFaviconBadge';
import { useBadgeResync } from '../notifications/useBadgeResync';
import { usePresenceActivity } from '../presence/usePresenceActivity';
import type { Socket } from 'socket.io-client';

// 072 백로그 S-H (N6-3): 'failed' = socket.io Manager 의 reconnectionAttempts(10) 소진 후
// 종단 상태. 'disconnected'(일시 끊김·자동 재연결 중)와 구분해 배너가 "새로고침"을 안내한다.
export type RealtimeStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'failed';

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
  // S73 (D14 / FR-PS-17): mousemove/keydown → presence:activity(30s 스로틀). 서버가
  // IDLE→ONLINE 복귀 + 600s 무활동 IDLE 자동 전이를 처리한다.
  usePresenceActivity(socket);
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
    // 072 백로그 S-H (N6-3): Manager 가 reconnectionAttempts(10) 를 모두 소진하면
    // reconnect_failed 를 emit 한다. 이는 **종단** 상태다 — socket.io Manager 는 이후 더 이상
    // 자동 재시도를 스케줄하지 않으므로 'connect' 가 다시 발화되지 않는다. 복구 경로는 (a)
    // 배너의 새로고침(전체 reload → 새 connect()) 또는 (b) 로그인 세션 변경(user.id)으로 이
    // effect 가 재실행될 때뿐(토큰 silent-refresh 는 같은 user.id 라 재실행 안 됨). 'failed'
    // 종단 상태로 전이해 배너가 "새로고침" 액션을 노출하게 한다(일시 'disconnected' 와 구분).
    socket.io.on('reconnect_failed', () => setStatus('failed'));

    // S77c (D14 / FR-PS-16): 계정 비활성화 시 서버가 session:revoked 를 사용자 룸에 emit 한 직후
    // 소켓을 강제 disconnect 한다. 이 이벤트를 받으면 access 토큰을 비우고 강제 로그아웃을 통지해
    // (forceLogout → AuthProvider) 자동 로그아웃 + /login 라우팅을 트리거한다. reason 무관하게
    // 처리한다(현재는 account_deactivated 단일 — 향후 관리자 강제 로그아웃 등 확장 대비).
    socket.on('session:revoked', () => {
      // 072 백로그 S-H (N6-3): 'revoked' 사유로 LoginPage 가 "다른 기기/관리자에 의해 로그아웃"
      // 배너를 띄우게 한다(종전 조용한 리다이렉트 → 안내).
      forceLogout('revoked');
      if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
        window.history.pushState({}, '', '/login');
        window.dispatchEvent(new PopStateEvent('popstate'));
      }
    });

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
      // S76 (FR-PS-11): effective DND 여부를 dndSchedule 캐시의 server effective
      // preference 로 판정한다(스케줄 활성/수동 DND 모두 'dnd' 로 수렴 — 서버 단일 출처).
      // 캐시 miss(스케줄 미로딩)면 억제하지 않는다(보수적 폴백 — shouldSuppressNotificationToast).
      isDndSuppressed: () => {
        const dnd = qc.getQueryData<DndScheduleResponse>(qk.me.dndSchedule());
        return shouldSuppressNotificationToast(dnd?.preference);
      },
      // S76 fix-forward (F-B1 / FR-PS-10): 데스크톱 배너(notifDesktop) 토글 상태를 글로벌
      // 알림 설정 캐시에서 동기 읽는다. 캐시 미로딩(설정 페이지를 한 번도 안 연 세션)이면
      // 기본 true(ON) — 기존 동작 유지. notifDesktop===false 일 때만 데스크톱 토스트를 억제.
      isDesktopBannerEnabled: () => {
        const global = qc.getQueryData<GlobalNotificationSettings>(
          qk.me.globalNotificationSettings(),
        );
        return global?.notifDesktop ?? true;
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
    // 071-M1 D7 적발(플랫폼 잠복 버그): 종전 deps=[qc] 는 마운트 1회만 실행 — 하드
    // 페이지 로드에서는 silent refresh 가 끝나기 전이라 getAccessToken()===null 로
    // 조기 return 한 뒤 **영영 재시도하지 않아**, 새로고침/딥링크로 들어온 모든
    // 세션(모바일 전부)이 WebSocket 없이 동작했다(타이핑·프레즌스·즉시 수신 불능,
    // 목록 갱신은 폴링/리페치로 가려짐). user?.id 를 deps 에 추가 — AuthProvider 가
    // refresh 성공 시 user 를 세팅하므로(그 시점엔 토큰이 메모리에 존재) 그때 연결되고,
    // 로그아웃(user→null) 시 cleanup 이 disconnect 한다.
  }, [qc, user?.id]);

  return { status, replaying };
}
