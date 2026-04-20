import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

// Histogram buckets used across HTTP/DB/Redis/dispatch-latency — picked to
// straddle typical inter-service p50 (~50ms) up to a hard 5s p99 ceiling,
// per the task spec.
const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

/**
 * Known label enums. Any attempt to record a label not in this whitelist is
 * coerced to `'_other'` so a bug in a caller can't blow up cardinality. The
 * cardinality integration test (`cardinality.int.spec.ts`) asserts the total
 * series count stays bounded under realistic load.
 */
const L = {
  httpMethod: new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']),
  httpStatusClass: new Set(['1xx', '2xx', '3xx', '4xx', '5xx']),
  dbOp: new Set([
    'findMany',
    'findFirst',
    'findUnique',
    'create',
    'createMany',
    'update',
    'updateMany',
    'upsert',
    'delete',
    'deleteMany',
    'count',
    'queryRaw',
    'executeRaw',
    'transaction',
    '_other',
  ]),
  outboxResult: new Set(['success', 'failure', 'dlq']),
  wsResult: new Set(['accepted', 'rejected_auth', 'rejected_other']),
  wsDisconnectReason: new Set([
    'client',
    'server_kick',
    'membership_revoked',
    'transport_error',
    '_other',
  ]),
  replayResult: new Set(['served', 'truncated']),
  authResult: new Set(['success', 'invalid_credentials', 'locked', 'rate_limited']),
  poolState: new Set(['active', 'idle', 'pending']),
  // task-016-B (009-nit-4 closure): the previous raw event_type
  // labels bypassed the bucket allowlist, so a new event type landing
  // on the system would add an unbounded series. Listing the full
  // enum here plus a task-013 reaction/thread update.
  outboxEventType: new Set([
    'workspace.created',
    'workspace.deleted',
    'workspace.restored',
    'workspace.member.joined',
    'workspace.member.left',
    'workspace.member.removed',
    'workspace.role.changed',
    'workspace.ownership.transferred',
    'workspace.invite.created',
    'workspace.invite.revoked',
    'workspace.invite.accepted',
    'channel.created',
    'channel.updated',
    'channel.deleted',
    'channel.restored',
    'channel.archived',
    'channel.unarchived',
    'channel.moved',
    'category.created',
    'category.updated',
    'category.deleted',
    'category.moved',
    'message.created',
    'message.updated',
    'message.deleted',
    'message.reaction.added',
    'message.reaction.removed',
    'message.thread.replied',
    'mention.received',
    '_other',
  ]),
  wsEventType: new Set([
    // WS event types are a strict subset of outbox event types
    // (handlers may drop some as client-only), so we reuse the same
    // enumeration values. Kept as a separate key so a future
    // client-only event doesn't force a contrived outbox entry.
    'message.created',
    'message.updated',
    'message.deleted',
    'message.reaction.added',
    'message.reaction.removed',
    'message.thread.replied',
    'mention.received',
    'channel.created',
    'channel.updated',
    'channel.deleted',
    'channel.moved',
    'channel.archived',
    'channel.unarchived',
    'workspace.member.joined',
    'workspace.member.left',
    'workspace.member.removed',
    'workspace.role.changed',
    'presence.updated',
    '_other',
  ]),
} as const;

@Injectable()
export class MetricsService {
  readonly registry: Registry;

