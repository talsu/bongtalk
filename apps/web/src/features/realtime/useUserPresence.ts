import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { PresenceStatus } from '@qufox/shared-types';
import { qk } from '../../lib/query-keys';

type UserPresenceCache = { status: PresenceStatus; updatedAt: string };

/**
 * S27 (FR-P15 / FR-P16): read the per-user precise presence pushed by
 * `presence:update` (subscription fan-out). The dispatcher writes
 * qk.presence.user(userId) when a watched user's status changes; before S27
 * NOTHING read that key (the S26 dead-write). This hook is the consumer —
 * MemberColumn subscribes the visible rows (useViewportPresence) and reads the
 * resulting live dot here, falling back to undefined when no push has arrived
 * (caller uses the REST group bucket instead).
 *
 * `invisible` never reaches a non-self viewer (masked → offline server-side), so
 * the values seen here are the four observable PresenceStatus members at most.
 */
export function useUserPresence(userId: string | undefined): PresenceStatus | undefined {
  const qc = useQueryClient();
  const [, forceRender] = useState(0);

  useEffect(() => {
    if (!userId) return;
    const key = qk.presence.user(userId);
    const unsubscribe = qc.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' && event.type !== 'added') return;
      const qKey = event.query.queryKey;
      if (!Array.isArray(qKey) || qKey.length !== key.length) return;
      if (qKey.every((seg, i) => seg === key[i])) forceRender((n) => n + 1);
    });
    return unsubscribe;
  }, [qc, userId]);

  if (!userId) return undefined;
  return qc.getQueryData<UserPresenceCache>(qk.presence.user(userId))?.status;
}
