/**
 * S64 (D12 / FR-RM09) MessagesService.bulkDelete 단위 테스트:
 *  - 200 상한(BULK_DELETE_LIMIT) 방어 검증.
 *  - messageIds 모드: 채널/미삭제 교집합만 단일 updateMany.
 *  - latest N 모드: 최신 N개 선별.
 *  - 단일 MESSAGE_BULK_DELETED outbox 이벤트(개별 MESSAGE_DELETED 아님).
 *
 * AuditService 미주입(@Optional)이라 감사 기록은 생략된다 — 감사 1행 검증은 int 스펙
 * (s64-moderation-finish)이 실DB 로 확인한다.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessagesService } from '../../../src/messages/messages.service';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CH = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACTOR = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

type TxStub = {
  message: {
    findMany: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  savedMessage: { updateMany: ReturnType<typeof vi.fn> };
};

function makeService(opts: {
  findMany: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
}) {
  const tx: TxStub = {
    message: { findMany: opts.findMany, updateMany: opts.updateMany },
    savedMessage: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
  };
  const prisma = {
    $transaction: vi.fn(async (cb: (tx: TxStub) => Promise<unknown>) => cb(tx)),
  } as unknown as ConstructorParameters<typeof MessagesService>[0];
  const outboxRecord = vi.fn().mockResolvedValue(undefined);
  const outbox = {
    record: outboxRecord,
  } as unknown as ConstructorParameters<typeof MessagesService>[1];
  return { service: new MessagesService(prisma, outbox), tx, outboxRecord };
}

describe('MessagesService.bulkDelete', () => {
  it('FR-RM09: rejects > 200 messageIds with BULK_DELETE_LIMIT', async () => {
    const { service } = makeService({
      findMany: vi.fn(),
      updateMany: vi.fn(),
    });
    const tooMany = Array.from(
      { length: 201 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    await expect(
      service.bulkDelete({ workspaceId: WS, channelId: CH, actorId: ACTOR, messageIds: tooMany }),
    ).rejects.toMatchObject({ code: ErrorCode.BULK_DELETE_LIMIT });
  });

  it('FR-RM09: rejects latest > 200 with BULK_DELETE_LIMIT', async () => {
    const { service } = makeService({ findMany: vi.fn(), updateMany: vi.fn() });
    await expect(
      service.bulkDelete({ workspaceId: WS, channelId: CH, actorId: ACTOR, latest: 201 }),
    ).rejects.toMatchObject({ code: ErrorCode.BULK_DELETE_LIMIT });
  });

  it('FR-RM09: messageIds mode soft-deletes the channel intersection via single updateMany', async () => {
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    const findMany = vi.fn().mockResolvedValue(ids.map((id) => ({ id })));
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const { service, outboxRecord } = makeService({ findMany, updateMany });
    const res = await service.bulkDelete({
      workspaceId: WS,
      channelId: CH,
      actorId: ACTOR,
      messageIds: ids,
    });
    expect(res.deletedCount).toBe(2);
    expect(new Set(res.messageIds)).toEqual(new Set(ids));
    // 단일 updateMany 한 번만 호출(개별 루프 아님).
    expect(updateMany).toHaveBeenCalledTimes(1);
    // 단일 bulk 이벤트(개별 message.deleted 아님).
    expect(outboxRecord).toHaveBeenCalledTimes(1);
    expect(outboxRecord.mock.calls[0][1].eventType).toBe('message.bulk_deleted');
  });

  it('FR-RM09: latest mode selects most recent N (createdAt DESC)', async () => {
    const recent = ['33333333-3333-4333-8333-333333333333'];
    const findMany = vi.fn().mockResolvedValue(recent.map((id) => ({ id })));
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const { service } = makeService({ findMany, updateMany });
    const res = await service.bulkDelete({
      workspaceId: WS,
      channelId: CH,
      actorId: ACTOR,
      latest: 1,
    });
    expect(res.messageIds).toEqual(recent);
    // latest 모드는 createdAt DESC orderBy + take 로 선별.
    const call = findMany.mock.calls[0][0];
    expect(call.take).toBe(1);
    expect(call.orderBy[0]).toEqual({ createdAt: 'desc' });
  });

  it('FR-RM09: empty target set is a no-op (no updateMany, no event)', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const updateMany = vi.fn();
    const { service, outboxRecord } = makeService({ findMany, updateMany });
    const res = await service.bulkDelete({
      workspaceId: WS,
      channelId: CH,
      actorId: ACTOR,
      messageIds: ['44444444-4444-4444-8444-444444444444'],
    });
    expect(res.deletedCount).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
    expect(outboxRecord).not.toHaveBeenCalled();
  });
});
