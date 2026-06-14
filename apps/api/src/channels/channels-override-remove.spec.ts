import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChannelsService } from './channels.service';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { AuditAction } from '../common/audit/audit.service';
import { CHANNEL_PERMISSION_CHANGED } from './events/channel-events';

/**
 * 072 백로그 S-J (FR-RM14): removeChannelOverride — 관리자 override 해제(행 삭제)의
 * 스코프 검증·아웃박스 이벤트(removed:true)·감사 기록·반환을 단위 검증한다. Prisma/
 * outbox/audit 스텁만 사용(vi.fn). 시스템 시간 고정(harness 규약).
 */
vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));

type Row = {
  id: string;
  principalType: 'USER' | 'ROLE';
  principalId: string;
  allowMask: bigint;
  denyMask: bigint;
};

function makeService(opts: {
  channel?: { id: string } | null;
  existing?: Row | null;
  deleteCount?: number;
}) {
  const captured: {
    channelWhere?: Record<string, unknown>;
    overrideWhere?: Record<string, unknown>;
    deleteWhere?: Record<string, unknown>;
    outbox?: { eventType: string; payload: Record<string, unknown> };
    audit?: Record<string, unknown>;
  } = {};

  const channelFindFirst = vi.fn(async (a: { where: Record<string, unknown> }) => {
    captured.channelWhere = a.where;
    return 'channel' in opts ? opts.channel : { id: 'c1' };
  });
  const overrideFindFirst = vi.fn(async (a: { where: Record<string, unknown> }) => {
    captured.overrideWhere = a.where;
    return opts.existing ?? null;
  });
  const txDeleteMany = vi.fn(async (a: { where: Record<string, unknown> }) => {
    captured.deleteWhere = a.where;
    return { count: opts.deleteCount ?? 1 };
  });
  const $transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
    cb({ channelPermissionOverride: { deleteMany: txDeleteMany } }),
  );

  const outboxRecord = vi.fn(
    async (_tx: unknown, e: { eventType: string; payload: Record<string, unknown> }) => {
      captured.outbox = { eventType: e.eventType, payload: e.payload };
    },
  );
  const auditRecord = vi.fn(async (e: Record<string, unknown>) => {
    captured.audit = e;
  });

  const prisma = {
    channel: { findFirst: channelFindFirst },
    channelPermissionOverride: { findFirst: overrideFindFirst },
    $transaction,
  };
  const svc = new ChannelsService(
    prisma as never,
    { record: outboxRecord } as never, // outbox
    {} as never, // messages
    { record: auditRecord } as never, // audit
    undefined as never, // redis (optional → cache invalidation no-op)
  );
  return { svc, channelFindFirst, overrideFindFirst, txDeleteMany, $transaction, captured };
}

const userRow: Row = {
  id: 'ov-user',
  principalType: 'USER',
  principalId: 'u-target',
  allowMask: 0x42n,
  denyMask: 0x8n,
};
const roleRow: Row = {
  id: 'ov-role',
  principalType: 'ROLE',
  principalId: 'MEMBER',
  allowMask: 0x1n,
  denyMask: 0n,
};

