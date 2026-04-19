import { useEffect, useRef } from 'react';
import { useMembers } from '../features/workspaces/useWorkspaces';
import { useUI } from '../stores/ui-store';
import { useMarkChannelRead } from '../features/channels/useUnread';
import { MessageList } from '../features/messages/MessageList';
import { MessageComposer } from '../features/messages/MessageComposer';
import { useLiveMessages } from '../features/realtime/useLiveMessages';
import { Tooltip } from '../design-system/primitives';

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
  const { data: members } = useMembers(workspaceId);
  const memberCount = members?.members.length ?? 0;

  useLiveMessages(workspaceId, channelId);

  // Task-010-B: mark the channel read on open, debounced by 500ms so
  // rapid channel-switching doesn't thrash the server. The debouncer
  // also re-fires on channelId change so switching into a new channel
  // clears its unread.
  const markRead = useMarkChannelRead(workspaceId);
  const pendingRead = useRef<number | null>(null);
  useEffect(() => {
    if (pendingRead.current) window.clearTimeout(pendingRead.current);
    pendingRead.current = window.setTimeout(() => {
      markRead.mutate(channelId);
    }, 500);
    return () => {
      if (pendingRead.current) window.clearTimeout(pendingRead.current);
    };
    // markRead is a stable callback reference from useMutation; only
    // re-fire on channel change. (react-hooks plugin not installed so
    // we don't disable exhaustive-deps by rule name — the omission is
    // intentional and documented above.)
  }, [channelId]);

  return (
    <main
      data-testid={`msg-column-${channelName}`}
      className="flex min-w-0 flex-1 flex-col bg-background"
    >
      <header className="flex h-12 items-center justify-between border-b border-border-subtle px-4">
        <h2 className="text-sm font-semibold text-foreground">
          <span className="text-text-muted">#</span>&nbsp;{channelName}
        </h2>
        <Tooltip label={memberListOpen ? '멤버 목록 숨기기' : '멤버 목록 보기'} side="bottom">
          <button
            data-testid="toggle-member-list"
            aria-label="멤버 목록 토글"
            aria-pressed={memberListOpen}
            onClick={toggleMemberList}
            className="rounded-md p-2 text-text-muted hover:bg-bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="text-xs">{memberCount}명</span>
          </button>
        </Tooltip>
      </header>
      <MessageList workspaceId={workspaceId} channelId={channelId} />
      <MessageComposer workspaceId={workspaceId} channelId={channelId} channelName={channelName} />
    </main>
  );
}
