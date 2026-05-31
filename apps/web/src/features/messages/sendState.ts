import type { InfiniteData } from '@tanstack/react-query';
import type { ListMessagesResponse, MessageDto } from '@qufox/shared-types';

/**
 * S03 (FR-MSG-04 / FR-MSG-05): optimistic send-state helpers.
 *
 * Single-identifier contract: the client generates ONE UUID v4 `clientNonce`
 * per logical send and uses it for everything —
 *   - the optimistic row id is `OPTIMISTIC_PREFIX + nonce` (so the UI keeps its
 *     existing `tmp-` pending marker AND the nonce is recoverable from the id),
 *   - the POST body `nonce`,
 *   - the `Idempotency-Key` header.
 * No separate tempId is ever minted.
 *
 * The optimistic row carries a non-wire `sendState` so the bubble can render
 * pending / failed affordances. It is stripped before anything hits the server
 * and ignored by older renderers (additive field).
 */
export const OPTIMISTIC_PREFIX = 'tmp-';

export type SendState = 'pending' | 'failed';

/** A MessageDto with the client-only optimistic marker. */
export type OptimisticMessage = MessageDto & { sendState?: SendState };

/** Build the optimistic row id from a clientNonce (single-identifier rule). */
export function optimisticIdFor(clientNonce: string): string {
  return `${OPTIMISTIC_PREFIX}${clientNonce}`;
}

/** Recover the clientNonce from an optimistic row id (or null if not one). */
export function nonceFromOptimisticId(id: string): string | null {
  return id.startsWith(OPTIMISTIC_PREFIX) ? id.slice(OPTIMISTIC_PREFIX.length) : null;
}

export function isOptimisticId(id: string): boolean {
  return id.startsWith(OPTIMISTIC_PREFIX);
}

type Cache = InfiniteData<ListMessagesResponse>;

/** Prepend an optimistic row to page 0 (immutably). */
export function prependOptimistic(
  old: Cache | undefined,
  row: OptimisticMessage,
): Cache | undefined {
  if (!old) return old;
  const [first, ...rest] = old.pages;
  if (!first) return old;
  return {
    ...old,
    pages: [{ ...first, items: [row, ...first.items] }, ...rest],
  };
}

/**
 * Replace the optimistic row (matched by its id) with the confirmed server
 * row. Used both by the mutation's onSuccess (sender tab) and the
 * message:created WS echo (which carries `nonce`). Idempotent: if the
 * optimistic id is already gone (WS echo arrived first), the cache is
 * returned unchanged.
 */
export function confirmOptimistic(
  old: Cache | undefined,
  optimisticId: string,
  confirmed: MessageDto,
): Cache | undefined {
  if (!old) return old;
  let swapped = false;
  const pages = old.pages.map((p) => ({
    ...p,
    items: p.items.map((m) => {
      if (m.id === optimisticId) {
        swapped = true;
        return confirmed;
      }
      return m;
    }),
  }));
  if (!swapped) return old;
  return { ...old, pages };
}

/**
 * Mark an optimistic row as failed (FR-MSG-05) — instead of rolling it out of
 * the list, we keep it visible with a `sendState: 'failed'` flag so the bubble
 * can show a "다시 시도" button. The retry reuses the SAME clientNonce.
 */
export function markOptimisticFailed(
  old: Cache | undefined,
  optimisticId: string,
): Cache | undefined {
  if (!old) return old;
  let touched = false;
  const pages = old.pages.map((p) => ({
    ...p,
    items: p.items.map((m) => {
      if (m.id === optimisticId) {
        touched = true;
        return { ...m, sendState: 'failed' as SendState };
      }
      return m;
    }),
  }));
  if (!touched) return old;
  return { ...old, pages };
}

/** Flip a failed row back to pending for a retry (same nonce). */
export function markOptimisticPending(
  old: Cache | undefined,
  optimisticId: string,
): Cache | undefined {
  if (!old) return old;
  let touched = false;
  const pages = old.pages.map((p) => ({
    ...p,
    items: p.items.map((m) => {
      if (m.id === optimisticId) {
        touched = true;
        return { ...m, sendState: 'pending' as SendState };
      }
      return m;
    }),
  }));
  if (!touched) return old;
  return { ...old, pages };
}
