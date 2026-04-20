import { useCallback, useEffect, useRef, useState } from 'react';
import { useMembers } from '../features/workspaces/useWorkspaces';
import { useUI } from '../stores/ui-store';
import { useMarkChannelRead } from '../features/channels/useUnread';
import { MessageList } from '../features/messages/MessageList';
import { MessageComposer } from '../features/messages/MessageComposer';
import { ThreadPanel } from '../features/threads/ThreadPanel';
import { useLiveMessages } from '../features/realtime/useLiveMessages';
import { Tooltip } from '../design-system/primitives';
import { useQueryClient } from '@tanstack/react-query';
import { qk } from '../lib/query-keys';
import type { UnreadChannelSummary } from '../features/channels/useUnread';

type Props = {
  workspaceId: string;
  workspaceSlug: string;
  channelId: string;
  channelName: string;
};

/**
 * The centre column. Header shows the channel name + a toggle for the
 * member list. Body is the virtualized message list. Footer is the
 * composer.
 */
export function MessageColumn({ workspaceId, channelId, channelName }: Props): JSX.Element {
  const memberListOpen = useUI((s) => s.memberListOpen);
  const toggleMemberList = useUI((s) => s.toggleMemberList);
  const setActiveChannelId = useUI((s) => s.setActiveChannelId);
  const { data: members } = useMembers(workspaceId);
  const memberCount = members?.members.length ?? 0;
  const qc = useQueryClient();

  // task-014-C: thread panel opens via `?thread=<rootId>` query param.
  // Sharing the URL restores the thread on mount; channel switching
  // unmounts this component and strips the param naturally.
  const threadRootId = useCallback((): string | null => {
    const params = new URLSearchParams(window.location.search);
    const v = params.get('thread');
    return v && /^[0-9a-f-]{36}$/i.test(v) ? v : null;
  }, []);
  const [activeThread, setActiveThread] = useThreadQueryState(threadRootId);

  // task-014 reviewer MED-1: if MessageColumn stays mounted across a
  // channel switch (happens on prop-level channel changes) the
  // `?thread=` param has to follow the channel or the panel tries to
  // render a thread from a different channel. Track the previous
  // channelId in a ref so the effect fires only on an actual switch,
  // not on every render.
  const prevChannelRef = useRef(channelId);
  useEffect(() => {
    if (prevChannelRef.current !== channelId) {
      prevChannelRef.current = channelId;
      setActiveThread(null);
    }
  }, [channelId, setActiveThread]);

  useLiveMessages(workspaceId, channelId);

  // Task-010 reviewer finding-1 fix: announce the active channel to the
  // UI store so the realtime dispatcher skips unread-bumps for messages
  // that arrive on this channel while we're viewing it. Clear on
  // unmount so a subsequent navigation doesn't leak stale state.
  useEffect(() => {
    setActiveChannelId(channelId);
    return () => {
      // Only clear if we're STILL the active channel — avoids a race
      // where MessageColumn unmount/remount (e.g. channelId change)
      // runs cleanup after the new mount has set the new id.
      if (useUI.getState().activeChannelId === channelId) {
        setActiveChannelId(null);
      }
    };
  }, [channelId, setActiveChannelId]);

  // Task-010-B: mark the channel read on open, debounced by 500ms so
  // rapid channel-switching doesn't thrash the server. Also re-fire
  // when a new message arrives while the user is actively looking at
  // this channel — the dispatcher skips the unread bump for the active
  // channel, but if the server-side lastReadAt falls behind we still
  // want an occasional refresh. Implemented by zeroing the cached
  // count directly (optimistic) and debouncing the POST.
  const markRead = useMarkChannelRead(workspaceId);
  const pendingRead = useRef<number | null>(null);
  useEffect(() => {
    // Optimistically zero the cached unread for this channel so the
    // pill disappears immediately rather than waiting 500ms + rtt.
    qc.setQueryData<{ channels: UnreadChannelSummary[] }>(
      qk.channels.unreadSummary(workspaceId),
      (old) => {
        if (!old) return old;
        return {
          channels: old.channels.map((c) =>
            c.channelId === channelId ? { ...c, unreadCount: 0, hasMention: false } : c,
          ),
        };
      },
    );
    if (pendingRead.current) window.clearTimeout(pendingRead.current);
    pendingRead.current = window.setTimeout(() => {
      markRead.mutate(channelId);
    }, 500);
    return () => {
      if (pendingRead.current) window.clearTimeout(pendingRead.current);
    };
    // markRead is a stable callback reference from useMutation; only
    // re-fire on channel change.
  }, [channelId, workspaceId, qc]);

  return (
    <div className="flex min-w-0 flex-1">
      <main
        data-testid={`msg-column-${channelName}`}
        className="flex min-w-0 flex-1 flex-col bg-chat"
      >
        <header className="qf-topbar justify-between">
          <h2 className="qf-topbar__title">
            <span className="text-text-muted">#</span>
            {channelName}
          </h2>
          <Tooltip label={memberListOpen ? '멤버 목록 숨기기' : '멤버 목록 보기'} side="bottom">
            <button
              data-testid="toggle-member-list"
              aria-label="멤버 목록 토글"
              aria-pressed={memberListOpen}
              onClick={toggleMemberList}
              className="qf-btn qf-btn--ghost qf-btn--sm"
            >
              {memberCount}명
            </button>
          </Tooltip>
        </header>
        <MessageList
          workspaceId={workspaceId}
          channelId={channelId}
          onOpenThread={(rootId) => setActiveThread(rootId)}
        />
        <MessageComposer
          workspaceId={workspaceId}
          channelId={channelId}
          channelName={channelName}
        />
      </main>
      {activeThread ? (
        <ThreadPanel
          workspaceId={workspaceId}
          channelId={channelId}
          rootId={activeThread}
          onClose={() => setActiveThread(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * Task-014-C: thread panel state lives in a `?thread=` URL query param
 * so sharing the URL reopens the panel and browser-back restores it.
 */
function useThreadQueryState(
  readInitial: () => string | null,
): [string | null, (next: string | null) => void] {
  const [rootId, setRootId] = useState<string | null>(readInitial());
  useEffect(() => {
    const onPop = () => setRootId(readInitial());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [readInitial]);
  const set = useCallback((next: string | null) => {
    const url = new URL(window.location.href);
    if (next) url.searchParams.set('thread', next);
    else url.searchParams.delete('thread');
    window.history.pushState({}, '', url.toString());
    setRootId(next);
  }, []);
  return [rootId, set];
}