  // ----- HTTP
  readonly httpRequestsTotal: Counter;
  readonly httpRequestDurationSeconds: Histogram;
  readonly httpInFlight: Gauge;
  // ----- DB
  readonly dbQueryDurationSeconds: Histogram;
  readonly dbPoolConnections: Gauge;
  readonly dbTransactionDurationSeconds: Histogram;
  // ----- Redis
  readonly redisCommandDurationSeconds: Histogram;
  readonly redisPoolConnections: Gauge;
  // ----- Outbox
  readonly outboxEventsRecordedTotal: Counter;
  readonly outboxEventsDispatchedTotal: Counter;
  readonly outboxEventDispatchLatencySeconds: Histogram;
  readonly outboxPendingEvents: Gauge;
  readonly outboxDlqEvents: Gauge;
  readonly outboxLastDispatchTimestampSeconds: Gauge;
  // ----- Realtime
  readonly wsConnectionsActive: Gauge;
  readonly wsConnectionsTotal: Counter;
  readonly wsDisconnectionsTotal: Counter;
  readonly wsEventsEmittedTotal: Counter;
  readonly wsReplayEventsTotal: Counter;
  readonly wsPresenceSessionsActive: Gauge;
  readonly wsMessageFanoutLatencySeconds: Histogram;
  // ----- Domain
  readonly messagesSentTotal: Counter;
  readonly messagesSentIdempotentReplayedTotal: Counter;
  readonly workspaceMembersActive: Gauge;
  readonly rateLimitHitsTotal: Counter;
  // ----- Auth
  readonly authLoginsTotal: Counter;
  readonly authSessionCompromisedTotal: Counter;
  readonly authRefreshRotationsTotal: Counter;

