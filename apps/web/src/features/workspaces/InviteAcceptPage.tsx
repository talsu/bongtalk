import { useParams, useNavigate, Link } from 'react-router-dom';
import { Button } from '../../design-system/primitives';
import { useAcceptInvite, useInvitePreview } from './useWorkspaces';
import { useAuth } from '../auth/AuthProvider';

const CARD_STYLE = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-xl)',
  boxShadow: 'var(--elev-2)',
} as const;

export function InviteAcceptPage(): JSX.Element {
  const { code } = useParams();
  const navigate = useNavigate();
  const { status } = useAuth();
  const { data: preview, isLoading, error } = useInvitePreview(code);
  const acceptMut = useAcceptInvite();

  if (isLoading) {
    return (
      <div
        data-testid="invite-loading"
        className="qf-empty flex min-h-screen items-center justify-center"
      >
        <div className="qf-empty__body">초대를 확인하는 중…</div>
      </div>
    );
  }
  if (error || !preview) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-[var(--s-6)]">
        <section
          data-testid="invite-invalid"
          className="max-w-md p-[var(--s-9)] text-center"
          style={CARD_STYLE}
        >
          <h1 className="text-[var(--fs-20)] font-semibold text-warning">
            초대 링크를 사용할 수 없어요
          </h1>
          <p className="mt-[var(--s-3)] text-[length:var(--fs-13)] text-text-muted">
            {(error as Error | undefined)?.message ?? '이 초대는 만료되었거나 유효하지 않습니다.'}
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-[var(--s-6)]">
      <section className="w-full max-w-md p-[var(--s-9)] text-center" style={CARD_STYLE}>
        <div className="qf-eyebrow mb-[var(--s-3)]">workspace invite</div>
        <h1
          className="text-[var(--fs-24)] font-semibold tracking-[var(--tracking-tight)] text-text-strong"
          data-testid="invite-workspace-name"
        >
          {preview.workspace.name} 에 합류
        </h1>
        <p className="mt-[var(--s-3)] text-[length:var(--fs-13)] text-text-muted">
          <span className="font-mono text-[length:var(--fs-12)]">@{preview.workspace.slug}</span>{' '}
          워크스페이스에 초대되었어요.
          {preview.usesRemaining !== null && <> 남은 자리 {preview.usesRemaining}개.</>}
        </p>
        {status === 'anonymous' ? (
          <div className="mt-[var(--s-7)] flex flex-col gap-[var(--s-3)] text-[length:var(--fs-13)]">
            <Link to={`/login?from=/invite/${code}`} className="qf-btn qf-btn--primary qf-btn--lg">
              로그인하고 합류
            </Link>
            <Link to={`/signup?from=/invite/${code}`} className="qf-btn qf-btn--link">
              또는 계정 만들기
            </Link>
          </div>
        ) : (
          <Button
            type="button"
            data-testid="invite-accept"
            disabled={acceptMut.isPending}
            size="lg"
            className="mt-[var(--s-7)] w-full"
            onClick={async () => {
              const res = await acceptMut.mutateAsync(code!);
              navigate(`/w/${res.workspace.slug}`, { replace: true });
            }}
          >
            {acceptMut.isPending ? '합류 중…' : '초대 수락'}
          </Button>
        )}
      </section>
    </main>
  );
}
