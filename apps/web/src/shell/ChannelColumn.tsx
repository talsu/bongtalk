import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Workspace } from '@qufox/shared-types';
import { ChannelList } from '../features/channels/ChannelList';
import { CreateCategoryModal } from '../features/channels/CreateCategoryModal';
import { useMentionInbox } from '../features/mentions/useMentions';
import { OnboardingCard } from '../features/onboarding/OnboardingCard';
import {
  DropdownRoot,
  DropdownTrigger,
  DropdownContent,
  DropdownItem,
  DropdownSeparator,
  Icon,
} from '../design-system/primitives';
import {
  useWorkspace,
  useCreateInvite,
  useLeaveWorkspace,
} from '../features/workspaces/useWorkspaces';
import { WorkspaceMembersModal } from '../features/workspaces/WorkspaceMembersModal';
import { useNotifications } from '../stores/notification-store';

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
  const navigate = useNavigate();
  const notify = useNotifications((s) => s.push);
  const [open, setOpen] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [membersModalOpen, setMembersModalOpen] = useState(false);
  const [createCategoryOpen, setCreateCategoryOpen] = useState(false);
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
              <Icon name="chevron-down" size="sm" className="text-text-muted" />
            </button>
          </DropdownTrigger>
          <DropdownContent align="start">
            <DropdownItem onSelect={() => setMembersModalOpen(true)}>
              <span data-testid="ws-open-members">멤버 관리</span>
            </DropdownItem>
            {canManage ? (
              <DropdownItem onSelect={() => setCreateCategoryOpen(true)}>
                <span data-testid="ws-create-category">카테고리 추가</span>
              </DropdownItem>
            ) : null}
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
      <CreateCategoryModal
        workspaceId={workspace.id}
        open={createCategoryOpen}
        onClose={() => setCreateCategoryOpen(false)}
      />
      <WorkspaceMembersModal
        workspaceId={workspace.id}
        canManage={canManage}
        open={membersModalOpen}
        onClose={() => setMembersModalOpen(false)}
      />
    </div>
  );
}
