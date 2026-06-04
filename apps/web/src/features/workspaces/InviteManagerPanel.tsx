import { useEffect, useRef, useState } from 'react';
import type { Invite } from '@qufox/shared-types';
import { Button, Dialog } from '../../design-system/primitives';
import { useHardDeleteInvite, useInvites, useRevokeInvite } from './useWorkspaces';
import { CreateInviteModal } from './CreateInviteModal';

// S67 (D13 / FR-W17): 초대 관리 목록 — 생성자/생성일/만료/사용횟수/잔여/활성상태 +
// 비활성화(soft revoke) · 영구삭제(hard delete) 액션. ADMIN 은 전체, MODERATOR 는 본인
// 생성분(서버가 createdById 로 필터)만 받는다.
//
// S67 fix-forward (a11y B-1·S-1·S-2·S-3·M-1·N-1 / perf 5d·5f / ui MINOR·INFO):
// 영구삭제 alertDialog 확인 단계, 액션 버튼 aria-label, 복사 라이브영역, aria-busy,
// dl 시맨틱(dt/dd), 상태 색구분 도트, setTimeout cleanup, Intl 호이스팅.

// S67 fix-forward (perf 5f): Intl.DateTimeFormat 인스턴스를 모듈 스코프 상수로 호이스팅한다
// (행마다 재생성 방지). 생성 실패(드문 런타임)는 호출부에서 try/catch.
const INVITE_DATE_FORMAT = new Intl.DateTimeFormat('ko-KR', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatInviteDate(iso: string): string {
  try {
    return INVITE_DATE_FORMAT.format(new Date(iso));
  } catch {
    return iso;
  }
}

export function InviteManagerPanel({ workspaceId }: { workspaceId: string }): JSX.Element {
  const { data, isLoading } = useInvites(workspaceId);
  const revoke = useRevokeInvite(workspaceId);
  const hardDelete = useHardDeleteInvite(workspaceId);
  const [createOpen, setCreateOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  // S67 fix-forward (a11y S-2): 복사 완료를 sr-only 라이브영역으로 알린다(버튼 텍스트
  // 변경만으론 스크린리더가 안정적으로 읽지 않는다).
  const [copyAnnounce, setCopyAnnounce] = useState('');
  // S67 fix-forward (a11y B-1): 영구삭제는 가역 불가라 alertDialog 확인 단계를 둔다.
  const [confirmTarget, setConfirmTarget] = useState<Invite | null>(null);
  // S67 fix-forward (perf 5d): 복사 피드백 타이머를 ref 로 보관해 unmount 시 정리한다.
  const copyTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    };
  }, []);

  const onCopy = async (invite: Invite): Promise<void> => {
    try {
      await navigator.clipboard.writeText(invite.url);
      setCopied(invite.id);
      setCopyAnnounce(`초대 코드 ${invite.code} 링크를 복사했습니다.`);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => {
        setCopied((c) => (c === invite.id ? null : c));
        setCopyAnnounce('');
      }, 2000);
    } catch {
      // 클립보드 접근 불가(권한/비-https) — 무시하고 코드는 화면에 그대로 노출된다.
    }
  };

  const confirmHardDelete = async (): Promise<void> => {
    if (!confirmTarget) return;
    await hardDelete.mutateAsync(confirmTarget.id);
    setConfirmTarget(null);
  };

  const invites = data?.invites ?? [];

  return (
    <div
      data-testid="invite-manager"
      aria-busy={isLoading}
      aria-live="polite"
      className="flex flex-col gap-[var(--s-4)]"
    >
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-[length:var(--fs-15)]">초대 링크</h3>
        <Button data-testid="invite-create-open" size="sm" onClick={() => setCreateOpen(true)}>
          새 초대
        </Button>
      </div>

      {/* S67 fix-forward (a11y S-2): 복사 결과 라이브영역(시각적으로 숨김). */}
      <div role="status" aria-live="polite" className="sr-only">
        {copyAnnounce}
      </div>

      {isLoading ? (
        <p className="text-[length:var(--fs-13)] text-text-muted">불러오는 중…</p>
      ) : invites.length === 0 ? (
        <p data-testid="invite-empty" className="text-[length:var(--fs-13)] text-text-muted">
          아직 만든 초대 링크가 없습니다.
        </p>
      ) : (
        // S67 fix-forward (ui INFO): 작은 화면(SettingsOverlay)에서 목록이 잘리지 않게 스크롤.
        <ul className="flex flex-1 min-h-0 flex-col gap-[var(--s-2)] overflow-y-auto">
          {invites.map((inv) => (
            <li
              key={inv.id}
              data-testid="invite-row"
              data-invite-id={inv.id}
              className="flex flex-col gap-[var(--s-2)] rounded-md border border-border-subtle bg-bg-surface p-[var(--s-3)]"
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
                  {/* S67 fix-forward (a11y N-1): 색만이 아니라 도트(●/○)로도 상태 구분(색각 보조). */}
                  <span aria-hidden="true">{inv.active ? '● ' : '○ '}</span>
                  {inv.active ? '활성' : inv.revokedAt ? '비활성' : '만료/소진'}
                </span>
              </div>
              {/* S67 fix-forward (a11y M-1): dl 을 그리드 컨테이너로 두고 dt/dd 를 직접 그리드
                  아이템으로 배치한다(시맨틱 정의 목록 유지). */}
              <dl className="grid grid-cols-[auto_1fr_auto_1fr] gap-x-[var(--s-3)] gap-y-[var(--s-1)] text-[length:var(--fs-12)] text-text-muted">
                <dt>생성자</dt>
                <dd className="text-foreground">{inv.createdBy?.username ?? '—'}</dd>
                <dt>생성일</dt>
                <dd className="text-foreground">{formatInviteDate(inv.createdAt)}</dd>
                <dt>만료</dt>
                <dd className="text-foreground">
                  {inv.expiresAt ? formatInviteDate(inv.expiresAt) : '없음'}
                </dd>
                <dt>사용</dt>
                <dd className="text-foreground">
                  {inv.usedCount}
                  {inv.maxUses !== null ? ` / ${inv.maxUses}` : ''}
                </dd>
                <dt>잔여</dt>
                <dd className="text-foreground">
                  {inv.usesRemaining === null || inv.usesRemaining === undefined
                    ? '무제한'
                    : `${inv.usesRemaining}회`}
                </dd>
                <dt>멤버십</dt>
                <dd className={inv.temporary ? 'text-warning' : 'text-foreground'}>
                  {inv.temporary ? '임시 멤버십' : '영구 멤버'}
                </dd>
              </dl>
              <div className="flex gap-[var(--s-2)]">
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="invite-copy"
                  aria-label={`초대 코드 ${inv.code} 링크 복사`}
                  onClick={() => void onCopy(inv)}
                >
                  {copied === inv.id ? '복사됨' : '링크 복사'}
                </Button>
                {inv.active ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="invite-revoke"
                    aria-label={`초대 코드 ${inv.code} 비활성화`}
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
                  aria-label={`초대 코드 ${inv.code} 영구 삭제`}
                  onClick={() => setConfirmTarget(inv)}
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

      {/* S67 fix-forward (a11y B-1): 영구삭제 확인 alertDialog(되돌릴 수 없는 파괴적 액션). */}
      <Dialog
        open={confirmTarget !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmTarget(null);
        }}
        alertDialog
        title="초대 코드 영구 삭제"
        description={
          confirmTarget
            ? `초대 코드 ${confirmTarget.code} 를 영구 삭제합니다. 되돌릴 수 없습니다.`
            : undefined
        }
        className="w-[min(420px,92vw)]"
      >
        <div data-testid="invite-hard-delete-confirm" className="flex gap-[var(--s-2)] justify-end">
          <Button variant="ghost" onClick={() => setConfirmTarget(null)}>
            취소
          </Button>
          <Button
            variant="danger"
            data-testid="invite-hard-delete-confirm-submit"
            onClick={() => void confirmHardDelete()}
            disabled={hardDelete.isPending}
            aria-busy={hardDelete.isPending || undefined}
          >
            {hardDelete.isPending ? '삭제 중…' : '영구 삭제'}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
