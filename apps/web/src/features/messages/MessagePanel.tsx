import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useDeleteMessage,
  useMessageHistory,
  useScrollFetch,
  useSendMessage,
  useUpdateMessage,
} from './useMessages';
import { useAuth } from '../auth/AuthProvider';
import type { MessageDto } from '@qufox/shared-types';

type Props = {
  workspaceId: string;
  channelId: string;
  channelName: string;
};

export function MessagePanel({ workspaceId, channelId, channelName }: Props): JSX.Element {
  const { user } = useAuth();
  const history = useMessageHistory(workspaceId, channelId);
  const { send, mutation: sendMutation } = useSendMessage(workspaceId, channelId);
  const delMut = useDeleteMessage(workspaceId, channelId);
  const updMut = useUpdateMessage(workspaceId, channelId);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null);

  // Flatten DESC pages to chronological ASC for render (oldest → newest).
  const messages = useMemo<MessageDto[]>(() => {
    const pages = history.data?.pages ?? [];
    const all = pages.flatMap((p) => p.items); // DESC
    return [...all].reverse();
  }, [history.data]);

  useScrollFetch(scrollRef, () => {
    if (history.hasNextPage && !history.isFetchingNextPage) {
      void history.fetchNextPage();
    }
  });

  // Auto-scroll to bottom on new-message arrival, but only when user is
  // already near the bottom (don't yank them while reading history).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  return (
    <section className="flex h-full flex-col" data-testid={`msg-panel-${channelName}`}>
      <header className="border-b border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700">
        # {channelName}
      </header>
      <div
        ref={scrollRef}
        data-testid="msg-list"
        className="flex-1 overflow-y-auto px-4 py-2 space-y-1 text-sm"
      >
        {history.hasNextPage && (
          <div className="py-1 text-center text-xs text-slate-400">
            {history.isFetchingNextPage ? 'loading older…' : 'scroll up for more'}
          </div>
        )}
        {messages.map((m) => (
          <MessageRow
            key={m.id}
            msg={m}
            isMine={m.authorId === user?.id}
            editing={editing?.id === m.id ? editing.content : null}
            onEditStart={() => setEditing({ id: m.id, content: m.content ?? '' })}
            onEditCancel={() => setEditing(null)}
            onEditSave={async (content) => {
              await updMut.mutateAsync({ msgId: m.id, content });
              setEditing(null);
            }}
            onDelete={() => {
              void delMut.mutate(m.id);
            }}
            onEditChange={(content) => setEditing((prev) => (prev ? { ...prev, content } : prev))}
          />
        ))}
      </div>
      <form
        data-testid="msg-composer"
        className="border-t border-slate-200 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = draft.trim();
          if (!trimmed) return;
          send(trimmed);
          setDraft('');
        }}
      >
        <textarea
          data-testid="msg-input"
          className="w-full resize-none rounded-md border border-slate-300 px-3 py-2 text-sm"
          placeholder={`Message #${channelName}`}
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              const trimmed = draft.trim();
              if (!trimmed) return;
              send(trimmed);
              setDraft('');
            }
          }}
        />
        <div className="mt-1 flex items-center justify-between text-xs text-slate-500">
          <span>{draft.length} / 4000 · Enter to send, Shift+Enter for newline</span>
          <button
            type="submit"
            data-testid="msg-send"
            disabled={sendMutation.isPending || draft.trim().length === 0}
            className="rounded bg-slate-900 px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </form>
    </section>
  );
}

function MessageRow(props: {
  msg: MessageDto;
  isMine: boolean;
  editing: string | null;
  onEditStart: () => void;
  onEditCancel: () => void;
  onEditSave: (content: string) => void | Promise<void>;
  onEditChange: (content: string) => void;
  onDelete: () => void;
}): JSX.Element {
  const { msg, isMine, editing } = props;
  if (msg.deleted) {
    return (
      <div
        data-testid={`msg-deleted-${msg.id}`}
        className="rounded bg-slate-50 px-2 py-1 text-xs italic text-slate-400"
      >
        (message deleted)
      </div>
    );
  }
  return (
    <div className="group flex items-start gap-2" data-testid={`msg-${msg.id}`}>
      <div className="flex-1">
        {editing !== null ? (
          <div className="flex items-center gap-2">
            <input
              data-testid={`msg-edit-${msg.id}`}
              className="flex-1 rounded border border-slate-300 px-2 py-1 text-sm"
              value={editing}
              onChange={(e) => props.onEditChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') props.onEditSave(editing);
                if (e.key === 'Escape') props.onEditCancel();
              }}
            />
            <button
              type="button"
              data-testid={`msg-edit-save-${msg.id}`}
              className="text-xs text-slate-600 underline"
              onClick={() => props.onEditSave(editing)}
            >
              save
            </button>
          </div>
        ) : (
          <>
            <span data-testid={`msg-content-${msg.id}`}>{msg.content}</span>
            {msg.edited && (
              <span className="ml-1 text-xs text-slate-400" data-testid={`msg-edited-${msg.id}`}>
                (edited)
              </span>
            )}
          </>
        )}
      </div>
      {isMine && editing === null && (
        <div className="flex gap-1 opacity-0 group-hover:opacity-100">
          <button
            type="button"
            data-testid={`msg-edit-btn-${msg.id}`}
            className="text-xs text-slate-500"
            onClick={props.onEditStart}
          >
            edit
          </button>
          <button
            type="button"
            data-testid={`msg-delete-${msg.id}`}
            className="text-xs text-red-500"
            onClick={props.onDelete}
          >
            delete
          </button>
        </div>
      )}
    </div>
  );
}
