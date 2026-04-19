/**
 * Shape matches the envelope produced by OutboxDispatcher so subscribers
 * can emit it straight to the wire without reshaping. Consumers must dedupe
 * by `id` — our delivery contract is at-least-once.
 */
export type WsEnvelope = {
  id: string; // OutboxEvent.id (dedupe key)
  type: string; // e.g. 'message.created'
  occurredAt: string; // ISO
  aggregateType?: string;
  aggregateId?: string;
  workspaceId?: string;
  channelId?: string;
  actorId?: string;
  // Payload-specific keys (message, channel, category, member, ...).
  [k: string]: unknown;
};
