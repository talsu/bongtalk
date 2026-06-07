import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Job } from 'bullmq';
import { MentionBroadcastProcessor } from './mention-broadcast.processor';
import type { MentionBroadcastJobData } from './mention-broadcast-queue.constants';
import type { PrismaService } from '../prisma/prisma.module';
import type { OutboxService } from '../common/outbox/outbox.service';
import type { ChannelAccessService } from '../channels/permission/channel-access.service';
import { Permission } from '../auth/permissions';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

interface Mocks {
  prisma: PrismaService;
  outbox: OutboxService;
  channelAccess: ChannelAccessService;
  channelFindUnique: ReturnType<typeof vi.fn>;
  messageFindUnique: ReturnType<typeof vi.fn>;
  memberRoleFindMany: ReturnType<typeof vi.fn>;
  hasPermission: ReturnType<typeof vi.fn>;
  recordFindMany: ReturnType<typeof vi.fn>;
  createMany: ReturnType<typeof vi.fn>;
  record: ReturnType<typeof vi.fn>;
}

function makeMocks(
  opts: {
    channelPrivate?: boolean;
    channelDeleted?: boolean;
    messageDeleted?: boolean;
    members?: string[];
    /** uids for which hasPermission(READ) returns false (private-channel invisible). */
    invisible?: Set<string>;
    /** uids already present in MentionRecord before this run (idempotency). */
    existing?: Set<string>;
  } = {},
): Mocks {
  const members = opts.members ?? ['u1', 'u2'];
  const invisible = opts.invisible ?? new Set<string>();
  const existing = opts.existing ?? new Set<string>();

  const channelFindUnique = vi.fn(async () =>
    opts.channelDeleted
      ? null
      : { id: 'chan-1', isPrivate: opts.channelPrivate ?? false, deletedAt: null },
  );
  const messageFindUnique = vi.fn(async () =>
    opts.messageDeleted ? { id: 'msg-1', deletedAt: new Date() } : { id: 'msg-1', deletedAt: null },
  );
  const memberRoleFindMany = vi.fn(async () => members.map((userId) => ({ userId })));
  const hasPermission = vi.fn(
    async (_channel: { id: string }, userId: string, required: Permission) =>
      required === Permission.READ && !invisible.has(userId),
  );

  // tx client: mentionRecord.findMany(existing) + mentionRecord.createMany.
  const recordFindMany = vi.fn(async (args: { where: { targetId: { in: string[] } } }) =>
    args.where.targetId.in.filter((id) => existing.has(id)).map((targetId) => ({ targetId })),
  );
  const createMany = vi.fn(async (args: { data: unknown[] }) => ({ count: args.data.length }));
  const record = vi.fn(async () => 'outbox-1');

  const txClient = {
    mentionRecord: { findMany: recordFindMany, createMany },
  };
  const $transaction = vi.fn(async (cb: (tx: typeof txClient) => Promise<void>) => cb(txClient));

  const prisma = {
    channel: { findUnique: channelFindUnique },
    message: { findUnique: messageFindUnique },
    memberRole: { findMany: memberRoleFindMany },
    $transaction,
  } as unknown as PrismaService;

  const outbox = { record } as unknown as OutboxService;
  const channelAccess = { hasPermission } as unknown as ChannelAccessService;

  return {
    prisma,
    outbox,
    channelAccess,
    channelFindUnique,
    messageFindUnique,
    memberRoleFindMany,
    hasPermission,
    recordFindMany,
    createMany,
    record,
  };
}

function job(
  data: Partial<MentionBroadcastJobData> = {},
  over: { attemptsMade?: number } = {},
): Job<MentionBroadcastJobData> {
  return {
    data: {
      messageId: 'msg-1',
      channelId: 'chan-1',
      workspaceId: 'ws-1',
      actorId: 'author-1',
      gatedRoleIds: ['role-1'],
      mentionedUserIds: [],
      snippet: 'hi @Team',
      everyone: false,
      here: false,
      createdAt: '2025-01-01T00:00:00.000Z',
      ...data,
    },
    attemptsMade: over.attemptsMade ?? 0,
    opts: { attempts: 3 },
  } as Job<MentionBroadcastJobData>;
}

