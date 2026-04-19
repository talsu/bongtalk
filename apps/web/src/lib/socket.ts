import { io, type Socket } from 'socket.io-client';

/**
 * Singleton socket for the entire app. Reconnects are triggered by
 * `connect()` with a new access token (cheaper than a custom auth refresh
 * inside the WS layer — see task-005 design doc). The caller can read
 * `lastEventId` from localStorage to drive replay on reconnect.
 */
let socket: Socket | null = null;

export function getSocket(): Socket | null {
  return socket;
}

const API_BASE = (import.meta.env?.VITE_API_URL as string | undefined) ?? '/api';

// Strip trailing `/api` if the page is talking to the same-origin proxy —
// Socket.IO uses its own path, so we need the origin only.
function socketOrigin(): string {
  if (API_BASE.startsWith('http')) return API_BASE.replace(/\/api\/?$/, '');
  // relative /api → same origin
  return window.location.origin;
}

export function connect(accessToken: string, lastEventId: string | null): Socket {
  if (socket?.connected) {
    socket.disconnect();
    socket = null;
  }
  socket = io(socketOrigin(), {
    auth: {
      accessToken,
      ...(lastEventId ? { lastEventId } : {}),
    },
    transports: ['websocket'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  });
  return socket;
}

export function disconnect(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

/** Record the last event id the client has processed. Used on reconnect. */
const LAST_ID_KEY = 'qufox:lastEventId';
export function setLastEventId(id: string): void {
  try {
    window.localStorage.setItem(LAST_ID_KEY, id);
  } catch {
    /* quota/SSR — ignore */
  }
}
export function getLastEventId(): string | null {
  try {
    return window.localStorage.getItem(LAST_ID_KEY);
  } catch {
    return null;
  }
}
