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
  const [membersOpen, setMembersOpen] = useState(canManage);
  const { data: mentionInbox } = useMentionInbox();
  const mentionCount = mentionInbox?.unreadCount ?? 0;

  return (
    <div data-testid="channel-column" className="qf-channellist">
      <div className="qf-channellist__head">
        <DropdownRoot open={open} onOpenChange={setOpen}>
          <DropdownTrigger asChild>
            <button
              data-testid="ws-header-trigger"
              className="flex flex-1 items-center justify-between gap-2 bg-transparent text-left text-text-strong hover:text-text-strong"
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
            className="qf-btn qf-btn--ghost qf-btn--sm"
          >
            + 초대
          </button>
        ) : null}
      </div>
      {inviteUrl ? (
        <div
          data-testid="ws-invite-url"
          className="border-b border-border-subtle bg-accent-subtle px-3 py-2 text-[length:var(--fs-11)] break-all text-text"
        >
          {inviteUrl}
        </div>
      ) : null}
      {membersOpen ? (
        <ul
          data-testid="members-list"
          aria-label="워크스페이스 멤버"
          className="max-h-40 overflow-y-auto border-b border-border-subtle px-2 py-2 text-[length:var(--fs-13)]"
        >
          {(members?.members ?? []).map((m) => (
            <li
              key={m.userId}
              data-testid={`member-${m.user.username}`}
              className="flex items-center justify-between py-1 text-text-secondary"
            >
              <span
                className={cn('truncate', m.role === 'OWNER' && 'font-semibold text-text-strong')}
              >
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
                  className="qf-input qf-btn--sm !h-6 !w-auto !px-2 text-[length:var(--fs-11)]"
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
          className="flex items-center justify-between border-b border-border-subtle bg-accent-subtle px-3 py-1.5 text-[length:var(--fs-13)] text-text"
        >
          <span>@ 멘션</span>
          <span className="qf-badge qf-badge--count">
            {mentionCount > 99 ? '99+' : mentionCount}
          </span>
        </div>
      ) : null}
      <div className="qf-channellist__body">
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