describe('S88b MentionBroadcastProcessor (FR-MN-03 · FR-MN-19)', () => {
  it('expands role members → records one MentionRecord row + one outbox per new recipient', async () => {
    const m = makeMocks({ members: ['u1', 'u2'] });
    const p = new MentionBroadcastProcessor(m.prisma, m.outbox, m.channelAccess);
    await p.process(job());

    expect(m.memberRoleFindMany).toHaveBeenCalledOnce();
    // createMany 1회 · 2명 분.
    expect(m.createMany).toHaveBeenCalledOnce();
    const createArg = m.createMany.mock.calls[0][0] as { data: Array<{ targetId: string }> };
    expect(createArg.data.map((r) => r.targetId).sort()).toEqual(['u1', 'u2']);
    // outbox 2건(신규 수신자 1인당 1건) · 전부 role=true.
    expect(m.record).toHaveBeenCalledTimes(2);
    const payloads = m.record.mock.calls.map((c) => c[1].payload);
    expect(payloads.every((pl) => pl.role === true)).toBe(true);
    expect(payloads.every((pl) => pl.messageId === 'msg-1')).toBe(true);
    expect(payloads.map((pl) => pl.targetUserId).sort()).toEqual(['u1', 'u2']);
  });

  it('excludes the message author (self-mention) from expansion', async () => {
    const m = makeMocks({ members: ['author-1', 'u2'] });
    const p = new MentionBroadcastProcessor(m.prisma, m.outbox, m.channelAccess);
    await p.process(job());
    const createArg = m.createMany.mock.calls[0][0] as { data: Array<{ targetId: string }> };
    expect(createArg.data.map((r) => r.targetId)).toEqual(['u2']);
  });

  it('excludes recipients already directly @user-mentioned (cross-path dedup)', async () => {
    // u1 은 @user 동기 경로가 이미 mention.received 1건 발송 완료(mentionedUserIds). 워커는
    // @role expand 에서 u1 을 제외해 u2 만 기록 → u1 이 동기+async 로 2건 받지 않는다.
    const m = makeMocks({ members: ['u1', 'u2'] });
    const p = new MentionBroadcastProcessor(m.prisma, m.outbox, m.channelAccess);
    await p.process(job({ mentionedUserIds: ['u1'] }));

    const createArg = m.createMany.mock.calls[0][0] as { data: Array<{ targetId: string }> };
    expect(createArg.data.map((r) => r.targetId)).toEqual(['u2']);
    expect(m.record).toHaveBeenCalledTimes(1);
    expect(m.record.mock.calls[0][1].payload.targetUserId).toBe('u2');
    // 직접 멘션 수신자는 VIEW_CHANNEL 재검증 대상에서도 빠진다(불필요한 권한 조회 회피).
    expect(m.hasPermission).not.toHaveBeenCalledWith(expect.anything(), 'u1', Permission.READ);
  });

  it('is a no-op when every role member was already directly @user-mentioned', async () => {
    const m = makeMocks({ members: ['u1', 'u2'] });
    const p = new MentionBroadcastProcessor(m.prisma, m.outbox, m.channelAccess);
    await p.process(job({ mentionedUserIds: ['u1', 'u2'] }));
    // 후보가 전부 직접 멘션 → expand 집합 공집합 → createMany/outbox 미호출.
    expect(m.createMany).not.toHaveBeenCalled();
    expect(m.record).not.toHaveBeenCalled();
  });

  it('skips VIEW_CHANNEL-invisible members on a private channel (no record/outbox)', async () => {
    const m = makeMocks({
      channelPrivate: true,
      members: ['u1', 'u2'],
      invisible: new Set(['u2']),
    });
    const p = new MentionBroadcastProcessor(m.prisma, m.outbox, m.channelAccess);
    await p.process(job());
    const createArg = m.createMany.mock.calls[0][0] as { data: Array<{ targetId: string }> };
    expect(createArg.data.map((r) => r.targetId)).toEqual(['u1']);
    expect(m.record).toHaveBeenCalledTimes(1);
    expect(m.record.mock.calls[0][1].payload.targetUserId).toBe('u1');
  });

  it('is idempotent: a re-processed job inserts no new row and emits no outbox', async () => {
    // 두 번째 처리(재시도/재시작)에서 두 수신자가 이미 MentionRecord 에 존재.
    const m = makeMocks({ members: ['u1', 'u2'], existing: new Set(['u1', 'u2']) });
    const p = new MentionBroadcastProcessor(m.prisma, m.outbox, m.channelAccess);
    await p.process(job());
    expect(m.createMany).not.toHaveBeenCalled();
    expect(m.record).not.toHaveBeenCalled();
  });

  it('records only the newly-inserted recipient when one already existed', async () => {
    const m = makeMocks({ members: ['u1', 'u2'], existing: new Set(['u1']) });
    const p = new MentionBroadcastProcessor(m.prisma, m.outbox, m.channelAccess);
    await p.process(job());
    const createArg = m.createMany.mock.calls[0][0] as { data: Array<{ targetId: string }> };
    expect(createArg.data.map((r) => r.targetId)).toEqual(['u2']);
    expect(m.record).toHaveBeenCalledTimes(1);
    expect(m.record.mock.calls[0][1].payload.targetUserId).toBe('u2');
  });

  it('skips entirely when the message is soft-deleted', async () => {
    const m = makeMocks({ messageDeleted: true });
    const p = new MentionBroadcastProcessor(m.prisma, m.outbox, m.channelAccess);
    await p.process(job());
    expect(m.memberRoleFindMany).not.toHaveBeenCalled();
    expect(m.createMany).not.toHaveBeenCalled();
    expect(m.record).not.toHaveBeenCalled();
  });

  it('is a no-op when no gated roles are present', async () => {
    const m = makeMocks();
    const p = new MentionBroadcastProcessor(m.prisma, m.outbox, m.channelAccess);
    await p.process(job({ gatedRoleIds: [] }));
    expect(m.channelFindUnique).not.toHaveBeenCalled();
    expect(m.record).not.toHaveBeenCalled();
  });
});
