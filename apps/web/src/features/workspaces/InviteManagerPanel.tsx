import { useState } from 'react';
import type { Invite } from '@qufox/shared-types';
import { Button } from '../../design-system/primitives';
import { useHardDeleteInvite, useInvites, useRevokeInvite } from './useWorkspaces';
import { CreateInviteModal } from './CreateInviteModal';

// S67 (D13 / FR-W17): 초대 관리 목록 — 생성자/생성일/만료/사용횟수/잔여/활성상태 +
// 비활성화(soft revoke) · 영구삭제(hard delete) 액션. ADMIN 은 전체, MODERATOR 는 본인
// 생성분(서버가 createdById 로 필터)만 받는다.
export function InviteManagerPanel({ workspaceId }: { workspaceId: string }): JSX.Element {
  const { data, isLoading } = useInvites(workspaceId);
  const revoke = useRevokeInvite(workspaceId);
  const hardDelete = useHardDeleteInvite(workspaceId);
  const [createOpen, setCreateOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const onCopy = async (invite: Invite): Promise<void> => {
    try {
      await navigator.clipboard.writeText(invite.url);
      setCopied(invite.id);
      window.setTimeout(() => setCopied((c) => (c === invite.id ? null : c)), 2000);
    } catch {
      // 클립보드 접근 불가(권한/비-https) — 무시하고 코드는 화면에 그대로 노출된다.
    }
  };

  const invites = data?.invites ?? [];

  return (
    <div data-testid="invite-manager" className="flex flex-col gap-[var(--s-4)]">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-[length:var(--fs-15)]">초대 링크</h3>
        <Button data-testid="invite-create-open" size="sm" onClick={() => setCreateOpen(true)}>
          새 초대
        </Button>
      </div>

      {isLoading ? (
        <p className="text-[length:var(--fs-13)] text-text-muted">불러오는 중…</p>
      ) : invites.length === 0 ? (
        <p data-testid="invite-empty" className="text-[length:var(--fs-13)] text-text-muted">
          아직 만든 초대 링크가 없습니다.
        </p>
      ) : (
        <ul className="flex flex-col gap-[var(--s-2)]">
          {invites.map((inv) => (
            <li
              key={inv.id}
              data-testid="invite-row"
              data-invite-id={inv.id}
              className="flex flex-col gap-[var(--s-2)] rounded-[var(--r-md)] border border-border-subtle bg-bg-surface p-[var(--s-3)]"
            >
              <div className="flex items-center justify-between gap-[var(--s-3)]">
                <code className="font-mono text-[length:var(--fs-13)] text-text-strong">
                  {inv.code}
                </code>
                <span
                  data-testid="invite-status"
                  className={
                    inv.active
                      ? 'text-[length:var(--fs-12)] text-success'
                      : 'text-[length:var(--fs-12)] text-text-muted'
                  }
                >
                  {inv.active ? '활성' : inv.revokedAt ? '비활성' : '만료/소진'}
                </span>
              </div>
              <dl className="grid grid-cols-2 gap-x-[var(--s-3)] gap-y-[var(--s-1)] text-[length:var(--fs-12)] text-text-muted">
                <div>
                  생성자 <span className="text-foreground">{inv.createdBy?.username ?? '—'}</span>
                </div>
                <div>
                  생성일 <span className="text-foreground">{formatInviteDate(inv.createdAt)}</span>
                </div>
                <div>
                  만료{' '}
                  <span className="text-foreground">
                    {inv.expiresAt ? formatInviteDate(inv.expiresAt) : '없음'}
                  </span>
                </div>
                <div>
                  사용{' '}
                  <span className="text-foreground">
                    {inv.usedCount}
                    {inv.maxUses !== null ? ` / ${inv.maxUses}` : ''}
                  </span>
                </div>
                <div>
                  잔여{' '}
                  <span className="text-foreground">
                    {inv.usesRemaining === null || inv.usesRemaining === undefined
                      ? '무제한'
                      : `${inv.usesRemaining}회`}
                  </span>
                </div>
                {inv.temporary ? (
                  <div className="text-warning">임시 멤버십</div>
                ) : (
                  <div className="text-foreground">영구 멤버</div>
                )}
              </dl>
              <div className="flex gap-[var(--s-2)]">
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="invite-copy"
                  onClick={() => void onCopy(inv)}
                >
                  {copied === inv.id ? '복사됨' : '링크 복사'}
                </Button>
                {inv.active ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="invite-revoke"
                    onClick={() => void revoke.mutateAsync(inv.id)}
                    disabled={revoke.isPending}
                  >
                    비활성화
                  </Button>
                ) : null}
                <Button
                  variant="danger"
                  size="sm"
                  data-testid="invite-hard-delete"
                  onClick={() => void hardDelete.mutateAsync(inv.id)}
                  disabled={hardDelete.isPending}
                >
                  영구 삭제
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <CreateInviteModal workspaceId={workspaceId} open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function formatInviteDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('ko-KR', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
