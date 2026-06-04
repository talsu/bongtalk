import { useState } from 'react';
import { Button } from '../../design-system/primitives';
import { useInvites } from '../workspaces/useWorkspaces';
import { CreateInviteModal } from '../workspaces/CreateInviteModal';

/**
 * S71 (D13 / FR-W09a · Fork-B): 워크스페이스 생성자(OWNER) 온보딩 CTA. 기본 채널 첫 진입 시
 * 빈 채널 empty state 위에 초대 CTA(CreateInviteModal 재사용)와 첫 메시지 유도를 오버레이한다.
 *
 * 표시 조건(파생 — 신규 컬럼/localStorage 불요):
 *   OWNER && 기본 채널 빈 상태(이 컴포넌트는 ChannelEmptyState 안에서만 렌더되므로 채널이
 *   비어 있음이 보장됨) && 워크스페이스 초대 0개.
 * 첫 메시지 전송 시 채널이 비지 않아 empty state 자체가 사라지고, 첫 초대 생성 시 invite
 * count≥1 이 되어 CTA 가 숨는다(두 종료 조건 모두 파생 — 별도 상태 저장 없음).
 */
export function CreatorEmptyStateCta({
  workspaceId,
  isOwner,
}: {
  workspaceId: string;
  isOwner: boolean;
}): JSX.Element | null {
  const [inviteOpen, setInviteOpen] = useState(false);
  // 초대 목록(ADMIN+ 전용 — OWNER 충족). 로딩 중에는 CTA 를 숨겨 깜빡임을 피한다.
  const { data, isLoading } = useInvites(isOwner ? workspaceId : undefined);

  if (!isOwner) return null;
  if (isLoading || !data) return null;
  // 첫 초대를 만들면 invite count≥1 → CTA 숨김(Fork-B 종료 조건).
  if (data.invites.length > 0) return null;

  const focusComposer = (): void => {
    window.dispatchEvent(new CustomEvent('qufox.composer.focus'));
  };

  return (
    <div
      className="mt-[var(--s-5)] flex flex-col items-center gap-[var(--s-3)]"
      data-testid="creator-empty-cta"
    >
      <p className="text-text-strong text-[length:var(--fs-14)] font-medium">
        워크스페이스를 시작해보세요
      </p>
      <p className="text-text-muted text-[length:var(--fs-13)]">
        팀원을 초대하거나 첫 메시지를 남겨 대화를 시작하세요.
      </p>
      <div className="flex gap-[var(--s-2)]">
        <Button
          variant="primary"
          onClick={() => setInviteOpen(true)}
          data-testid="creator-cta-invite"
        >
          멤버 초대하기
        </Button>
        <Button variant="ghost" onClick={focusComposer} data-testid="creator-cta-first-message">
          첫 메시지 작성하기
        </Button>
      </div>
      <CreateInviteModal workspaceId={workspaceId} open={inviteOpen} onOpenChange={setInviteOpen} />
    </div>
  );
}
