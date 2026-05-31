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
  // S10 (FR-RT-06): 채널 스코프 이벤트에 OutboxToWsSubscriber 가 채워넣는 채널별
  // 단조 seq(갭 감지 힌트). 채널 룸 emit 이 아닌 이벤트엔 없을 수 있고, Redis
  // 장애 시 SEQ_SENTINEL(-1) 입니다. 렌더 정렬용이 아님(id 정렬 유지).
  seq?: number;
  // Payload-specific keys (message, channel, category, member, ...).
  [k: string]: unknown;
};
