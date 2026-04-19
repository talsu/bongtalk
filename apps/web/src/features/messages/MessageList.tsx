import { useEffect, useMemo, useRef } from 'react';
import type { MessageDto } from '@qufox/shared-types';
import { useAuth } from '../auth/AuthProvider';
import { useMembers } from '../workspaces/useWorkspaces';
import {
  useDeleteMessage,
  useMessageHistory,
  useScrollFetch,
  useUpdateMessage,
} from './useMessages';
import { MessageItem } from './MessageItem';
import { Scrollable } from '../../design-system/primitives';

type Props = {
  workspaceId: string;
  channelId: string;
};

/**
 * The scrollable body of the message column. Infinite-scroll upward via
 * `useScrollFetch`. Virtualization (react-virtual) is prepared by the
 * surrounding `<Scrollable>` but kept off by default — the 50-message
 * page size keeps DOM cost trivial until we have real steady-state data.
 */
export function MessageList({ workspaceId, channelId }: Props): JSX.Element {
  const { user } = useAuth();
  const { data: members } = useMembers(workspaceId);
  const history = useMessageHistory(workspaceId, channelId);
  const delMut = useDeleteMessage(workspaceId, channelId);
  const updMut = useUpdateMessage(workspaceId, channelId);
  const scrollRef = useRef<HTMLDivElement>(null);

  const messages = useMemo<MessageDto[]>(() => {
    const pages = history.data?.pages ?? [];
    const all = pages.flatMap((p) => p.items);
    return [...all].reverse(); // DESC pages → ASC render order
  }, [history.data]);

  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members?.members ?? []) map.set(m.userId, m.user.username);
    return map;
  }, [members]);

  useScrollFetch(scrollRef, () => {
    if (history.hasNextPage && !history.isFetchingNextPage) {
      void history.fetchNextPage();
    }
  });

  // Auto-scroll to bottom when new messages arrive, unless user is reading
  // older history (i.e. not already near the bottom).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  return (
    <Scrollable
      ref={scrollRef}
      data-testid="msg-list"
      role="log"
      aria-live="polite"
      aria-label="메시지"
      className="flex-1 px-2 py-3"
    >
      {history.hasNextPage ? (
        <div className="py-2 text-center text-[11px] text-text-muted">
          {history.isFetchingNextPage ? '이전 메시지 불러오는 중…' : '스크롤해 더 보기'}
        </div>
      ) : null}
      {messages.length === 0 ? (
        <div className="py-8 text-center text-xs text-text-muted">
          아직 메시지가 없습니다. 아래에서 첫 메시지를 보내보세요.
        </div>
      ) : null}
      {messages.map((m) => (
        <MessageItem
          key={m.id}
          msg={m}
          isMine={m.authorId === user?.id}
          authorName={nameById.get(m.authorId)}
          onEditSave={async (content) => {
            await updMut.mutateAsync({ msgId: m.id, content });
          }}
          onDelete={() => {
            void delMut.mutate(m.id);
          }}
        />
      ))}
    </Scrollable>
  );
}
