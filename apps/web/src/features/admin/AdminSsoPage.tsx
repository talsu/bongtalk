// task-078 P2-acl: 패밀리 SSO RP 접근 승인 관리(관리자 전용). RP(skulk/stream/…)별로 어떤
// qufox 계정이 접근 승인됐는지 보고, 이메일로 승인 추가/해제한다. 비관리자는 서버가 403 →
// "관리자 전용" 안내. design.qufox.com DS(qf-*) 충실.
import { useCallback, useEffect, useState } from 'react';
import { Button, Input } from '../../design-system/primitives';
import {
  listSsoClients,
  listSsoAccess,
  grantSsoAccess,
  revokeSsoAccess,
  type SsoClient,
  type SsoAccessEntry,
} from '../../lib/api';

export function AdminSsoPage(): JSX.Element {
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [clients, setClients] = useState<SsoClient[]>([]);
  const [adminEmails, setAdminEmails] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [access, setAccess] = useState<SsoAccessEntry[]>([]);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listSsoClients()
      .then((r) => {
        setClients(r.clients);
        setAdminEmails(r.adminEmails);
        if (r.clients[0]) setSelected(r.clients[0].clientId);
      })
      .catch((e: Error & { status?: number }) => {
        if (e.status === 403) setForbidden(true);
        else setError(e.message);
      })
      .finally(() => setLoading(false));
  }, []);

  const reloadAccess = useCallback(async (clientId: string) => {
    const r = await listSsoAccess(clientId);
    setAccess(r.access);
  }, []);

  useEffect(() => {
    if (!selected) return;
    setError(null);
    reloadAccess(selected).catch((e: Error) => setError(e.message));
  }, [selected, reloadAccess]);

  async function onGrant(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!selected || !email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await grantSsoAccess(selected, email.trim());
      setEmail('');
      await reloadAccess(selected);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke(userId: string): Promise<void> {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await revokeSsoAccess(selected, userId);
      await reloadAccess(selected);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (forbidden) {
    return (
      <main className="flex min-h-full items-center justify-center bg-background p-[var(--s-6)]">
        <section
          className="w-full max-w-md p-[var(--s-8)] text-center"
          style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-xl)',
          }}
        >
          <h1 className="text-[length:var(--fs-20)] font-semibold text-text-strong">관리자 전용</h1>
          <p className="mt-[var(--s-2)] text-[length:var(--fs-13)] text-text-muted">
            이 페이지는 SSO 관리자만 접근할 수 있습니다.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-2xl p-[var(--s-7)]">
      <div className="mb-[var(--s-6)]">
        <div className="qf-eyebrow mb-[var(--s-2)]">qufox 패밀리 · SSO</div>
        <h1 className="text-[length:var(--fs-24)] font-semibold tracking-[var(--tracking-tight)] text-text-strong">
          서비스 접근 승인 관리
        </h1>
        <p className="mt-[var(--s-2)] text-[length:var(--fs-13)] text-text-muted">
          qufox 계정이 있어도 아래에서 승인된 사용자만 각 서비스에 접근할 수 있습니다. 관리자
          ({adminEmails.join(', ') || '—'})는 모든 서비스에 항상 접근합니다.
        </p>
      </div>

      {error && (
        <div className="qf-notice qf-notice--danger mb-[var(--s-5)]" role="alert">
          <span className="qf-notice__icon" aria-hidden>
            ⚠
          </span>
          <div className="qf-notice__body">{error}</div>
        </div>
      )}

      {loading ? (
        <p className="text-[length:var(--fs-13)] text-text-muted">불러오는 중…</p>
      ) : (
        <>
          {/* RP 선택 */}
          <div className="mb-[var(--s-6)] flex flex-wrap gap-[var(--s-2)]">
            {clients.map((c) => (
              <button
                key={c.clientId}
                type="button"
                onClick={() => setSelected(c.clientId)}
                className={`qf-btn qf-btn--sm ${selected === c.clientId ? 'qf-btn--primary' : 'qf-btn--secondary'}`}
              >
                {c.name} · {c.accessCount}
              </button>
            ))}
          </div>

          {selected && (
            <section
              className="p-[var(--s-7)]"
              style={{
                background: 'var(--bg-elevated)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-xl)',
              }}
            >
              {/* 승인 추가 */}
              <form className="flex items-end gap-[var(--s-3)]" onSubmit={onGrant}>
                <div className="qf-field flex-1">
                  <label className="qf-field__label" htmlFor="grant-email">
                    이메일로 승인 추가
                  </label>
                  <Input
                    id="grant-email"
                    type="email"
                    autoComplete="off"
                    placeholder="user@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
                <Button type="submit" disabled={busy || !email.trim()}>
                  승인
                </Button>
              </form>

              {/* 승인된 사용자 목록 */}
              <ul className="mt-[var(--s-6)] flex flex-col gap-[var(--s-2)]">
                {access.length === 0 && (
                  <li className="text-[length:var(--fs-13)] text-text-muted">
                    아직 승인된 사용자가 없습니다(관리자는 제외).
                  </li>
                )}
                {access.map((a) => (
                  <li
                    key={a.userId}
                    className="flex items-center justify-between gap-[var(--s-3)] py-[var(--s-2)]"
                    style={{ borderBottom: '1px solid var(--border-subtle)' }}
                  >
                    <span className="text-[length:var(--fs-14)] text-text">
                      {a.email ?? a.userId}
                      {a.username && (
                        <span className="text-text-muted"> · {a.username}</span>
                      )}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void onRevoke(a.userId)}
                    >
                      해제
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </main>
  );
}
