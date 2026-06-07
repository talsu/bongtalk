import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Job } from 'bullmq';
import { MentionBroadcastProcessor } from './mention-broadcast.processor';
import type { MentionBroadcastJobData } from './mention-broadcast-queue.constants';
import type { PrismaService } from '../prisma/prisma.module';
import type { OutboxService } from '../common/outbox/outbox.service';
import type { ChannelAccessService } from '../channels/permission/channel-access.service';
import type { MentionGateService } from '../notifications/mention-gate.service';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

interface Mocks {
  prisma: PrismaService;
  outbox: OutboxService;
  channelAccess: ChannelAccessService;
  mentionGate: MentionGateService;
  channelFindUnique: ReturnType<typeof vi.fn>;
  messageFindUnique: ReturnType<typeof vi.fn>;
  memberRoleFindMany: ReturnType<typeof vi.fn>;
  filterChannelVisibleUsers: ReturnType<typeof vi.fn>;
  filterNotifiable: ReturnType<typeof vi.fn>;
  queryRaw: ReturnType<typeof vi.fn>;
  record: ReturnType<typeof vi.fn>;
}

function makeMocks(
  opts: {
    channelDeleted?: boolean;
    messageDeleted?: boolean;
    members?: string[];
    /** uids filtered OUT by VIEW_CHANNEL visibility (worker F4). */
    invisible?: Set<string>;
    /** uids filtered OUT by the shared per-recipient gate (worker F1). */
    gatedOut?: Set<string>;
    /** uids already present in MentionRecord — ON CONFLICT skips them (idempotency / F5). */
    existing?: Set<string>;
  } = {},
): Mocks {
  const members = opts.members ?? ['u1', 'u2'];
  const invisible = opts.invisible ?? new Set<string>();
  const gatedOut = opts.gatedOut ?? new Set<string>();
  const existing = opts.existing ?? new Set<string>();

  const channelFindUnique = vi.fn(async () =>
    opts.channelDeleted ? null : { id: 'chan-1', isPrivate: false, deletedAt: null },
  );
  const messageFindUnique = vi.fn(async () =>
    opts.messageDeleted ? { id: 'msg-1', deletedAt: new Date() } : { id: 'msg-1', deletedAt: null },
  );
  const memberRoleFindMany = vi.fn(async () => members.map((userId) => ({ userId })));

  // F4: 워커는 per-user hasPermission 루프 대신 단일 filterChannelVisibleUsers 호출.
  const filterChannelVisibleUsers = vi.fn(
    async (
      _channel: { id: string; isPrivate: boolean },
      _workspaceId: string,
      candidateUserIds: string[],
    ) => new Set(candidateUserIds.filter((id) => !invisible.has(id))),
  );

  // F1: 워커는 공유 게이트(filterNotifiable)를 가시 후보에 적용.
  const filterNotifiable = vi.fn(
    async (_tx: unknown, args: { candidateUserIds: string[] }) =>
      new Set(args.candidateUserIds.filter((id) => !gatedOut.has(id))),
  );

  // F5: tx.$queryRaw INSERT … ON CONFLICT DO NOTHING RETURNING "targetId" — 기존 행은 skip.
  const queryRaw = vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    // values[2] 는 targetIds 배열(SELECT … FROM unnest($targetIds)). 보간 순서:
    // messageId, channelId, workspaceId, targetIds — 실제 SQL 의 ${} 순서에 의존하지
    // 않도록, 배열 타입 인자를 찾아 그것을 신규 후보로 본다.
    const arr = values.find((v): v is string[] => Array.isArray(v)) ?? [];
    return arr.filter((id) => !existing.has(id)).map((targetId) => ({ targetId }));
  });
  const record = vi.fn(async () => 'outbox-1');

  const txClient = { $queryRaw: queryRaw };
  const $transaction = vi.fn(async (cb: (tx: typeof txClient) => Promise<void>) => cb(txClient));

  const prisma = {
    channel: { findUnique: channelFindUnique },
    message: { findUnique: messageFindUnique },
    memberRole: { findMany: memberRoleFindMany },
    $transaction,
  } as unknown as PrismaService;

  const outbox = { record } as unknown as OutboxService;
  const channelAccess = { filterChannelVisibleUsers } as unknown as ChannelAccessService;
  const mentionGate = { filterNotifiable } as unknown as MentionGateService;

  return {
    prisma,
    outbox,
    channelAccess,
    mentionGate,
    channelFindUnique,
    messageFindUnique,
    memberRoleFindMany,
    filterChannelVisibleUsers,
    filterNotifiable,
    queryRaw,
    record,
  };
}

