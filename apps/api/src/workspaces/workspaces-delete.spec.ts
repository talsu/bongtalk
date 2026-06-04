import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspacesService } from './workspaces.service';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { WORKSPACE_DELETED, WORKSPACE_RESTORED } from './events/workspace-events';

/**
 * S72 (D13 / FR-W15): 워크스페이스 삭제 confirmation 게이트 + soft-delete/restore 단위
 * 테스트. softDelete 는 confirmation 을 실제 slug 와 대조하고(불일치 → 422), 일치 시
 * deletedAt/deleteAt(now + grace) + outbox WORKSPACE_DELETED 를 단일 트랜잭션에서 기록한다.
 * restore 는 grace 내에서만 복원하고 outbox WORKSPACE_RESTORED 를 기록한다.
 *
 * 외부는 vi.fn() 만으로 모킹한다(외부 모킹 라이브러리 금지). prisma.$transaction 은
 * 콜백에 tx 스텁을 넘겨 그대로 실행하는 패스스루로 둔다.
 */
beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  // grace = 30일(기본). 환경변수 누수로 테스트가 흔들리지 않게 명시.
  process.env.WORKSPACE_SOFT_DELETE_GRACE_DAYS = '30';
});

type TxStub = {
  workspace: { update: ReturnType<typeof vi.fn> };
};

function makeService(opts: { findUnique: ReturnType<typeof vi.fn> }) {
  const txUpdate = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: 'ws-1',
    slug: 'acme-team',
    ...args.data,
  }));
  const tx: TxStub = { workspace: { update: txUpdate } };
  const $transaction = vi.fn(async (cb: (_t: TxStub) => Promise<unknown>) => cb(tx));
  const outboxRecord = vi.fn(
    async (_tx: TxStub, _event: { eventType: string; payload: Record<string, unknown> }) =>
      undefined,
  );
  const prisma = {
    workspace: { findUnique: opts.findUnique },
    $transaction,
  };
  const outbox = { record: outboxRecord };
  const svc = new WorkspacesService(
    prisma as never,
    outbox as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { svc, txUpdate, outboxRecord, findUnique: opts.findUnique };
}

describe('WorkspacesService.softDelete — confirmation gate (FR-W15)', () => {
  it('rejects with WORKSPACE_CONFIRMATION_MISMATCH (422) when confirmation != slug', async () => {
    const findUnique = vi.fn(async () => ({ slug: 'acme-team' }));
    const { svc, txUpdate, outboxRecord } = makeService({ findUnique });
    await expect(svc.softDelete('ws-1', 'owner', 'wrong-slug')).rejects.toMatchObject({
      code: ErrorCode.WORKSPACE_CONFIRMATION_MISMATCH,
    });
    // 게이트 실패 시 어떤 write 도 일어나지 않는다.
    expect(txUpdate).not.toHaveBeenCalled();
    expect(outboxRecord).not.toHaveBeenCalled();
  });

  it('rejects with WORKSPACE_NOT_FOUND when the workspace does not exist', async () => {
    const findUnique = vi.fn(async () => null);
    const { svc } = makeService({ findUnique });
    await expect(svc.softDelete('ws-1', 'owner', 'acme-team')).rejects.toMatchObject({
      code: ErrorCode.WORKSPACE_NOT_FOUND,
    });
  });

  it('soft-deletes (deletedAt=now, deleteAt=now+30d) + records WORKSPACE_DELETED on a slug match', async () => {
    const findUnique = vi.fn(async () => ({ slug: 'acme-team' }));
    const { svc, txUpdate, outboxRecord } = makeService({ findUnique });
    await svc.softDelete('ws-1', 'owner', 'acme-team');

    expect(txUpdate).toHaveBeenCalledTimes(1);
    const data = txUpdate.mock.calls[0][0].data as { deletedAt: Date; deleteAt: Date };
    expect(data.deletedAt).toEqual(new Date('2025-01-01T00:00:00Z'));
    expect(data.deleteAt).toEqual(new Date('2025-01-31T00:00:00Z'));

    expect(outboxRecord).toHaveBeenCalledTimes(1);
    const ev = outboxRecord.mock.calls[0][1];
    expect(ev.eventType).toBe(WORKSPACE_DELETED);
    expect(ev.payload).toMatchObject({
      workspaceId: 'ws-1',
      actorId: 'owner',
      deleteAt: '2025-01-31T00:00:00.000Z',
    });
  });
});

describe('WorkspacesService.restore (FR-W15)', () => {
  it('rejects WORKSPACE_NOT_FOUND when the workspace was never deleted', async () => {
    const findUnique = vi.fn(async () => ({ deletedAt: null, deleteAt: null }));
    const { svc } = makeService({ findUnique });
    await expect(svc.restore('ws-1', 'owner')).rejects.toMatchObject({
      code: ErrorCode.WORKSPACE_NOT_FOUND,
    });
  });

  it('rejects WORKSPACE_PURGED when the grace window already elapsed', async () => {
    const findUnique = vi.fn(async () => ({
      deletedAt: new Date('2024-12-01T00:00:00Z'),
      // deleteAt in the past relative to the frozen clock (2025-01-01).
      deleteAt: new Date('2024-12-31T00:00:00Z'),
    }));
    const { svc } = makeService({ findUnique });
    await expect(svc.restore('ws-1', 'owner')).rejects.toMatchObject({
      code: ErrorCode.WORKSPACE_PURGED,
    });
  });

  it('restores within grace (deletedAt=null) + records WORKSPACE_RESTORED', async () => {
    const findUnique = vi.fn(async () => ({
      deletedAt: new Date('2024-12-31T00:00:00Z'),
      deleteAt: new Date('2025-01-30T00:00:00Z'),
    }));
    const { svc, txUpdate, outboxRecord } = makeService({ findUnique });
    await svc.restore('ws-1', 'owner');

    const data = txUpdate.mock.calls[0][0].data as { deletedAt: null; deleteAt: null };
    expect(data.deletedAt).toBeNull();
    expect(data.deleteAt).toBeNull();

    const ev = outboxRecord.mock.calls[0][1];
    expect(ev.eventType).toBe(WORKSPACE_RESTORED);
  });

  it('does not restore (auto-skip) once deleteAt is in the past — purge race contract', async () => {
    // restore↔purge 레이스: grace 가 지난 워크스페이스는 복원 불가(WORKSPACE_PURGED).
    // purge 의 DELETE WHERE deleteAt < NOW() 가 같은 경계를 재확인하므로 둘 중 하나만 이긴다.
    const findUnique = vi.fn(async () => ({
      deletedAt: new Date('2024-12-01T00:00:00Z'),
      deleteAt: new Date('2024-12-31T23:59:59Z'),
    }));
    const { svc, txUpdate } = makeService({ findUnique });
    await expect(svc.restore('ws-1', 'owner')).rejects.toBeInstanceOf(DomainError);
    expect(txUpdate).not.toHaveBeenCalled();
  });
});
