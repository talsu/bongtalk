import { useParams, useNavigate, Link } from 'react-router-dom';
import { Button } from '../../design-system/primitives';
import { useAcceptInvite, useInvitePreview } from './useWorkspaces';
import { useAuth } from '../auth/AuthProvider';

export function InviteAcceptPage(): JSX.Element {
  const { code } = useParams();
  const navigate = useNavigate();
  const { status } = useAuth();
  const { data: preview, isLoading, error } = useInvitePreview(code);
  const acceptMut = useAcceptInvite();

  if (isLoading) {
    return (
      <div data-testid="invite-loading" className="min-h-screen flex items-center justify-center">
        <span className="text-text-muted text-sm">checking invite…</span>
      </div>
    );
  }
  if (error || !preview) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-background">
        <section
          data-testid="invite-invalid"
          className="max-w-md rounded-2xl border border-warning/40 bg-bg-surface p-8 text-center"
        >
          <h1 className="text-xl font-semibold text-warning">Invite unavailable</h1>
          <p className="mt-2 text-sm text-text-muted">
            {(error as Error | undefined)?.message ?? 'This invite is invalid or expired.'}
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-background">
      <section className="w-full max-w-md rounded-2xl border border-border-subtle bg-bg-surface p-8 shadow text-center">
        <h1 className="text-2xl font-semibold text-foreground" data-testid="invite-workspace-name">
          Join {preview.workspace.name}
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          You're invited to join the{' '}
          <span className="font-mono text-xs">@{preview.workspace.slug}</span> workspace.
          {preview.usesRemaining !== null && <> {preview.usesRemaining} seat(s) remaining.</>}
        </p>
        {status === 'anonymous' ? (
          <div className="mt-6 space-y-2 text-sm">
            <Link
              to={`/login?from=/invite/${code}`}
              className="block rounded-md bg-bg-primary px-3 py-2 text-fg-primary"
            >
              Log in to accept
            </Link>
            <Link to={`/signup?from=/invite/${code}`} className="text-text-muted underline">
              or create an account
            </Link>
          </div>
        ) : (
          <Button
            type="button"
            data-testid="invite-accept"
            disabled={acceptMut.isPending}
            className="mt-6 w-full"
            onClick={async () => {
              const res = await acceptMut.mutateAsync(code!);
              navigate(`/w/${res.workspace.slug}`, { replace: true });
            }}
          >
            {acceptMut.isPending ? 'Joining…' : 'Accept invite'}
          </Button>
        )}
      </section>
    </main>
  );
}
