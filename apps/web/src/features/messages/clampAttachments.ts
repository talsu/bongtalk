/**
 * task-040 R4 (edge): cap composer attachments at MAX_ATTACHMENTS.
 *
 * Server-side `SendMessageRequestSchema.attachmentIds.max(10)` rejects
 * batches over 10. Without a client-side cap the user could:
 *   - upload 11+ files (waste bandwidth + storage churn — orphan-gc
 *     will eventually clean them, but the user sees "send failed" only
 *     after the last upload finishes).
 *   - the 11th upload always orphan-leaks if the user backs out before
 *     finalize.
 *
 * Pure function so unit tests cover all the boundary cases without
 * driving the file-input ref. Returns the accepted slice + a flag for
 * caller-side toast wording.
 */
export const MAX_ATTACHMENTS = 10;

export interface ClampInput {
  currentCount: number;
  incoming: File[];
}

export interface ClampResult {
  accepted: File[];
  rejected: number;
  /** True iff the call would have exceeded the cap (so caller can warn). */
  truncated: boolean;
}

export function clampAttachments({ currentCount, incoming }: ClampInput): ClampResult {
  if (currentCount >= MAX_ATTACHMENTS) {
    return { accepted: [], rejected: incoming.length, truncated: incoming.length > 0 };
  }
  const remaining = MAX_ATTACHMENTS - currentCount;
  if (incoming.length <= remaining) {
    return { accepted: incoming, rejected: 0, truncated: false };
  }
  return {
    accepted: incoming.slice(0, remaining),
    rejected: incoming.length - remaining,
    truncated: true,
  };
}
