import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessagesService } from '../../../src/messages/messages.service';
import { DomainError } from '../../../src/common/errors/domain-error';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';
import { MESSAGE_UPDATED } from '../../../src/messages/events/message-events';
import { EDIT_HISTORY_CAP } from '@qufox/shared-types';

/**
 * S05 (FR-MSG-06 / FR-RC16): 편집 낙관적 잠금 + EditHistory 스냅샷 + ring
 * buffer + listEditHistory 단위 검증. Prisma / outbox 는 vi.fn() stub 만
 * 사용합니다(harness conventions — vi.fn() 만, 외부 모킹 라이브러리 X).
 *
 * 멘션 헬퍼는 본문에 `@` 토큰이 없으면 short-circuit 하여 prisma 를 건드리지
 * 않으므로, 평문 content 로 트랜잭션 경로만 검증합니다.
 */

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const CH = '22222222-2222-4222-8222-222222222222';
const MSG = '11111111-1111-4111-8111-111111111111';
const ACTOR = '33333333-3333-4333-8333-333333333333';

type BeforeRow = {
  version: number;
  contentRaw: string | null;
  contentAst: unknown;
  contentPlainV2: string | null;
  contentPlain: string;
  deletedAt: Date | null;
};

function makeBefore(overrides: Partial<BeforeRow> = {}): BeforeRow {
  return {
    version: 0,
    contentRaw: 'old',
    contentAst: null,
    contentPlainV2: 'old',
    contentPlain: 'old',
    deletedAt: null,
    ...overrides,
  };
}

function makeUpdatedRow(version: number) {
  return {
    id: MSG,
    channelId: CH,
    authorId: ACTOR,
    content: 'edited',
    contentPlain: 'edited',
    contentRaw: 'edited',
    contentAst: null,
    mentions: { users: [], channels: [], everyone: false, here: false },
    editedAt: new Date('2025-01-01T00:00:00Z'),
    deletedAt: null,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    idempotencyKey: null,
    parentMessageId: null,
    pinnedAt: null,
    pinnedBy: null,
    version,
  };
}

type EditHistoryStub = {
  create: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
  findMany: ReturnType<typeof vi.fn>;
  deleteMany: ReturnType<typeof vi.fn>;
};

type MessageTxStub = {
  findFirst: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
  findUnique: ReturnType<typeof vi.fn>;
};

