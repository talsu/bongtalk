import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessagesService } from '../../../src/messages/messages.service';
import { DomainError } from '../../../src/common/errors/domain-error';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';

/**
 * S03 (FR-MSG-05 / FR-RT-04): Redis idempotency 2차 cache.
 *
 * Exercises the read-through cache short-circuit at the top of
 * `MessagesService.send` in isolation. When the Redis cache already holds
 * the messageId for `(authorId, idempotencyKey)`, the send must:
 *   - NOT run the INSERT transaction,
 *   - return the cached row with `replayed: true`,
 *   - 409 when the cached row's content differs (key reuse).
 * A cache MISS / no Redis must fall through to the normal DB path.
 *
 * vi.fn() stubs only (harness rule — no external mocking libraries).
 */

const AUTHOR = '33333333-3333-4333-8333-333333333333';
const CHANNEL = '22222222-2222-4222-8222-222222222222';
const KEY = '44444444-4444-4444-8444-444444444444';
const MSG_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

type RedisStub = {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
};

function makeService(opts: {
  redisGet?: ReturnType<typeof vi.fn>;
  redisSet?: ReturnType<typeof vi.fn>;
  findUnique?: ReturnType<typeof vi.fn>;
  transaction?: ReturnType<typeof vi.fn>;
}) {
  const redis: RedisStub = {
    get: opts.redisGet ?? vi.fn().mockResolvedValue(null),
    set: opts.redisSet ?? vi.fn().mockResolvedValue('OK'),
  };
  const prisma = {
    message: {
      findUnique: opts.findUnique ?? vi.fn().mockResolvedValue(null),
    },
    // $transaction is only reached on a cache MISS; tests that exercise the
    // hit path leave it throwing so an accidental fall-through is loud.
    $transaction:
      opts.transaction ??
      vi.fn(async () => {
        throw new Error('transaction must not run on a cache hit');
      }),
  } as unknown as ConstructorParameters<typeof MessagesService>[0];
  const outbox = { record: vi.fn() } as unknown as ConstructorParameters<typeof MessagesService>[1];
  // constructor(prisma, outbox, metrics?, threadSubscriptions?, redis?)
  const service = new MessagesService(
    prisma,
    outbox,
    undefined,
    undefined,
    redis as unknown as ConstructorParameters<typeof MessagesService>[4],
  );
  return { service, redis, prisma };
}

describe('MessagesService.send — Redis 2차 idempotency cache (S03)', () => {
  it('cache HIT with same content → returns cached row, replayed=true, no INSERT', async () => {
    const cachedRow = {
      id: MSG_ID,
      channelId: CHANNEL,
      authorId: AUTHOR,
      content: 'hello',
    };
    const findUnique = vi.fn().mockResolvedValue(cachedRow);
    const redisGet = vi.fn().mockResolvedValue(MSG_ID);
    const { service, redis } = makeService({ redisGet, findUnique });

    const result = await service.send({
      workspaceId: 'ws',
      channelId: CHANNEL,
      authorId: AUTHOR,
      content: 'hello',
      idempotencyKey: KEY,
    });

    expect(result.replayed).toBe(true);
    expect(result.message.id).toBe(MSG_ID);
    // Read the canonical idem cache key.
    expect(redis.get).toHaveBeenCalledWith(`idem:${AUTHOR}:${KEY}`);
    // The cached id was resolved via findUnique, not a full INSERT tx.
    expect(findUnique).toHaveBeenCalledWith({ where: { id: MSG_ID } });
  });

  it('cache HIT with DIFFERENT content → 409 IDEMPOTENCY_KEY_REUSE_CONFLICT', async () => {
    const cachedRow = { id: MSG_ID, channelId: CHANNEL, authorId: AUTHOR, content: 'ORIGINAL' };
    const { service } = makeService({
      redisGet: vi.fn().mockResolvedValue(MSG_ID),
      findUnique: vi.fn().mockResolvedValue(cachedRow),
    });
    await expect(
      service.send({
        workspaceId: 'ws',
        channelId: CHANNEL,
        authorId: AUTHOR,
        content: 'DIFFERENT',
        idempotencyKey: KEY,
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.IDEMPOTENCY_KEY_REUSE_CONFLICT,
    });
  });

  it('cache HIT but row vanished (purge race) → falls through to DB path', async () => {
    // findUnique returns null → cache pointed at a gone row. The send must
    // not early-return; it proceeds into the tx (which we make observable).
    const transaction = vi.fn(async () => {
      throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'reached tx — fall-through ok');
    });
    const { service } = makeService({
      redisGet: vi.fn().mockResolvedValue(MSG_ID),
      findUnique: vi.fn().mockResolvedValue(null),
      transaction,
    });
    await expect(
      service.send({
        workspaceId: 'ws',
        channelId: CHANNEL,
        authorId: AUTHOR,
        content: 'hello',
        idempotencyKey: KEY,
      }),
    ).rejects.toThrow(/fall-through ok/);
    expect(transaction).toHaveBeenCalled();
  });

  it('no idempotencyKey → cache is never consulted', async () => {
    const redisGet = vi.fn();
    const transaction = vi.fn(async () => {
      throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'reached tx');
    });
    const { service } = makeService({ redisGet, transaction });
    await expect(
      service.send({
        workspaceId: 'ws',
        channelId: CHANNEL,
        authorId: AUTHOR,
        content: 'hello',
        idempotencyKey: null,
      }),
    ).rejects.toThrow(/reached tx/);
    expect(redisGet).not.toHaveBeenCalled();
  });

  it('Redis get throws → swallowed, falls through to DB (Redis is best-effort)', async () => {
    const transaction = vi.fn(async () => {
      throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'reached tx');
    });
    const { service } = makeService({
      redisGet: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      transaction,
    });
    await expect(
      service.send({
        workspaceId: 'ws',
        channelId: CHANNEL,
        authorId: AUTHOR,
        content: 'hello',
        idempotencyKey: KEY,
      }),
    ).rejects.toThrow(/reached tx/);
    expect(transaction).toHaveBeenCalled();
  });
});
