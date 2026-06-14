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
        // S72 (D13 / FR-W22): ipHash 미지정 액션은 null 로 INSERT 된다.
        ipHash: null,
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
        // S72 (D13 / FR-W22): ipHash 미지정 액션은 null 로 INSERT 된다.
        ipHash: null,
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

  // 072 백로그 S-G (FR-RM12): actor/target username batch 해석 + reason 평탄화 검증.
  it('actor/target username 을 해석하고, 비-사용자 target 은 null, details.reason 을 reason 으로 평탄화', async () => {
    const actorId = '11111111-1111-4111-8111-111111111111';
    const targetUserId = '22222222-2222-4222-8222-222222222222';
    const targetMsgId = '33333333-3333-4333-8333-333333333333'; // 비-사용자(메시지 등)
    const rows = [
      {
        id: 'aaaaaaaa-0000-4000-8000-000000000000',
        workspaceId: 'ws',
        actorId,
        action: 'MEMBER_KICK',
        targetId: targetUserId,
        channelId: null,
        details: { reason: '스팸', durationSeconds: 600 },
        createdAt: new Date('2025-01-01T00:00:00Z'),
      },
      {
        id: 'bbbbbbbb-0000-4000-8000-000000000000',
        workspaceId: 'ws',
        actorId,
        action: 'MESSAGE_DELETE',
        targetId: targetMsgId,
        channelId: null,
        details: null,
        createdAt: new Date('2025-01-01T00:00:00Z'),
      },
    ];
    const findMany = vi.fn().mockResolvedValue(rows);
    // user.findMany 는 actorId + targetUserId 만 매칭(메시지 id 는 미매칭).
    const userFindMany = vi.fn().mockResolvedValue([
      { id: actorId, username: 'mod' },
      { id: targetUserId, username: 'victim' },
    ]);
    const prisma = {
      auditLog: { findMany },
      user: { findMany: userFindMany },
    } as unknown as ConstructorParameters<typeof AuditService>[0];
    const svc = new AuditService(prisma);
    const res = await svc.listAuditLogs({ workspaceId: 'ws', limit: 50 });

    // 행0: 사용자 대상 → actor/target 모두 해석 + reason 평탄화.
    expect(res.entries[0].actor).toEqual({ id: actorId, username: 'mod' });
    expect(res.entries[0].target).toEqual({ id: targetUserId, username: 'victim' });
    expect(res.entries[0].reason).toBe('스팸');
    // 행1: 비-사용자 대상 → target=null, reason 없음(details null).
    expect(res.entries[1].actor).toEqual({ id: actorId, username: 'mod' });
    expect(res.entries[1].target).toBeNull();
    expect(res.entries[1].reason).toBeNull();
    // batch 조회: actorId + targetIds 를 한 번에(중복 제거).
    const where = userFindMany.mock.calls[0][0].where;
    expect(where.id.in).toEqual(expect.arrayContaining([actorId, targetUserId, targetMsgId]));
  });
});
