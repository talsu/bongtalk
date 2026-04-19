import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from '../../redis/redis.module';

/**
 * Per-channel Redis Stream (`replay:channel:{chId}`) bounded by MAXLEN ~ N
 * (default 1000). The outbox-to-ws subscriber XADDs on every emit so a
 * reconnecting client can XRANGE from its last-seen event id and catch up
 * without hitting Postgres.
 *
 * The *canonical* event source is the OutboxEvent table — this stream is a
 * best-effort cache. If the replay window has advanced past the client's
 * lastEventId, we emit `replay.truncated` and the client falls back to
 * REST GET /messages?after=.
 */
@Injectable()
export class ReplayBufferService {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private get maxLen(): number {
    return Number(process.env.WS_REPLAY_BUFFER_SIZE ?? 1000);
  }

  private key(scope: 'channel' | 'workspace', id: string): string {
    return `replay:${scope}:${id}`;
  }

  async append(
    scope: 'channel' | 'workspace',
    id: string,
    event: { id: string; type: string; occurredAt: string; payload: unknown },
  ): Promise<void> {
    // XADD with MAXLEN ~ N trims in approximate mode (cheaper, slightly over
    // the bound) — fine for our "cache window" semantics.
    await this.redis.xadd(
      this.key(scope, id),
      'MAXLEN',
      '~',
      String(this.maxLen),
      '*',
      'id',
      event.id,
      'type',
      event.type,
      'occurredAt',
      event.occurredAt,
      'payload',
      JSON.stringify(event.payload ?? null),
    );
  }

  /**
   * XRANGE after lastEventId. Because streams are keyed by a server-generated
   * id (not our outbox uuid), we linearly scan the window looking for the
   * entry whose `id` field matches, then return everything after it. O(N)
   * where N ≤ MAXLEN — plenty fast for 1000 entries.
   *
   * Returns `truncated: true` when the lastEventId is no longer in the
   * buffer (rolled off by MAXLEN) — caller must fall back to REST.
   */
  async rangeAfter(
    scope: 'channel' | 'workspace',
    id: string,
    lastEventId: string | null,
  ): Promise<{
    events: Array<{ id: string; type: string; occurredAt: string; payload: unknown }>;
    truncated: boolean;
  }> {
    const raw = (await this.redis.xrange(this.key(scope, id), '-', '+')) as Array<
      [string, string[]]
    >;
    if (raw.length === 0) {
      return { events: [], truncated: lastEventId !== null };
    }
    const parsed = raw.map(([, fields]) => fieldsToObj(fields));
    if (lastEventId === null) {
      // Initial connect without a lastEventId → no replay (just returns empty).
      return { events: [], truncated: false };
    }
    const idx = parsed.findIndex((e) => e.id === lastEventId);
    if (idx === -1) {
      return { events: [], truncated: true };
    }
    return { events: parsed.slice(idx + 1), truncated: false };
  }
}

function fieldsToObj(fields: string[]): {
  id: string;
  type: string;
  occurredAt: string;
  payload: unknown;
} {
  const out: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) out[fields[i]] = fields[i + 1];
  return {
    id: out.id,
    type: out.type,
    occurredAt: out.occurredAt,
    payload: safeJson(out.payload),
  };
}

function safeJson(s: string | undefined): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