function makeUpdateService(opts: {
  before: BeforeRow | null;
  updateCount: number;
  updatedVersion?: number;
  conflictRow?: ReturnType<typeof makeUpdatedRow> | null;
  historyCount?: number;
  historyFindMany?: ReturnType<typeof vi.fn>;
}) {
  const editHistory: EditHistoryStub = {
    create: vi.fn().mockResolvedValue({}),
    count: vi.fn().mockResolvedValue(opts.historyCount ?? 1),
    findMany: opts.historyFindMany ?? vi.fn().mockResolvedValue([]),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
  const message: MessageTxStub = {
    // 1번째 findFirst = 편집 전 스냅샷(before, partial select). 2번째 findFirst =
    // version 충돌 시 채널 격리(security HIGH-02) 재조회로 현재 full row 를 읽어
    // details.current DTO 를 만든다. 따라서 호출 순서별로 다른 값을 돌려준다.
    findFirst: vi
      .fn()
      .mockResolvedValueOnce(opts.before)
      .mockResolvedValue(opts.conflictRow ?? opts.before),
    updateMany: vi.fn().mockResolvedValue({ count: opts.updateCount }),
    findUnique: vi
      .fn()
      .mockResolvedValue(
        opts.updateCount === 0
          ? (opts.conflictRow ?? null)
          : makeUpdatedRow(opts.updatedVersion ?? 1),
      ),
  };
  const tx = { message, messageEditHistory: editHistory };
  const prisma = {
    $transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
  } as unknown as ConstructorParameters<typeof MessagesService>[0];
  const outboxRecord = vi.fn();
  const outbox = {
    record: outboxRecord,
  } as unknown as ConstructorParameters<typeof MessagesService>[1];
  return { service: new MessagesService(prisma, outbox), tx, editHistory, message, outboxRecord };
}

describe('MessagesService.update — 낙관적 잠금 (FR-MSG-06)', () => {
  it('version 일치 시 UPDATE + EditHistory 스냅샷 INSERT + outbox(version 포함)', async () => {
    const { service, editHistory, outboxRecord, message } = makeUpdateService({
      before: makeBefore({ version: 2, contentRaw: 'old', contentPlainV2: 'old' }),
      updateCount: 1,
      updatedVersion: 3,
      historyCount: 1,
    });
    const row = await service.update({
      workspaceId: 'ws',
      channelId: CH,
      msgId: MSG,
      actorId: ACTOR,
      content: 'edited',
      expectedVersion: 2,
    });
    expect(row.version).toBe(3);
    // 낙관적 UPDATE 의 WHERE 에 version=expectedVersion 이 들어갔는지.
    const updateArg = message.updateMany.mock.calls[0]?.[0];
    expect(updateArg.where.version).toBe(2);
    expect(updateArg.data.version).toEqual({ increment: 1 });
    // EditHistory 는 편집 전 version(2) + 편집 전 본문 스냅샷.
    expect(editHistory.create).toHaveBeenCalledOnce();
    const histArg = editHistory.create.mock.calls[0]?.[0];
    expect(histArg.data.version).toBe(2);
    expect(histArg.data.contentRaw).toBe('old');
    expect(histArg.data.contentPlain).toBe('old');
    // outbox payload 에 새 version(3) 동봉 (events 스키마 충족).
    const ob = outboxRecord.mock.calls[0]?.[1];
    expect(ob.eventType).toBe(MESSAGE_UPDATED);
    expect(ob.payload.message.version).toBe(3);
  });

  it('version 불일치 시 MESSAGE_VERSION_CONFLICT(409) + 현재 DTO(details.current)', async () => {
    const conflictRow = makeUpdatedRow(5);
    const { service, editHistory } = makeUpdateService({
      before: makeBefore({ version: 5, deletedAt: null }),
      updateCount: 0,
      conflictRow,
    });
    let caught: DomainError | null = null;
    try {
      await service.update({
        workspaceId: 'ws',
        channelId: CH,
        msgId: MSG,
        actorId: ACTOR,
        content: 'edited',
        expectedVersion: 2, // stale
      });
    } catch (e) {
      caught = e as DomainError;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect(caught?.code).toBe(ErrorCode.MESSAGE_VERSION_CONFLICT);
    const details = caught?.details as { current?: { id: string; version: number } } | undefined;
    expect(details?.current?.id).toBe(MSG);
    expect(details?.current?.version).toBe(5);
    // 충돌 시 EditHistory 적재는 일어나지 않는다.
    expect(editHistory.create).not.toHaveBeenCalled();
  });

  it('count=0 이고 행 부재면 MESSAGE_NOT_FOUND', async () => {
    const { service } = makeUpdateService({
      before: null,
      updateCount: 0,
    });
    await expect(
      service.update({
        workspaceId: null,
        channelId: CH,
        msgId: MSG,
        actorId: ACTOR,
        content: 'edited',
        expectedVersion: 0,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.MESSAGE_NOT_FOUND });
  });

  it('count=0 이고 soft-deleted 면 MESSAGE_NOT_FOUND', async () => {
    const { service } = makeUpdateService({
      before: makeBefore({ deletedAt: new Date('2025-01-01T00:00:00Z') }),
      updateCount: 0,
    });
    await expect(
      service.update({
        workspaceId: null,
        channelId: CH,
        msgId: MSG,
        actorId: ACTOR,
        content: 'edited',
        expectedVersion: 0,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.MESSAGE_NOT_FOUND });
  });

  it('ring buffer: history 가 cap(10) 초과면 가장 오래된 1개 DELETE', async () => {
    const oldest = [{ id: 'oldest-id' }];
    const historyFindMany = vi.fn().mockResolvedValue(oldest);
    const { service, editHistory } = makeUpdateService({
      before: makeBefore({ version: 10 }),
      updateCount: 1,
      updatedVersion: 11,
      historyCount: EDIT_HISTORY_CAP + 1, // 11
      historyFindMany,
    });
    await service.update({
      workspaceId: 'ws',
      channelId: CH,
      msgId: MSG,
      actorId: ACTOR,
      content: 'edited',
      expectedVersion: 10,
    });
    // oldest 1개(take = 11-10 = 1)를 version asc 로 골라 deleteMany.
    const findArg = historyFindMany.mock.calls[0]?.[0];
    expect(findArg.orderBy).toEqual({ version: 'asc' });
    expect(findArg.take).toBe(1);
    expect(editHistory.deleteMany).toHaveBeenCalledOnce();
    const delArg = editHistory.deleteMany.mock.calls[0]?.[0];
    expect(delArg.where.id.in).toEqual(['oldest-id']);
  });

  it('ring buffer: history 가 cap 이하면 DELETE 안 함', async () => {
    const { service, editHistory } = makeUpdateService({
      before: makeBefore({ version: 1 }),
      updateCount: 1,
      updatedVersion: 2,
      historyCount: 3,
    });
    await service.update({
      workspaceId: 'ws',
      channelId: CH,
      msgId: MSG,
      actorId: ACTOR,
      content: 'edited',
      expectedVersion: 1,
    });
    expect(editHistory.deleteMany).not.toHaveBeenCalled();
  });
});

describe('MessagesService.listEditHistory (FR-RC16)', () => {
  function makeListService(opts: {
    exists: { id: string } | null;
    rows: Array<{
      version: number;
      contentRaw: string | null;
      contentAst: unknown;
      contentPlain: string;
      editedAt: Date;
    }>;
  }) {
    const findManyHistory = vi.fn().mockResolvedValue(opts.rows);
    const prisma = {
      message: { findFirst: vi.fn().mockResolvedValue(opts.exists) },
      messageEditHistory: { findMany: findManyHistory },
    } as unknown as ConstructorParameters<typeof MessagesService>[0];
    const outbox = { record: vi.fn() } as unknown as ConstructorParameters<
      typeof MessagesService
    >[1];
    return { service: new MessagesService(prisma, outbox), findManyHistory };
  }

  it('이력을 version desc, 최대 10개로 매핑해 반환', async () => {
    const { service, findManyHistory } = makeListService({
      exists: { id: MSG },
      rows: [
        {
          version: 2,
          contentRaw: 'v2',
          contentAst: null,
          contentPlain: 'v2',
          editedAt: new Date('2025-01-01T00:00:00Z'),
        },
        {
          version: 1,
          contentRaw: 'v1',
          contentAst: null,
          contentPlain: 'v1',
          editedAt: new Date('2025-01-01T00:00:00Z'),
        },
      ],
    });
    const items = await service.listEditHistory({ channelId: CH, msgId: MSG });
    expect(items).toHaveLength(2);
    expect(items[0].version).toBe(2);
    expect(items[0].editedAt).toBe('2025-01-01T00:00:00.000Z');
    const arg = findManyHistory.mock.calls[0]?.[0];
    expect(arg.orderBy).toEqual({ version: 'desc' });
    expect(arg.take).toBe(EDIT_HISTORY_CAP);
  });

  it('메시지 부재 시 MESSAGE_NOT_FOUND', async () => {
    const { service } = makeListService({ exists: null, rows: [] });
    await expect(service.listEditHistory({ channelId: CH, msgId: MSG })).rejects.toMatchObject({
      code: ErrorCode.MESSAGE_NOT_FOUND,
    });
  });
});
