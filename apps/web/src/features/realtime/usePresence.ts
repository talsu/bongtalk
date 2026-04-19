import { useEffect, useState } from 'react';
import { getSocket } from '../../lib/socket';

export function usePresence(workspaceId: string | undefined): {
  onlineUserIds: Set<string>;
} {
  const [online, setOnline] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!workspaceId) return;
    const socket = getSocket();
    if (!socket) return;
    const handler = (e: { workspaceId: string; onlineUserIds: string[] }): void => {
      if (e.workspaceId !== workspaceId) return;
      setOnline(new Set(e.onlineUserIds));
    };
    socket.on('presence.updated', handler);
    return () => {
      socket.off('presence.updated', handler);
    };
  }, [workspaceId]);

  return { onlineUserIds: online };
}