function makeProcessor(m: Mocks): MentionBroadcastProcessor {
  return new MentionBroadcastProcessor(m.prisma, m.outbox, m.channelAccess, m.mentionGate);
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
      parentMessageId: null,
      gatedRoleIds: ['role-1'],
      syncNotifiedUserIds: [],
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

function recordedTargets(m: Mocks): string[] {
  return m.queryRaw.mock.calls
    .flatMap((c) => (c.slice(1).find((v): v is string[] => Array.isArray(v)) ?? []) as string[])
    .sort();
}

describe('S88b MentionBroadcastProcessor (FR-MN-03 · FR-MN-19)', () => {
  it('expands role members → records one MentionRecord row + one outbox per new recipient', async () => {
    const m = makeMocks({ members: ['u1', 'u2'] });
    await makeProcessor(m).process(job());

    expect(m.memberRoleFindMany).toHaveBeenCalledOnce();
    // 가시성 + 게이트 통과 후 INSERT … RETURNING 으로 신규 2명.
    expect(recordedTargets(m)).toEqual(['u1', 'u2']);
    // outbox 2건(신규 수신자 1인당 1건) · 전부 role=true.
    expect(m.record).toHaveBeenCalledTimes(2);
    const payloads = m.record.mock.calls.map((c) => c[1].payload);
    expect(payloads.every((pl) => pl.role === true)).toBe(true);
    expect(payloads.every((pl) => pl.messageId === 'msg-1')).toBe(true);
    expect(payloads.map((pl) => pl.targetUserId).sort()).toEqual(['u1', 'u2']);
  });

  it('excludes the message author (self-mention) from expansion', async () => {
    const m = makeMocks({ members: ['author-1', 'u2'] });
    await makeProcessor(m).process(job());
    expect(recordedTargets(m)).toEqual(['u2']);
  });

  it('F2 cross-path dedup: excludes recipients already notified synchronously (@user ∪ broad)', async () => {
    // u1 은 동기 경로(@user 또는 broad)가 이미 mention.received 1건 발송 완료
    // (syncNotifiedUserIds). 워커는 @role expand 에서 u1 을 제외해 u2 만 기록.
    const m = makeMocks({ members: ['u1', 'u2'] });
    await makeProcessor(m).process(job({ syncNotifiedUserIds: ['u1'] }));

    expect(recordedTargets(m)).toEqual(['u2']);
    expect(m.record).toHaveBeenCalledTimes(1);
    expect(m.record.mock.calls[0][1].payload.targetUserId).toBe('u2');
    // 동기 알림 수신자는 가시성/게이트 평가 대상에서도 빠진다(불필요한 조회 회피).
    const visArg = m.filterChannelVisibleUsers.mock.calls[0][2] as string[];
    expect(visArg).not.toContain('u1');
  });

  it('F2: no-op when every role member was already notified synchronously', async () => {
    const m = makeMocks({ members: ['u1', 'u2'] });
    await makeProcessor(m).process(job({ syncNotifiedUserIds: ['u1', 'u2'] }));
    expect(m.filterChannelVisibleUsers).not.toHaveBeenCalled();
    expect(m.queryRaw).not.toHaveBeenCalled();
    expect(m.record).not.toHaveBeenCalled();
  });

  it('F4: skips VIEW_CHANNEL-invisible members (no record / no outbox)', async () => {
    const m = makeMocks({ members: ['u1', 'u2'], invisible: new Set(['u2']) });
    await makeProcessor(m).process(job());
    expect(recordedTargets(m)).toEqual(['u1']);
    expect(m.record).toHaveBeenCalledTimes(1);
    expect(m.record.mock.calls[0][1].payload.targetUserId).toBe('u1');
  });

  it('F1 ★BLOCKER: skips members filtered out by the shared per-recipient gate (block/mute/DND/OFF/NotifLevel)', async () => {
    // u2 가 차단/뮤트/DND/OFF/NotifLevel 중 하나로 게이트 탈락 → MentionRecord/outbox 미생성.
    const m = makeMocks({ members: ['u1', 'u2'], gatedOut: new Set(['u2']) });
    await makeProcessor(m).process(job());
    // 게이트는 @role 을 'direct' 로 분류해 호출된다(개인 멘션 parity).
    expect(m.filterNotifiable).toHaveBeenCalledOnce();
    const gateArgs = m.filterNotifiable.mock.calls[0][1] as {
      kindFor: (u: string) => string;
      candidateUserIds: string[];
    };
    expect(gateArgs.kindFor('u1')).toBe('direct');
    expect(recordedTargets(m)).toEqual(['u1']);
    expect(m.record).toHaveBeenCalledTimes(1);
    expect(m.record.mock.calls[0][1].payload.targetUserId).toBe('u1');
  });

  it('F1: passes parentMessageId to the gate so thread-OFF is evaluated on replies', async () => {
    const m = makeMocks({ members: ['u1'] });
    await makeProcessor(m).process(job({ parentMessageId: 'root-1' }));
    const gateArgs = m.filterNotifiable.mock.calls[0][1] as { parentMessageId: string | null };
    expect(gateArgs.parentMessageId).toBe('root-1');
  });

  it('F5: idempotent — a re-processed job inserts no new row (ON CONFLICT) and emits no outbox', async () => {
    const m = makeMocks({ members: ['u1', 'u2'], existing: new Set(['u1', 'u2']) });
    await makeProcessor(m).process(job());
    // RETURNING 이 빈 배열(전부 기존) → outbox 0.
    expect(m.record).not.toHaveBeenCalled();
  });

  it('F5: records outbox only for the newly-inserted recipient when one already existed', async () => {
    const m = makeMocks({ members: ['u1', 'u2'], existing: new Set(['u1']) });
    await makeProcessor(m).process(job());
    // RETURNING 은 신규 삽입분 u2 만 → outbox 1건(u2). u1 은 사전조회 newIds 가 아니라
    // 실제 삽입분 기준이므로 동시 재처리에도 이중 발송되지 않는다.
    expect(m.record).toHaveBeenCalledTimes(1);
    expect(m.record.mock.calls[0][1].payload.targetUserId).toBe('u2');
  });

  it('skips entirely when the message is soft-deleted', async () => {
    const m = makeMocks({ messageDeleted: true });
    await makeProcessor(m).process(job());
    expect(m.memberRoleFindMany).not.toHaveBeenCalled();
    expect(m.queryRaw).not.toHaveBeenCalled();
    expect(m.record).not.toHaveBeenCalled();
  });

  it('is a no-op when no gated roles are present', async () => {
    const m = makeMocks();
    await makeProcessor(m).process(job({ gatedRoleIds: [] }));
    expect(m.channelFindUnique).not.toHaveBeenCalled();
    expect(m.record).not.toHaveBeenCalled();
  });
});
