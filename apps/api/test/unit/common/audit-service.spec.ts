import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditService, AuditAction } from '../../../src/common/audit/audit.service';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

/**
 * S62 (FR-RM17): AuditService append-only INSERT 검증. vi.fn() 만 사용.
 */
describe('S62 AuditService.record', () => {
  it('필수 필드만 INSERT(targetId/channelId/details null)', async () => {
    const create = vi.fn().mockResolvedValue({});
    const prisma = { auditLog: { create } } as unknown as ConstructorParameters<
      typeof AuditService
    >[0];
    const svc = new AuditService(prisma);
    await svc.record({ workspaceId: 'ws', actorId: 'actor', action: 'MEMBER_KICK' });
    expect(create).toHaveBeenCalledWith({
      data: {
        workspaceId: 'ws',
        actorId: 'actor',
        action: 'MEMBER_KICK',
        targetId: null,
        channelId: null,
        details: undefined,
      },
    });
  });

  it('ADMINISTRATOR_CHANNEL_BYPASS 액션 키가 노출된다', () => {
    expect(AuditAction.ADMINISTRATOR_CHANNEL_BYPASS).toBe('ADMINISTRATOR_CHANNEL_BYPASS');
  });

  it('전체 필드 INSERT(channelId/details 포함)', async () => {
    const create = vi.fn().mockResolvedValue({});
    const prisma = { auditLog: { create } } as unknown as ConstructorParameters<
      typeof AuditService
    >[0];
    const svc = new AuditService(prisma);
    await svc.record({
      workspaceId: 'ws',
      actorId: 'actor',
      channelId: 'ch',
      action: AuditAction.ADMINISTRATOR_CHANNEL_BYPASS,
      details: { performedAction: 'MESSAGE_SEND' },
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        workspaceId: 'ws',
        actorId: 'actor',
        action: 'ADMINISTRATOR_CHANNEL_BYPASS',
        targetId: null,
        channelId: 'ch',
        details: { performedAction: 'MESSAGE_SEND' },
      },
    });
  });

  it('recordBestEffort 는 INSERT 실패를 삼킨다(throw 안 함)', async () => {
    const create = vi.fn().mockRejectedValue(new Error('db down'));
    const prisma = { auditLog: { create } } as unknown as ConstructorParameters<
      typeof AuditService
    >[0];
    const svc = new AuditService(prisma);
    await expect(
      svc.recordBestEffort({ workspaceId: 'ws', actorId: 'actor', action: 'X' }),
    ).resolves.toBeUndefined();
  });

  it('S64 신규 AuditAction 키가 노출된다', () => {
    expect(AuditAction.BULK_MESSAGE_DELETE).toBe('BULK_MESSAGE_DELETE');
    expect(AuditAction.MESSAGE_DELETE).toBe('MESSAGE_DELETE');
    expect(AuditAction.MEMBER_ROLE_UPDATE).toBe('MEMBER_ROLE_UPDATE');
    expect(AuditAction.ROLE_CREATE).toBe('ROLE_CREATE');
    expect(AuditAction.CHANNEL_PERMISSION_OVERRIDE_SET).toBe('CHANNEL_PERMISSION_OVERRIDE_SET');
    expect(AuditAction.SLOWMODE_UPDATE).toBe('SLOWMODE_UPDATE');
    expect(AuditAction.PRIVILEGE_ESCALATION_DENIED).toBe('PRIVILEGE_ESCALATION_DENIED');
    expect(AuditAction.REPORT_RESOLVE).toBe('REPORT_RESOLVE');
  });
});

/**
 * S64 (FR-RM12): AuditService.listAuditLogs cursor 페이지네이션 + 필터 단위 검증.
 */
describe('S64 AuditService.listAuditLogs', () => {
  function makeSvc(rows: { id: string; createdAt: Date; actorId: string; action: string }[]) {
    const findMany = vi.fn().mockResolvedValue(
      rows.map((r) => ({
        id: r.id,
        workspaceId: 'ws',
        actorId: r.actorId,
        action: r.action,
        targetId: null,
        channelId: null,
        details: null,
        createdAt: r.createdAt,
      })),
    );
    const userFindMany = vi.fn().mockResolvedValue([]);
    const prisma = {
      auditLog: { findMany },
      user: { findMany: userFindMany },
    } as unknown as ConstructorParameters<typeof AuditService>[0];
    return { svc: new AuditService(prisma), findMany };
  }

  it('limit+1 을 읽어 hasMore 판정 + nextCursor 발급', async () => {
    const base = new Date('2025-01-01T00:00:00Z').getTime();
    // limit=2 인데 3행 반환 → hasMore=true.
    const rows = [0, 1, 2].map((i) => ({
      id: `0000000${i}-0000-4000-8000-000000000000`,
      createdAt: new Date(base - i * 1000),
      actorId: 'actor',
      action: 'ROLE_CREATE',
    }));
    const { svc, findMany } = makeSvc(rows);
    const res = await svc.listAuditLogs({ workspaceId: 'ws', limit: 2 });
    expect(res.entries.length).toBe(2);
    expect(res.nextCursor).toBeTruthy();
    // take = limit + 1.
    expect(findMany.mock.calls[0][0].take).toBe(3);
  });

  it('마지막 페이지면 nextCursor=null', async () => {
    const rows = [
      {
        id: '00000000-0000-4000-8000-000000000000',
        createdAt: new Date('2025-01-01T00:00:00Z'),
        actorId: 'actor',
        action: 'ROLE_CREATE',
      },
    ];
    const { svc } = makeSvc(rows);
    const res = await svc.listAuditLogs({ workspaceId: 'ws', limit: 50 });
    expect(res.entries.length).toBe(1);
    expect(res.nextCursor).toBeNull();
  });

  it('action/actor 필터가 where 절에 반영된다', async () => {
    const { svc, findMany } = makeSvc([]);
    await svc.listAuditLogs({
      workspaceId: 'ws',
      action: 'ROLE_CREATE',
      actorId: '11111111-1111-4111-8111-111111111111',
    });
    const where = findMany.mock.calls[0][0].where;
    expect(where.action).toBe('ROLE_CREATE');
    expect(where.actorId).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('잘못된 cursor 는 400(VALIDATION_FAILED) 거부', async () => {
    const { svc } = makeSvc([]);
    await expect(
      svc.listAuditLogs({ workspaceId: 'ws', cursor: 'garbage!!!' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
