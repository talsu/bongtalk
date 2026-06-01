import { useEffect, useMemo, useRef } from 'react';
import { WS_EVENTS } from '@qufox/shared-types';
import { getSocket } from '../../lib/socket';
import { ViewportPresenceTracker } from './viewportPresence';

/**
 * S27 (FR-P15): viewport presence subscription for a member list / message
 * column. Returns a `register(userId, el)` ref-callback the caller attaches to
 * each row; an IntersectionObserver (200ms-debounced inside the tracker) feeds
 * enter/leave into the tracker, which diffs + chunks (max 100) and emits
 * presence:subscribe / presence:unsubscribe on the live socket.
 *
 * `scopeKey` is the active channel/DM id. Changing it (channel switch) triggers
 * an IMMEDIATE observer.disconnect() + tracker.reset() (presence:unsubscribe of
 * everything watched in the old scope) before the new scope's observer is wired
 * — so a stale channel's roster never keeps fanning out.
 *
 * The dispatcher already consumes presence:update into qk.presence.user; this
 * hook closes the loop by making sure those per-user pushes are actually
 * requested for the users on screen (the S26 dead-write — qk.presence.user was
 * written but no consumer drove a subscribe for member-list rows).
 */
export function useViewportPresence(scopeKey: string | undefined): {
  register: (userId: string) => (el: Element | null) => void;
} {
  const tracker = useRef<ViewportPresenceTracker | null>(null);
  const observer = useRef<IntersectionObserver | null>(null);
  // element → userId, so the observer callback can resolve the id back.
  const elToUser = useRef<WeakMap<Element, string>>(new WeakMap());

  useEffect(() => {
    if (!scopeKey) return;
    if (typeof IntersectionObserver === 'undefined') return; // SSR / test env guard

    const t = new ViewportPresenceTracker({
      subscribe: (userIds) => {
        const s = getSocket();
        if (s) s.emit(WS_EVENTS.PRESENCE_SUBSCRIBE, { userIds });
      },
      unsubscribe: (userIds) => {
        const s = getSocket();
        if (s) s.emit(WS_EVENTS.PRESENCE_UNSUBSCRIBE, { userIds });
      },
    });
    tracker.current = t;

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const userId = elToUser.current.get(entry.target);
          if (!userId) continue;
          if (entry.isIntersecting) t.enter(userId);
          else t.leave(userId);
        }
      },
      { threshold: 0 },
    );
    observer.current = io;

    return () => {
      // FR-P15: channel switch / unmount — disconnect the observer IMMEDIATELY
      // and reset the tracker (unsubscribes everything watched in this scope).
      io.disconnect();
      observer.current = null;
      t.reset();
      tracker.current = null;
    };
  }, [scopeKey]);

  return useMemo(
    () => ({
      register: (userId: string) => (el: Element | null) => {
        const io = observer.current;
        if (!el || !io) return;
        elToUser.current.set(el, userId);
        io.observe(el);
      },
    }),
    [],
  );
}