  constructor() {
    this.registry = new Registry();
    this.registry.setDefaultLabels({ service: process.env.OTEL_SERVICE_NAME ?? 'qufox-api' });
    collectDefaultMetrics({ register: this.registry });

    // ----- HTTP
    this.httpRequestsTotal = new Counter({
      name: 'http_requests_total',
      help: 'HTTP request count by method/route/status_class',
      labelNames: ['method', 'route', 'status_class'],
      registers: [this.registry],
    });
    this.httpRequestDurationSeconds = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request latency in seconds',
      labelNames: ['method', 'route'],
      buckets: DEFAULT_BUCKETS,
      registers: [this.registry],
    });
    this.httpInFlight = new Gauge({
      name: 'http_in_flight',
      help: 'Currently in-flight HTTP requests',
      labelNames: ['route'],
      registers: [this.registry],
    });

    // ----- DB
    this.dbQueryDurationSeconds = new Histogram({
      name: 'db_query_duration_seconds',
      help: 'Prisma query duration',
      labelNames: ['operation', 'model'],
      buckets: DEFAULT_BUCKETS,
      registers: [this.registry],
    });
    this.dbPoolConnections = new Gauge({
      name: 'db_pool_connections',
      help: 'Postgres pool connection counts by state',
      labelNames: ['state'],
      registers: [this.registry],
    });
    this.dbTransactionDurationSeconds = new Histogram({
      name: 'db_transaction_duration_seconds',
      help: 'Prisma $transaction duration',
      buckets: DEFAULT_BUCKETS,
      registers: [this.registry],
    });

    // ----- Redis
    this.redisCommandDurationSeconds = new Histogram({
      name: 'redis_command_duration_seconds',
      help: 'ioredis command latency',
      labelNames: ['command'],
      buckets: DEFAULT_BUCKETS,
      registers: [this.registry],
    });
    this.redisPoolConnections = new Gauge({
      name: 'redis_pool_connections',
      help: 'ioredis connection pool state',
      labelNames: ['state'],
      registers: [this.registry],
    });

    // ----- Outbox
    this.outboxEventsRecordedTotal = new Counter({
      name: 'outbox_events_recorded_total',
      help: 'OutboxEvent rows created (source side)',
      labelNames: ['event_type'],
      registers: [this.registry],
    });
    this.outboxEventsDispatchedTotal = new Counter({
      name: 'outbox_events_dispatched_total',
      help: 'OutboxEvent dispatches by outcome',
      labelNames: ['event_type', 'result'],
      registers: [this.registry],
    });
    this.outboxEventDispatchLatencySeconds = new Histogram({
      name: 'outbox_event_dispatch_latency_seconds',
      help: 'occurredAt → dispatchedAt wall time',
      labelNames: ['event_type'],
      buckets: DEFAULT_BUCKETS,
      registers: [this.registry],
    });
    this.outboxPendingEvents = new Gauge({
      name: 'outbox_pending_events',
      help: 'Current count of OutboxEvent rows awaiting dispatch',
      registers: [this.registry],
    });
    this.outboxDlqEvents = new Gauge({
      name: 'outbox_dlq_events',
      help: 'Current count of OutboxEvent rows beyond max attempts',
      registers: [this.registry],
    });
    this.outboxLastDispatchTimestampSeconds = new Gauge({
      name: 'outbox_last_dispatch_timestamp_seconds',
      help: 'Unix seconds of the last successful dispatcher tick',
      registers: [this.registry],
    });

    // ----- Realtime
    this.wsConnectionsActive = new Gauge({
      name: 'ws_connections_active',
      help: 'Currently connected WS sockets on this node',
      registers: [this.registry],
    });
    this.wsConnectionsTotal = new Counter({
      name: 'ws_connections_total',
      help: 'WS connection attempts by outcome',
      labelNames: ['result'],
      registers: [this.registry],
    });
    this.wsDisconnectionsTotal = new Counter({
      name: 'ws_disconnections_total',
      help: 'WS disconnections by reason',
      labelNames: ['reason'],
      registers: [this.registry],
    });
    this.wsEventsEmittedTotal = new Counter({
      name: 'ws_events_emitted_total',
      help: 'Server → client event emissions by event_type',
      labelNames: ['event_type'],
      registers: [this.registry],
    });
    this.wsReplayEventsTotal = new Counter({
      name: 'ws_replay_events_total',
      help: 'Replay outcomes on reconnect',
      labelNames: ['result'],
      registers: [this.registry],
    });
    this.wsPresenceSessionsActive = new Gauge({
      name: 'ws_presence_sessions_active',
      help: 'Active presence session hashes in Redis',
      registers: [this.registry],
    });
    this.wsMessageFanoutLatencySeconds = new Histogram({
      name: 'ws_message_fanout_latency_seconds',
      help: 'Outbox dispatched → first WS socket emit latency',
      buckets: DEFAULT_BUCKETS,
      registers: [this.registry],
    });

    // ----- Domain
    this.messagesSentTotal = new Counter({
      name: 'messages_sent_total',
      help: 'Successful message creations',
      registers: [this.registry],
    });
    this.messagesSentIdempotentReplayedTotal = new Counter({
      name: 'messages_sent_idempotent_replayed_total',
      help: 'Message sends that matched an existing Idempotency-Key',
      registers: [this.registry],
    });
    this.workspaceMembersActive = new Gauge({
      name: 'workspace_members_active',
      help: 'Members considered active over the last 24h (gauge, refreshed on read)',
      registers: [this.registry],
    });
    this.rateLimitHitsTotal = new Counter({
      name: 'rate_limit_hits_total',
      help: 'Rate-limit ceiling hits by endpoint bucket',
      labelNames: ['endpoint'],
      registers: [this.registry],
    });

    // ----- Auth
    this.authLoginsTotal = new Counter({
      name: 'auth_logins_total',
      help: 'Login attempts by outcome',
      labelNames: ['result'],
      registers: [this.registry],
    });
    this.authSessionCompromisedTotal = new Counter({
      name: 'auth_session_compromised_total',
      help: 'Refresh-token reuse detections',
      registers: [this.registry],
    });
    this.authRefreshRotationsTotal = new Counter({
      name: 'auth_refresh_rotations_total',
      help: 'Successful refresh-token rotations',
      registers: [this.registry],
    });
  }

  /**
   * Coerces a label value to a known enum or '_other'. Protects against
   * someone accidentally passing a high-cardinality value (userId, request
   * id) into a label slot.
   */
  bucket<K extends keyof typeof L>(kind: K, value: string): string {
    const known: ReadonlySet<string> = L[kind] as unknown as ReadonlySet<string>;
    if (known.has(value)) return value;
    return '_other';
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }

  async contentType(): Promise<string> {
    return this.registry.contentType;
  }
}