describe('ChannelsService.removeChannelOverride (072 S-J / FR-RM14)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('채널이 워크스페이스에 없으면 CHANNEL_NOT_FOUND', async () => {
    const { svc, overrideFindFirst } = makeService({ channel: null });
    await expect(svc.removeChannelOverride('ws1', 'c1', 'ov-user', 'admin')).rejects.toMatchObject({
      code: ErrorCode.CHANNEL_NOT_FOUND,
    });
    expect(overrideFindFirst).not.toHaveBeenCalled();
  });

  it('override 행이 이 채널에 없으면 CHANNEL_OVERRIDE_NOT_FOUND', async () => {
    const { svc, txDeleteMany } = makeService({ existing: null });
    await expect(svc.removeChannelOverride('ws1', 'c1', 'missing', 'admin')).rejects.toBeInstanceOf(
      DomainError,
    );
    await expect(svc.removeChannelOverride('ws1', 'c1', 'missing', 'admin')).rejects.toMatchObject({
      code: ErrorCode.CHANNEL_OVERRIDE_NOT_FOUND,
    });
    expect(txDeleteMany).not.toHaveBeenCalled();
  });

  it('override 조회·삭제는 id + channelId 로 스코프된다(cross-channel IDOR 차단)', async () => {
    const { svc, captured } = makeService({ existing: userRow });
    await svc.removeChannelOverride('ws1', 'c1', 'ov-user', 'admin');
    expect(captured.overrideWhere).toMatchObject({ id: 'ov-user', channelId: 'c1' });
    // 삭제도 실제 행 id + channelId 스코프(요청 id 가 아닌 조회된 행 id).
    expect(captured.deleteWhere).toMatchObject({ id: 'ov-user', channelId: 'c1' });
  });

  it('동시 삭제 race: deleteMany count=0 이면 CHANNEL_OVERRIDE_NOT_FOUND(graceful, P2025 미전파)', async () => {
    // S-J fix-forward (review MEDIUM): 두 번째 동시 요청은 행이 이미 사라져 count=0 →
    // DomainError(404)로 롤백되고 outbox/audit 를 남기지 않는다(첫 요청만 이벤트 기록).
    const { svc, captured } = makeService({ existing: userRow, deleteCount: 0 });
    await expect(svc.removeChannelOverride('ws1', 'c1', 'ov-user', 'admin')).rejects.toMatchObject({
      code: ErrorCode.CHANNEL_OVERRIDE_NOT_FOUND,
    });
    expect(captured.outbox).toBeUndefined();
    expect(captured.audit).toBeUndefined();
  });

  it('USER override 해제: removed:true 이벤트 + targetUserId + 대상 사용자 감사', async () => {
    const { svc, captured } = makeService({ existing: userRow });
    const r = await svc.removeChannelOverride('ws1', 'c1', 'ov-user', 'admin');
    expect(r).toEqual({ id: 'ov-user' });
    expect(captured.outbox?.eventType).toBe(CHANNEL_PERMISSION_CHANGED);
    expect(captured.outbox?.payload).toMatchObject({
      workspaceId: 'ws1',
      channelId: 'c1',
      principalType: 'USER',
      targetUserId: 'u-target',
      allowMask: 0,
      denyMask: 0,
      effectiveMask: 0,
      removed: true,
    });
    expect(captured.audit).toMatchObject({
      workspaceId: 'ws1',
      actorId: 'admin',
      action: AuditAction.CHANNEL_PERMISSION_OVERRIDE_REMOVE,
      targetId: 'u-target',
      channelId: 'c1',
      details: {
        principalType: 'USER',
        principalId: 'u-target',
        // 해제 직전 마스크는 string(ADR-11) 으로 기록.
        allowMask: '66',
        denyMask: '8',
      },
    });
  });

  it('ROLE override 해제: role 키 이벤트 + targetId 없음', async () => {
    const { svc, captured } = makeService({ existing: roleRow });
    const r = await svc.removeChannelOverride('ws1', 'c1', 'ov-role', 'admin');
    expect(r).toEqual({ id: 'ov-role' });
    expect(captured.outbox?.payload).toMatchObject({
      principalType: 'ROLE',
      role: 'MEMBER',
      removed: true,
    });
    expect(captured.audit?.targetId).toBeUndefined();
    expect(captured.audit?.details).toMatchObject({ principalType: 'ROLE', principalId: 'MEMBER' });
  });

  it('actorId 미전달이면 감사 기록을 생략한다', async () => {
    const { svc, captured } = makeService({ existing: userRow });
    await svc.removeChannelOverride('ws1', 'c1', 'ov-user');
    expect(captured.audit).toBeUndefined();
  });
});
