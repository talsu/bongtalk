import { useParams, useNavigate, Link } from 'react-router-dom';
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
        <span className="text-slate-500 text-sm">checking invite…</span>
      </div>
    );
  }
  if (error || !preview) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-slate-50">
        <section data-testid="invite-invalid" className="max-w-md rounded-2xl border border-amber-200 bg-amber-50 p-8 text-center">
          <h1 className="text-xl font-semibold text-amber-800">Invite unavailable</h1>
          <p className="mt-2 text-sm text-amber-700">
            {(error as Error | undefined)?.message ?? 'This invite is invalid or expired.'}
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-50">
      <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow text-center">
        <h1 className="text-2xl font-semibold text-slate-900" data-testid="invite-workspace-name">
          Join {preview.workspace.name}
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          You're invited to join the{' '}
          <span className="font-mono text-xs">@{preview.workspace.slug}</span> workspace.
          {preview.usesRemaining !== null && (
            <> {preview.usesRemaining} seat(s) remaining.</>
          )}
        </p>
        {status === 'anonymous' ? (
          <div className="mt-6 space-y-2 text-sm">
            <Link
              to={`/login?from=/invite/${code}`}
              className="block rounded-md bg-slate-900 px-3 py-2 text-white"
            >
              Log in to accept
            </Link>
            <Link to={`/signup?from=/invite/${code}`} className="text-slate-500 underline">
              or create an account
            </Link>
          </div>
        ) : (
          <button
            type="button"
            data-testid="invite-accept"
            disabled={acceptMut.isPending}
            className="mt-6 inline-flex w-full items-center justify-center rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            onClick={async () => {
              const res = await acceptMut.mutateAsync(code!);
              navigate(`/w/${res.workspace.slug}`, { replace: true });
            }}
          >
            {acceptMut.isPending ? 'Joining…' : 'Accept invite'}
          </button>
        )}
      </section>
    </main>
  );
}
