import { useMemo } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Icon, Avatar } from '../../design-system/primitives';
import { useMyWorkspaces, useMembers } from '../workspaces/useWorkspaces';
import { useDmByUser } from './useDms';
import { MessageList } from '../messages/MessageList';
import { MessageComposer } from '../messages/MessageComposer';
import { useLiveMessages } from '../realtime/useLiveMessages';

/**
 * task-027-C: desktop /w/:slug/dm/:userId — 1:1 chat that reuses the
 * existing MessageList + MessageComposer primitives against the DM
 * channelId resolved from the URL (`?c=` query short-circuit) or the
 * /by-user lookup.
 */
export function DmChatPage(): JSX.Element {
  const { slug, userId } = useParams<{ slug: string; userId: string }>();
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const { data: mine } = useMyWorkspaces();
  const ws = useMemo(() => mine?.workspaces.find((w) => w.slug === slug), [mine, slug]);
  const { data: members } = useMembers(ws?.id);

  const other = (members?.members ?? []).find((m) => m.userId === userId);

  const hintedChannelId = sp.get('c');
  const { data: byUser } = useDmByUser(ws?.id, hintedChannelId ? undefined : userId);
  const channelId = hintedChannelId ?? byUser?.channelId ?? null;

  useLiveMessages(ws?.id ?? '', channelId ?? '');

  return (
    <div
      data-testid="dm-chat-page"
      className="h-screen flex flex-col"
      style={{ background: 'var(--bg-chat)' }}
    >
      <header className="qf-topbar">
        <button
          type="button"
          data-testid="dm-back"
          aria-label="뒤로"
          onClick={() => navigate(`/w/${slug}/dm`)}
          className="qf-btn qf-btn--ghost qf-btn--icon qf-btn--sm"
        >
          <Icon name="chevron-left" size="sm" />
        </button>
        <Avatar name={other?.user.username ?? userId?.slice(0, 2) ?? '?'} size="sm" />
        <h2 className="qf-topbar__title">{other?.user.username ?? '…'}</h2>
      </header>
      {ws?.id && channelId ? (
        <>
          <MessageList workspaceId={ws.id} channelId={channelId} onOpenThread={() => undefined} />
          <MessageComposer workspaceId={ws.id} channelId={channelId} channelName="dm" />
        </>
      ) : (
        <div className="qf-empty p-[var(--s-6)]">
          <div className="font-semibold">DM을 불러오는 중…</div>
        </div>
      )}
    </div>
  );
}
