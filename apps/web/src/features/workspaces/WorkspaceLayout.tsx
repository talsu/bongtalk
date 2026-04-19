import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  useCreateInvite,
  useLeaveWorkspace,
  useMembers,
  useMyWorkspaces,
  useUpdateRole,
  useWorkspace,
} from './useWorkspaces';
import { useAuth } from '../auth/AuthProvider';

export function WorkspaceLayout(): JSX.Element {
  const { slug } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data: mine, isLoading: listLoading } = useMyWorkspaces();
  const active = useMemo(
    () => mine?.workspaces.find((w) => w.slug === slug),
    [mine, slug],
  );
  const wsId = active?.id;

  const { data: wsData } = useWorkspace(wsId);
  const { data: members } = useMembers(wsId);
  const roleMut = useUpdateRole(wsId ?? '');
  const leaveMut = useLeaveWorkspace(wsId ?? '');
  const createInvite = useCreateInvite(wsId ?? '');
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  if (listLoading) {
    return (
      <div data-testid="ws-loading" className="min-h-screen flex items-center justify-center">
        <span className="text-slate-500 text-sm">loading…</span>
      </div>
    );
  }
  if (!active) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div data-testid="ws-not-found" className="text-sm text-slate-500">
          workspace not found — <Link className="underline" to="/">back home</Link>
        </div>
      </div>
    );
  }

  const myRole = wsData?.myRole ?? 'MEMBER';
  const canManage = myRole === 'ADMIN' || myRole === 'OWNER';

  return (
    <div className="min-h-screen flex bg-slate-50">
      <aside className="w-56 border-r border-slate-200 bg-white p-4">
        <h2 className="text-xs font-semibold uppercase text-slate-500">Workspaces</h2>
        <ul className="mt-2 space-y-1" data-testid="ws-switcher">
          {mine?.workspaces.map((w) => (
            <li key={w.id}>
              <Link
                to={`/w/${w.slug}`}
                data-testid={`ws-link-${w.slug}`}
                className={`block rounded px-2 py-1 text-sm ${
                  w.slug === slug ? 'bg-slate-900 text-white' : 'hover:bg-slate-100 text-slate-700'
                }`}
              >
                {w.name}
              </Link>
            </li>
          ))}
        </ul>
        <Link
          to="/w/new"
          data-testid="ws-new"
          className="mt-3 block rounded px-2 py-1 text-sm text-slate-500 hover:bg-slate-100"
        >
          + new workspace
        </Link>
      </aside>

      <main className="flex-1 p-8">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900" data-testid="ws-name">
              {active.name}
            </h1>
            <p className="text-sm text-slate-500">@{active.slug} · your role: <span data-testid="ws-my-role">{myRole}</span></p>
          </div>
          <div className="flex gap-2">
            {canManage && (
              <button
                data-testid="ws-invite"
                type="button"
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm hover:bg-slate-50"
                onClick={async () => {
                  const res = await createInvite.mutateAsync({ maxUses: 10 });
                  setInviteUrl(res.url);
                  await navigator.clipboard?.writeText(res.url).catch(() => undefined);
                }}
              >
                Invite teammates
              </button>
            )}
            {myRole !== 'OWNER' && (
              <button
                data-testid="ws-leave"
                type="button"
                className="rounded-md border border-red-200 bg-white px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                onClick={async () => {
                  await leaveMut.mutateAsync();
                  navigate('/', { replace: true });
                }}
              >
                Leave
              </button>
            )}
          </div>
        </header>

        {inviteUrl && (
          <div
            data-testid="ws-invite-url"
            className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700"
          >
            Invite link: <code className="font-mono text-xs">{inviteUrl}</code>
          </div>
        )}

        <section className="mt-8">
          <h2 className="text-sm font-semibold text-slate-700">Members</h2>
          <ul className="mt-3 space-y-2" data-testid="members-list">
            {members?.members.map((m) => (
              <li
                key={m.userId}
                data-testid={`member-${m.user.username}`}
                className="flex items-center justify-between rounded-md border border-slate-200 bg-white px-3 py-2"
              >
                <div>
                  <div className="text-sm font-medium text-slate-900">{m.user.username}</div>
                  <div className="text-xs text-slate-500">{m.user.email}</div>
                </div>
                <div className="flex items-center gap-2">
                  <span data-testid={`role-${m.user.username}`} className="text-xs text-slate-600">
                    {m.role}
                  </span>
                  {canManage && m.role !== 'OWNER' && m.userId !== user?.id && (
                    <select
                      data-testid={`role-select-${m.user.username}`}
                      value={m.role}
                      onChange={async (e) => {
                        await roleMut.mutateAsync({
                          userId: m.userId,
                          role: e.target.value as 'ADMIN' | 'MEMBER',
                        });
                      }}
                      className="rounded border border-slate-300 px-1 py-0.5 text-xs"
                    >
                      <option value="MEMBER">MEMBER</option>
                      <option value="ADMIN">ADMIN</option>
                    </select>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
