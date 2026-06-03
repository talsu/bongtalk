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
});
