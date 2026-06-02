import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HARD_PIN_CAP } from '@qufox/shared-types';
import { MessagesService } from '../../../src/messages/messages.service';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';
import { MESSAGE_CREATED, MESSAGE_PIN_TOGGLED } from '../../../src/messages/events/message-events';

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
  // S50 (D10 · FR-PS-01): 시스템 메시지 핀 거부 분기용 type.
  type: string | null;
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
    type: 'DEFAULT',
    ...overrides,
  };
}

// S50 (D10 · FR-PS-02): pin() 이 같은 tx 로 SYSTEM_PIN 시스템 메시지를 삽입하므로,
// stub tx 에 user.findUnique + message.create 를 추가한다(자동 삽입 검증용).
const SYSTEM_PIN_ID = '55555555-5555-4555-8555-555555555555';

type TxStub = {
  message: {
    findFirst: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  user: { findUnique: ReturnType<typeof vi.fn> };
  // task-045 iter1 / S50: advisory lock 호출 검증을 위한 $executeRaw stub
  // (void 반환 lock 은 $queryRaw 가 역직렬화 못 하므로 $executeRaw 사용).
  $executeRaw: ReturnType<typeof vi.fn>;
};

function makeServiceWith(opts: {
  findFirst: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  create?: ReturnType<typeof vi.fn>;
  userFindUnique?: ReturnType<typeof vi.fn>;
  outboxRecord?: ReturnType<typeof vi.fn>;
  queryRaw?: ReturnType<typeof vi.fn>;
}) {
  const create =
    opts.create ??
    vi.fn().mockResolvedValue({
      id: SYSTEM_PIN_ID,
      authorId: '44444444-4444-4444-8444-444444444444',
      content: 'pinned',
      contentRaw: 'pinned',
      parentMessageId: null,
      createdAt: new Date('2025-01-01T00:00:00Z'),
    });
  const tx: TxStub = {
    message: { findFirst: opts.findFirst, count: opts.count, update: opts.update, create },
    user: { findUnique: opts.userFindUnique ?? vi.fn().mockResolvedValue({ username: 'alice' }) },
    $executeRaw: opts.queryRaw ?? vi.fn().mockResolvedValue(1),
  };
  const prisma = {
    $transaction: vi.fn(async (cb: (tx: TxStub) => Promise<unknown>) => cb(tx)),
  } as unknown as ConstructorParameters<typeof MessagesService>[0];
  const outbox = {
    record: opts.outboxRecord ?? vi.fn(),
  } as unknown as ConstructorParameters<typeof MessagesService>[1];
  return { service: new MessagesService(prisma, outbox), tx, create };
}

describe('MessagesService.pin', () => {
  const ACTOR = '44444444-4444-4444-8444-444444444444';

  it('S50 (FR-PS-04): hard cap(55) 도달 시 MESSAGE_PIN_CAP_EXCEEDED(423) 던집니다', async () => {
    const { service } = makeServiceWith({
      findFirst: vi.fn().mockResolvedValue(makeRow()),
      count: vi.fn().mockResolvedValue(HARD_PIN_CAP), // 이미 hard cap 만큼 핀
      update: vi.fn(),
    });
    await expect(
      service.pin({
        workspaceId: null,
        channelId: makeRow().channelId,
        msgId: makeRow().id,
        actorId: ACTOR,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.MESSAGE_PIN_CAP_EXCEEDED });
  });

  it('S50 (FR-PS-04): soft cap(50) 도달은 거부 경계가 아니다 — 51번째 핀 허용', async () => {
    const updated = makeRow({ pinnedAt: new Date('2025-01-01T00:00:00Z'), pinnedBy: ACTOR });
    const update = vi.fn().mockResolvedValue(updated);
    const outboxRecord = vi.fn();
    const { service } = makeServiceWith({
      findFirst: vi.fn().mockResolvedValue(makeRow()),
      count: vi.fn().mockResolvedValue(50), // soft cap 도달이지만 hard cap 미만
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
    expect(update).toHaveBeenCalledOnce();
  });

  it('S50 (FR-PS-01): 시스템 메시지(SYSTEM_PIN 등)는 핀 불가 — VALIDATION_FAILED', async () => {
    const update = vi.fn();
    const { service } = makeServiceWith({
      findFirst: vi.fn().mockResolvedValue(makeRow({ type: 'SYSTEM_PIN' })),
      count: vi.fn(),
      update,
    });
    await expect(
      service.pin({
        workspaceId: null,
        channelId: makeRow().channelId,
        msgId: makeRow().id,
        actorId: ACTOR,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
    expect(update).not.toHaveBeenCalled();
  });

  it('cap 미만이면 pinnedAt + pinnedBy 갱신 + outbox emit + SYSTEM_PIN 삽입', async () => {
    const updated = makeRow({ pinnedAt: new Date('2025-01-01T00:00:00Z'), pinnedBy: ACTOR });
    const update = vi.fn().mockResolvedValue(updated);
    const outboxRecord = vi.fn();
    const { service, create } = makeServiceWith({
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
    // S50 (FR-PS-02): SYSTEM_PIN 시스템 메시지가 자동 삽입됨.
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0]?.data?.type).toBe('SYSTEM_PIN');
    expect(create.mock.calls[0]?.[0]?.data?.authorType).toBe('SYSTEM');
    // outbox: MESSAGE_CREATED(시스템 메시지) + MESSAGE_PIN_TOGGLED 두 건.
    const eventTypes = outboxRecord.mock.calls.map((c) => c[1]?.eventType);
    expect(eventTypes).toContain(MESSAGE_CREATED);
    expect(eventTypes).toContain(MESSAGE_PIN_TOGGLED);
    const pinCall = outboxRecord.mock.calls.find((c) => c[1]?.eventType === MESSAGE_PIN_TOGGLED);
    // pin_added payload 에 systemMessageId + used(=count+1) 가 실림.
    expect(pinCall?.[1]?.payload?.systemMessageId).toBe(SYSTEM_PIN_ID);
    expect(pinCall?.[1]?.payload?.used).toBe(1);
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

  // task-045 iter1: H1 race fix — advisory lock 호출 + 순서 검증.
  it('H1 fix: pin tx 시작 시 pg_advisory_xact_lock 을 channelId 기반으로 호출', async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const findFirstFn = vi.fn().mockResolvedValue(makeRow());
    const countFn = vi.fn().mockResolvedValue(0);
    const updateFn = vi.fn().mockResolvedValue(makeRow({ pinnedAt: new Date(), pinnedBy: ACTOR }));
    const { service } = makeServiceWith({
      findFirst: findFirstFn,
      count: countFn,
      update: updateFn,
      queryRaw,
    });
    await service.pin({
      workspaceId: null,
      channelId: makeRow().channelId,
      msgId: makeRow().id,
      actorId: ACTOR,
    });
    // advisory lock 이 정확히 1회 호출됐고, prefix 'pin:' + channelId 가
    // 인자로 전달됐는지 검증.
    expect(queryRaw).toHaveBeenCalledOnce();
    const call = queryRaw.mock.calls[0];
    // template literal: first arg is TemplateStringsArray, rest are values.
    // values[0] should equal `pin:${channelId}`.
    expect(call[1]).toBe(`pin:${makeRow().channelId}`);
  });

  it('H1 fix: advisory lock 이 findFirst/count/update 보다 먼저 호출됨', async () => {
    const callOrder: string[] = [];
    const queryRaw = vi.fn(async () => {
      callOrder.push('lock');
      return [];
    });
    const findFirstFn = vi.fn(async () => {
      callOrder.push('findFirst');
      return makeRow();
    });
    const countFn = vi.fn(async () => {
      callOrder.push('count');
      return 0;
    });
    const updateFn = vi.fn(async () => {
      callOrder.push('update');
      return makeRow({ pinnedAt: new Date(), pinnedBy: ACTOR });
    });
    const { service } = makeServiceWith({
      findFirst: findFirstFn,
      count: countFn,
      update: updateFn,
      queryRaw,
    });
    await service.pin({
      workspaceId: null,
      channelId: makeRow().channelId,
      msgId: makeRow().id,
      actorId: ACTOR,
    });
    // lock 이 첫 번째 — 직렬화 보장의 핵심.
    expect(callOrder[0]).toBe('lock');
    // 그 다음 순서: findFirst → count → update.
    expect(callOrder.slice(0, 4)).toEqual(['lock', 'findFirst', 'count', 'update']);
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
