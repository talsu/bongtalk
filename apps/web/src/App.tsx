import { useEffect, useState } from 'react';
import { fetchHealth } from './lib/api';

type Status = { text: string; ok: boolean };

export default function App(): JSX.Element {
  const [status, setStatus] = useState<Status>({
    text: 'checking…',
    ok: false,
  });

  useEffect(() => {
    fetchHealth()
      .then((h) => setStatus({ text: `API OK: ${h.version} (uptime ${h.uptime}s)`, ok: true }))
      .catch((e) => setStatus({ text: `API DOWN: ${(e as Error).message}`, ok: false }));
  }, []);

  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-50">
      <section className="max-w-xl w-full rounded-2xl border border-slate-200 bg-white p-8 shadow">
        <h1 className="text-2xl font-semibold text-slate-900">qufox</h1>
        <p className="mt-1 text-sm text-slate-500">
          Discord-like real-time communication platform — bootstrap harness.
        </p>
        <div
          data-testid="api-status"
          className={`mt-6 rounded-lg border px-4 py-3 text-sm ${
            status.ok
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
              : 'border-amber-200 bg-amber-50 text-amber-700'
          }`}
        >
          {status.text}
        </div>
        <button
          type="button"
          className="mt-6 inline-flex items-center rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700"
          onClick={() => window.location.reload()}
        >
          Recheck
        </button>
      </section>
    </main>
  );
}
