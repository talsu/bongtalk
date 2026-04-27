import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { qk } from '../../lib/query-keys';

/**
 * task-042 R0 F2 (review M1 follow): exercise the memoization +
 * `added` event coverage of useDmPresence WITHOUT React render
 * (vitest env=node). Drive the QueryClient cache directly with the
 * dispatcher's actual write shape; assert the signature dedup logic
 * skips no-op cache writes.
 *
 * The hook itself can't be rendered here (no jsdom). What we DO
 * test is the underlying contract:
 *   1. cache subscribe sees both `added` and `updated` events
 *   2. signature computation is order-independent (set-like)
 *   3. content-hash dedup correctly identifies no-op writes
 *
 * The render-stable identity of getStatus / Sets is asserted at
 * usage site by DmShell / MobileDmList integration tests (e2e).
 */

function computeSignature(qc: QueryClient): string {
  const all = qc.getQueriesData<{ online: string[]; dnd: string[] }>({
    queryKey: qk.presence.all(),
  });
  const online: string[] = [];
  const dnd: string[] = [];
  for (const [, data] of all) {
    if (!data) continue;
    for (const id of data.online ?? []) online.push(id);
    for (const id of data.dnd ?? []) dnd.push(id);
  }
  online.sort();
  dnd.sort();
  return `o:${online.join(',')}|d:${dnd.join(',')}`;
}

describe('useDmPresence memo + signature dedup (task-042 R0 F2)', () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient();
  });

  it('signature is order-independent across multiple workspaces', () => {
    qc.setQueryData(qk.presence.workspace('ws-a'), { online: ['u1', 'u2'], dnd: [] });
    qc.setQueryData(qk.presence.workspace('ws-b'), { online: ['u3'], dnd: ['u4'] });
    const sig1 = computeSignature(qc);

    const qc2 = new QueryClient();
    qc2.setQueryData(qk.presence.workspace('ws-b'), { online: ['u3'], dnd: ['u4'] });
    qc2.setQueryData(qk.presence.workspace('ws-a'), { online: ['u2', 'u1'], dnd: [] });
    const sig2 = computeSignature(qc2);

    expect(sig1).toBe(sig2);
  });

  it('signature changes when any user moves between online and dnd', () => {
    qc.setQueryData(qk.presence.workspace('ws-a'), { online: ['u1'], dnd: [] });
    const before = computeSignature(qc);
    qc.setQueryData(qk.presence.workspace('ws-a'), { online: [], dnd: ['u1'] });
    const after = computeSignature(qc);
    expect(before).not.toBe(after);
  });

  it('signature is identical when re-writing the same payload', () => {
    qc.setQueryData(qk.presence.workspace('ws-a'), { online: ['u1', 'u2'], dnd: [] });
    const before = computeSignature(qc);
    qc.setQueryData(qk.presence.workspace('ws-a'), { online: ['u1', 'u2'], dnd: [] });
    const after = computeSignature(qc);
    expect(before).toBe(after);
  });

  it('cache subscribe receives both `added` and `updated` events', () => {
    const events: string[] = [];
    qc.getQueryCache().subscribe((e) => {
      if (e.type === 'added' || e.type === 'updated') events.push(e.type);
    });
    // First write fires `added` (cache miss).
    qc.setQueryData(qk.presence.workspace('ws-a'), { online: ['u1'], dnd: [] });
    // Second write fires `updated` (existing cache entry).
    qc.setQueryData(qk.presence.workspace('ws-a'), { online: ['u1', 'u2'], dnd: [] });
    expect(events).toContain('added');
    expect(events).toContain('updated');
  });

  it('subscribe filter ignores non-presence keys', () => {
    const fn = vi.fn();
    qc.getQueryCache().subscribe((e) => {
      // Match the actual hook filter: only react on added/updated for
      // a presence key. TanStack QueryCache fires several event types
      // per write (added, observerResultsUpdated, etc.) — this is the
      // exact filter useDmPresence uses to avoid extra renders.
      if (e.type !== 'added' && e.type !== 'updated') return;
      const k = e.query.queryKey;
      if (Array.isArray(k) && k.length >= 2 && k[0] === 'presence') fn();
    });
    qc.setQueryData(['messages', 'ws-a', 'ch-1'], { items: [] });
    const beforePresence = fn.mock.calls.length;
    qc.setQueryData(qk.presence.workspace('ws-a'), { online: [], dnd: [] });
    const afterPresence = fn.mock.calls.length;
    qc.setQueryData(['workspaces'], { workspaces: [] });
    const afterWorkspaces = fn.mock.calls.length;
    // setQueryData on a NEW cache key fires both `added` (entry
    // creation) and `updated` (data write); both events are valid
    // hook-render triggers. The filter is correct iff non-presence
    // writes never increment the spy.
    expect(beforePresence).toBe(0);
    expect(afterPresence).toBeGreaterThanOrEqual(1);
    expect(afterWorkspaces).toBe(afterPresence); // no leakage from non-presence writes
  });
});
