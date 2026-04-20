import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Workspace } from '@qufox/shared-types';
import { ChannelList } from '../features/channels/ChannelList';
import { useMentionInbox } from '../features/mentions/useMentions';
import { OnboardingCard } from '../features/onboarding/OnboardingCard';
import {
  DropdownRoot,
  DropdownTrigger,
  DropdownContent,
  DropdownItem,
  DropdownSeparator,
} from '../design-system/primitives';
import {
  useWorkspace,
  useCreateInvite,
  useLeaveWorkspace,
  useMembers,
  useUpdateRole,
} from '../features/workspaces/useWorkspaces';
import { useNotifications } from '../stores/notification-store';
import { cn } from '../lib/cn';

type Props = {
  workspace: Pick<Workspace, 'id' | 'name' | 'slug'>;
  activeChannelName: string | null;
};

/**
 * 240px second column. Top: workspace name + settings dropdown. Below the
 * header, a collapsible members panel (so legacy role-change E2Es can
 * target `role-select-{username}` without needing a separate settings page).
 * Middle: the ChannelList. Bottom: nothing — global user controls live on
 * the BottomBar.
 */
export function ChannelColumn({ workspace, activeChannelName }: Props): JSX.Element {
  const { data: wsData } = useWorkspace(workspace.id);
  const myRole = wsData?.myRole ?? 'MEMBER';
  const canManage = myRole === 'ADMIN' || myRole === 'OWNER';
  const createInvite = useCreateInvite(workspace.id);
  const leaveMut = useLeaveWorkspace(workspace.id);
  const roleMut = useUpdateRole(workspace.id);
  const { data: members } = useMembers(workspace.id);
  const navigate = useNavigate();
  const notify = useNotifications((s) => s.push);
  const [open, setOpen] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  // Default to open for managers so the legacy role-change E2E flow (clicks
  // the role-select dropdown without any intermediate "open members" step)
  // keeps working. Regular members see it collapsed by default.
  const [membersOpen, setMembersOpen] = useState(canManage);
  // Task-011-B: unread mention count across all channels the caller
  // can read. Dispatcher keeps this cache live as mention.received
  // events arrive over WS; opening a channel clears its mentions via
  // the shared lastReadAt stamp (see MeMentionsService).
  const { data: mentionInbox } = useMentionInbox();
  const mentionCount = mentionInbox?.unreadCount ?? 0;

  return (
    <div
      data-testid="channel-column"
      className="flex w-60 shrink-0 flex-col border-r border-border-subtle bg-bg-subtle"
    >
      <div className="flex h-12 items-center border-b border-border-subtle">
        <DropdownRoot open={open} onOpenChange={setOpen}>
          <DropdownTrigger asChild>
            <button
              data-testid="ws-header-trigger"
              className="flex h-full flex-1 items-center justify-between px-3 text-sm font-semibold text-foreground hover:bg-bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span data-testid="ws-name" className="truncate">
                {workspace.name}
              </span>
              <span aria-hidden className="text-text-muted">
                ▾
              </span>
            </button>
          </DropdownTrigger>
          <DropdownContent align="start">
            <DropdownItem onSelect={() => setMembersOpen((v) => !v)}>
              {membersOpen ? '멤버 숨기기' : '멤버 관리'}
            </DropdownItem>
            {myRole !== 'OWNER' ? (
              <>
                <DropdownSeparator />
                <DropdownItem
                  danger
                  onSelect={async () => {
                    try {
                      await leaveMut.mutateAsync();
                      navigate('/', { replace: true });
                    } catch (err) {
                      notify({
                        variant: 'danger',
                        title: '나가기 실패',
                        body: (err as Error).message,
                      });
                    }
                  }}
                >
                  <span data-testid="ws-leave">워크스페이스 나가기</span>
                </DropdownItem>
              </>
            ) : null}
          </DropdownContent>
        </DropdownRoot>
        {canManage ? (
          <button
            data-testid="ws-invite"
            aria-label="멤버 초대 링크 생성"
            onClick={async () => {
              try {
                const res = await createInvite.mutateAsync({ maxUses: 10 });
                setInviteUrl(res.url);
                await navigator.clipboard?.writeText(res.url).catch(() => undefined);
                notify({ variant: 'success', title: '초대 링크 복사됨', body: res.url });
              } catch (err) {
                notify({
                  variant: 'danger',
                  title: '초대 생성 실패',
                  body: (err as Error).message,
                });
              }
            }}
            className="mr-2 rounded-md px-2 py-1 text-xs text-text-muted hover:bg-bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            +초대
          </button>
        ) : null}
      </div>
      {inviteUrl ? (
        <div
          data-testid="ws-invite-url"
          className="border-b border-border-subtle bg-bg-accent px-3 py-2 text-[10px] break-all text-foreground"
        >
          {inviteUrl}
        </div>
      ) : null}
      {membersOpen ? (
        <ul
          data-testid="members-list"
          aria-label="워크스페이스 멤버"
          className="max-h-40 overflow-y-auto border-b border-border-subtle px-2 py-2 text-xs"
        >
          {(members?.members ?? []).map((m) => (
            <li
              key={m.userId}
              data-testid={`member-${m.user.username}`}
              className="flex items-center justify-between py-1"
            >
              <span className={cn('truncate', m.role === 'OWNER' && 'font-semibold')}>
                {m.user.username}
              </span>
              {canManage && m.role !== 'OWNER' ? (
                <select
                  data-testid={`role-select-${m.user.username}`}
                  value={m.role}
                  onChange={async (e) => {
                    try {
                      await roleMut.mutateAsync({
                        userId: m.userId,
                        role: e.target.value as 'ADMIN' | 'MEMBER',
                      });
                    } catch (err) {
                      notify({
                        variant: 'danger',
                        title: '역할 변경 실패',
                        body: (err as Error).message,
                      });
                    }
                  }}
                  className="rounded border border-border-subtle bg-bg-surface px-1 py-0.5 text-[10px]"
                >
                  <option value="MEMBER">MEMBER</option>
                  <option value="ADMIN">ADMIN</option>
                </select>
              ) : (
                <span data-testid={`role-${m.user.username}`} className="text-text-muted">
                  {m.role}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {mentionCount > 0 ? (
        <div
          data-testid="mention-badge"
          aria-label={`읽지 않은 멘션 ${mentionCount}개`}
          className="flex items-center justify-between border-b border-border-subtle bg-bg-accent px-3 py-1.5 text-xs text-foreground"
        >
          <span>@ 멘션</span>
          <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold text-fg-primary">
            {mentionCount > 99 ? '99+' : mentionCount}
          </span>
        </div>
      ) : null}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        <OnboardingCard />
        <ChannelList
          workspaceId={workspace.id}
          workspaceSlug={workspace.slug}
          canManage={canManage}
          activeChannelName={activeChannelName}
        />
      </div>
    </div>
  );
}
