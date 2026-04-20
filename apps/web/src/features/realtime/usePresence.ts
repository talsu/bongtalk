import { useEffect, useState } from 'react';
import { getSocket } from '../../lib/socket';

export function usePresence(workspaceId: string | undefined): {
  onlineUserIds: Set<string>;
  dndUserIds: Set<string>;
} {
  const [online, setOnline] = useState<Set<string>>(new Set());
  const [dnd, setDnd] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!workspaceId) return;
    const socket = getSocket();
    if (!socket) return;
    const handler = (e: {
      workspaceId: string;
      onlineUserIds: string[];
      dndUserIds?: string[];
    }): void => {
      if (e.workspaceId !== workspaceId) return;
      setOnline(new Set(e.onlineUserIds));
      // task-019-C: dndUserIds is optional for backwards-compat during
      // the rollout window; treat as empty set when absent.
      setDnd(new Set(e.dndUserIds ?? []));
    };
    socket.on('presence.updated', handler);
    return () => {
      socket.off('presence.updated', handler);
    };
  }, [workspaceId]);

  return { onlineUserIds: online, dndUserIds: dnd };
}
