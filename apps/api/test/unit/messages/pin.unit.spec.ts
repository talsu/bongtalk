import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessagesService, MESSAGE_PIN_CAP } from '../../../src/messages/messages.service';
import { DomainError } from '../../../src/common/errors/domain-error';
import { MESSAGE_PIN_TOGGLED } from '../../../src/messages/events/message-events';

/**
 * task-044-iter2: pin/unpin/listPins 단위 검증.
 * Prisma + outbox 는 vi.fn() stub 으로 대체합니다 (메모리 reference
 * `harness conventions` — vi.fn() 만 허용, 외부 모킹 라이브러리 X).
 */

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

type Row = {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  contentPlain: string;
  mentions: unknown;
  editedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  idempotencyKey: string | null;
  parentMessageId: string | null;
  pinnedAt: Date | null;
  pinnedBy: string | null;
};

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    channelId: '22222222-2222-4222-8222-222222222222',
    authorId: '33333333-3333-4333-8333-333333333333',
    content: 'hi',
    contentPlain: 'hi',
    mentions: { users: [], channels: [], everyone: false },
    editedAt: null,
    deletedAt: null,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    idempotencyKey: null,
    parentMessageId: null,
    pinnedAt: null,
    pinnedBy: null,
    ...overrides,
  };
}

type TxStub = {
  message: {
    findFirst: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
};

function makeServiceWith(opts: {
  findFirst: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  outboxRecord?: ReturnType<typeof vi.fn>;
}) {
  const tx: TxStub = {
    message: { findFirst: opts.findFirst, count: opts.count, update: opts.update },
  };
  const prisma = {
    $transaction: vi.fn(async (cb: (tx: TxStub) => Promise<unknown>) => cb(tx)),
  } as unknown as ConstructorParameters<typeof MessagesService>[0];
  const outbox = {
    record: opts.outboxRecord ?? vi.fn(),
  } as unknown as ConstructorParameters<typeof MessagesService>[1];
  return { service: new MessagesService(prisma, outbox), tx };
}

describe('MessagesService.pin', () => {
  const ACTOR = '44444444-4444-4444-8444-444444444444';

  it('cap (50) 초과 시 MESSAGE_PIN_CAP_EXCEEDED 던집니다', async () => {
    const { service } = makeServiceWith({
      findFirst: vi.fn().mockResolvedValue(makeRow()),
      count: vi.fn().mockResolvedValue(MESSAGE_PIN_CAP), // 이미 cap 만큼 핀
      update: vi.fn(),
    });
    await expect(
      service.pin({
        workspaceId: null,
        channelId: makeRow().channelId,
        msgId: makeRow().id,
        actorId: ACTOR,
      }),
    ).rejects.toThrow(DomainError);
  });

  it('cap 미만이면 pinnedAt + pinnedBy 갱신 + outbox emit', async () => {
    const updated = makeRow({ pinnedAt: new Date('2025-01-01T00:00:00Z'), pinnedBy: ACTOR });
    const update = vi.fn().mockResolvedValue(updated);
    const outboxRecord = vi.fn();
    const { service } = makeServiceWith({
      findFirst: vi.fn().mockResolvedValue(makeRow()),
      count: vi.fn().mockResolvedValue(0),
      update,
      outboxRecord,
    });
    const result = await service.pin({
      workspaceId: 'ws',
      channelId: makeRow().channelId,
      msgId: makeRow().id,
      actorId: ACTOR,
    });
    expect(result.pinnedAt).toBeInstanceOf(Date);
    expect(result.pinnedBy).toBe(ACTOR);
    expect(update).toHaveBeenCalledOnce();
    expect(outboxRecord).toHaveBeenCalledOnce();
    const call = outboxRecord.mock.calls[0]?.[1];
    expect(call.eventType).toBe(MESSAGE_PIN_TOGGLED);
  });

  it('이미 pinned 면 idempotent — update + outbox emit 0', async () => {
    const update = vi.fn();
    const outboxRecord = vi.fn();
    const { service } = makeServiceWith({
      findFirst: vi.fn().mockResolvedValue(makeRow({ pinnedAt: new Date(), pinnedBy: ACTOR })),
      count: vi.fn(),
      update,
      outboxRecord,
    });
    await service.pin({
      workspaceId: null,
      channelId: makeRow().channelId,
      msgId: makeRow().id,
      actorId: ACTOR,
    });
    expect(update).not.toHaveBeenCalled();
    expect(outboxRecord).not.toHaveBeenCalled();
  });

  it('soft-deleted 메시지는 MESSAGE_NOT_FOUND', async () => {
    // findFirst 가 deletedAt 필터로 null 을 반환
    const { service } = makeServiceWith({
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn(),
      update: vi.fn(),
    });
    await expect(
      service.pin({
        workspaceId: null,
        channelId: makeRow().channelId,
        msgId: makeRow().id,
        actorId: ACTOR,
      }),
    ).rejects.toThrow(/not found or deleted/);
  });
});

describe('MessagesService.unpin', () => {
  const ACTOR = '44444444-4444-4444-8444-444444444444';

  it('pinned → null + outbox emit', async () => {
    const updated = makeRow({ pinnedAt: null, pinnedBy: null });
    const update = vi.fn().mockResolvedValue(updated);
    const outboxRecord = vi.fn();
    const { service } = makeServiceWith({
      findFirst: vi.fn().mockResolvedValue(makeRow({ pinnedAt: new Date(), pinnedBy: ACTOR })),
      count: vi.fn(),
      update,
      outboxRecord,
    });
    const result = await service.unpin({
      workspaceId: null,
      channelId: makeRow().channelId,
      msgId: makeRow().id,
      actorId: ACTOR,
    });
    expect(result.pinnedAt).toBeNull();
    expect(update).toHaveBeenCalledOnce();
    expect(outboxRecord).toHaveBeenCalledOnce();
    const call = outboxRecord.mock.calls[0]?.[1];
    expect(call.eventType).toBe(MESSAGE_PIN_TOGGLED);
    expect(call.payload.pinnedAt).toBeNull();
  });

  it('미고정 상태에서 unpin 은 idempotent — update + outbox emit 0', async () => {
    const update = vi.fn();
    const outboxRecord = vi.fn();
    const { service } = makeServiceWith({
      findFirst: vi.fn().mockResolvedValue(makeRow()),
      count: vi.fn(),
      update,
      outboxRecord,
    });
    await service.unpin({
      workspaceId: null,
      channelId: makeRow().channelId,
      msgId: makeRow().id,
      actorId: ACTOR,
    });
    expect(update).not.toHaveBeenCalled();
    expect(outboxRecord).not.toHaveBeenCalled();
  });
});
