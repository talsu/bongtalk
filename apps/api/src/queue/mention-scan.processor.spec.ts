import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Job } from 'bullmq';
import { MentionScanProcessor } from './mention-scan.processor';
import type { MentionScanJobData } from './mention-scan-queue.constants';
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
  watcherQuery: ReturnType<typeof vi.fn>;
  filterChannelVisibleUsers: ReturnType<typeof vi.fn>;
  filterNotifiable: ReturnType<typeof vi.fn>;
  txQueryRaw: ReturnType<typeof vi.fn>;
  record: ReturnType<typeof vi.fn>;
}

/** SQL 템플릿의 첫 토큰으로 호출 종류(watcher / 기존-record dedup / INSERT)를 구분. */
function classifySql(strings: TemplateStringsArray): 'watchers' | 'existing' | 'insert' | 'other' {
  const head = strings.join(' ');
  if (head.includes('INSERT INTO "MentionRecord"')) return 'insert';
  if (head.includes('FROM "UserSettings"')) return 'watchers';
  if (head.includes('FROM "MentionRecord"')) return 'existing';
  return 'other';
}

function makeMocks(
  opts: {
    channelDeleted?: boolean;
    isPrivate?: boolean;
    messageDeleted?: boolean;
    parentMessageId?: string | null;
    contentPlain?: string | null;
    /** watcher 후보(작성자 제외·keywords 보유). SQL 의 self/array_length 필터는 여기서 흉내낸다. */
    watchers?: Array<{ userId: string; keywords: string[] }>;
    invisible?: Set<string>;
    gatedOut?: Set<string>;
    /** 이 메시지에 이미 MentionRecord 가 있는 targetId(기존-record dedup · 단계 6). */
    existing?: Set<string>;
    /** ON CONFLICT 로 실제 INSERT 안 된 targetId(멱등 재처리 · 단계 7). */
    conflict?: Set<string>;
  } = {},
): Mocks {
  const watchers = opts.watchers ?? [{ userId: 'u1', keywords: ['deploy'] }];
  const invisible = opts.invisible ?? new Set<string>();
  const gatedOut = opts.gatedOut ?? new Set<string>();
  const existing = opts.existing ?? new Set<string>();
  const conflict = opts.conflict ?? new Set<string>();

  const channelFindUnique = vi.fn(async () =>
    opts.channelDeleted
      ? null
      : { id: 'chan-1', isPrivate: opts.isPrivate ?? false, deletedAt: null },
  );
  const messageFindUnique = vi.fn(async () => ({
    id: 'msg-1',
    deletedAt: opts.messageDeleted ? new Date() : null,
    parentMessageId: opts.parentMessageId ?? null,
    contentPlain: opts.contentPlain ?? 'please deploy now',
  }));

  // 단계 2: this.prisma.$queryRaw(watcher 후보 조회).
  const watcherQuery = vi.fn(async () => watchers);
  const prismaQueryRaw = vi.fn(async (strings: TemplateStringsArray) => {
    if (classifySql(strings) === 'watchers') return watcherQuery();
    return [];
  });

  const filterChannelVisibleUsers = vi.fn(
    async (
      _channel: { id: string; isPrivate: boolean },
      _workspaceId: string,
      candidateUserIds: string[],
    ) => new Set(candidateUserIds.filter((id) => !invisible.has(id))),
  );
  const filterNotifiable = vi.fn(
    async (_tx: unknown, args: { candidateUserIds: string[] }) =>
      new Set(args.candidateUserIds.filter((id) => !gatedOut.has(id))),
  );

  // tx.$queryRaw: 단계 6(기존-record dedup) + 단계 7(INSERT … RETURNING).
  const txQueryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const kind = classifySql(strings);
    const arr = values.find((v): v is string[] => Array.isArray(v)) ?? [];
    if (kind === 'existing') {
      return arr.filter((id) => existing.has(id)).map((targetId) => ({ targetId }));
    }
    // insert: ON CONFLICT 로 conflict 집합은 RETURNING 에서 빠진다(실 삽입분만).
    return arr.filter((id) => !conflict.has(id)).map((targetId) => ({ targetId }));
  });
  const record = vi.fn(async () => 'outbox-1');

  const txClient = { $queryRaw: txQueryRaw };
  const $transaction = vi.fn(async (cb: (tx: typeof txClient) => Promise<void>) => cb(txClient));

  const prisma = {
    channel: { findUnique: channelFindUnique },
    message: { findUnique: messageFindUnique },
    $queryRaw: prismaQueryRaw,
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
    watcherQuery,
    filterChannelVisibleUsers,
    filterNotifiable,
    txQueryRaw,
    record,
  };
}

function makeProcessor(m: Mocks): MentionScanProcessor {
  return new MentionScanProcessor(m.prisma, m.outbox, m.channelAccess, m.mentionGate);
}

function job(
  data: Partial<MentionScanJobData> = {},
  over: { attemptsMade?: number } = {},
): Job<MentionScanJobData> {
  return {
    data: {
      messageId: 'msg-1',
      channelId: 'chan-1',
      workspaceId: 'ws-1',
      actorId: 'author-1',
      snippet: 'please deploy now',
      createdAt: '2025-01-01T00:00:00.000Z',
      syncNotifiedUserIds: [],
      ...data,
    },
    attemptsMade: over.attemptsMade ?? 0,
    opts: { attempts: 3 },
  } as Job<MentionScanJobData>;
}

/** INSERT 호출에 전달된 targetId 배열(실제 기록 대상). */
function insertedTargets(m: Mocks): string[] {
  const call = m.txQueryRaw.mock.calls.find(
    (c) => classifySql(c[0] as TemplateStringsArray) === 'insert',
  );
  if (!call) return [];
  return ((call.slice(1).find((v): v is string[] => Array.isArray(v)) ?? []) as string[]).sort();
}

describe('FR-MN-10 MentionScanProcessor', () => {
  it('루트 키워드 일치 → watcher 에 MentionRecord(KEYWORD) + outbox(keyword:true)', async () => {
    const m = makeMocks({ watchers: [{ userId: 'u1', keywords: ['deploy'] }] });
    await makeProcessor(m).process(job());

    expect(insertedTargets(m)).toEqual(['u1']);
    expect(m.record).toHaveBeenCalledTimes(1);
    const payload = m.record.mock.calls[0][1].payload;
    expect(payload.keyword).toBe(true);
    expect(payload.role).toBe(false);
    expect(payload.everyone).toBe(false);
    expect(payload.here).toBe(false);
    expect(payload.targetUserId).toBe('u1');
    expect(payload.messageId).toBe('msg-1');
  });

  it('스레드 댓글(parentMessageId≠null)은 방어적으로 skip — 조회/기록 없음', async () => {
    const m = makeMocks({ parentMessageId: 'root-1' });
    await makeProcessor(m).process(job());
    expect(m.watcherQuery).not.toHaveBeenCalled();
    expect(m.record).not.toHaveBeenCalled();
  });

  it('메시지 soft-delete 시 전체 skip', async () => {
    const m = makeMocks({ messageDeleted: true });
    await makeProcessor(m).process(job());
    expect(m.watcherQuery).not.toHaveBeenCalled();
    expect(m.record).not.toHaveBeenCalled();
  });

  it('채널 삭제 시 전체 skip', async () => {
    const m = makeMocks({ channelDeleted: true });
    await makeProcessor(m).process(job());
    expect(m.watcherQuery).not.toHaveBeenCalled();
    expect(m.record).not.toHaveBeenCalled();
  });

  it('빈 본문이면 watcher 조회 없이 early-return', async () => {
    const m = makeMocks({ contentPlain: '   ' });
    await makeProcessor(m).process(job());
    expect(m.watcherQuery).not.toHaveBeenCalled();
  });

  it('키워드 불일치 watcher 는 기록 안 함(whole-word — "redeploys" 에 "deploy" 불가)', async () => {
    const m = makeMocks({
      contentPlain: 'we had redeploys today',
      watchers: [{ userId: 'u1', keywords: ['deploy'] }],
    });
    await makeProcessor(m).process(job());
    expect(m.filterChannelVisibleUsers).not.toHaveBeenCalled();
    expect(m.record).not.toHaveBeenCalled();
  });

  it('syncNotified 수신자는 매칭 후보에서 제외(이중 record 방지)', async () => {
    const m = makeMocks({
      contentPlain: 'deploy now',
      watchers: [
        { userId: 'u1', keywords: ['deploy'] },
        { userId: 'u2', keywords: ['deploy'] },
      ],
    });
    await makeProcessor(m).process(job({ syncNotifiedUserIds: ['u1'] }));
    expect(insertedTargets(m)).toEqual(['u2']);
  });

  it('VIEW_CHANNEL 비가시 watcher 제외(비공개 비멤버)', async () => {
    const m = makeMocks({
      contentPlain: 'deploy now',
      isPrivate: true,
      watchers: [
        { userId: 'u1', keywords: ['deploy'] },
        { userId: 'u2', keywords: ['deploy'] },
      ],
      invisible: new Set(['u2']),
    });
    await makeProcessor(m).process(job());
    expect(insertedTargets(m)).toEqual(['u1']);
    expect(m.record).toHaveBeenCalledTimes(1);
  });

  it('게이트(mute/DND/block/NotifLevel=NOTHING) 탈락 watcher 제외 · kindFor=direct', async () => {
    const m = makeMocks({
      contentPlain: 'deploy now',
      watchers: [
        { userId: 'u1', keywords: ['deploy'] },
        { userId: 'u2', keywords: ['deploy'] },
      ],
      gatedOut: new Set(['u2']),
    });
    await makeProcessor(m).process(job());
    const gateArgs = m.filterNotifiable.mock.calls[0][1] as {
      kindFor: (u: string) => string;
      parentMessageId: string | null;
    };
    expect(gateArgs.kindFor('u1')).toBe('direct');
    expect(gateArgs.parentMessageId).toBeNull();
    expect(insertedTargets(m)).toEqual(['u1']);
  });

  it('기존 MentionRecord 보유 수신자 제외(@role/@user record 와 이중 Inbox 방지)', async () => {
    const m = makeMocks({
      contentPlain: 'deploy now',
      watchers: [
        { userId: 'u1', keywords: ['deploy'] },
        { userId: 'u2', keywords: ['deploy'] },
      ],
      existing: new Set(['u1']),
    });
    await makeProcessor(m).process(job());
    // u1 은 이미 기록돼 INSERT 대상에서 빠진다.
    expect(insertedTargets(m)).toEqual(['u2']);
    expect(m.record).toHaveBeenCalledTimes(1);
    expect(m.record.mock.calls[0][1].payload.targetUserId).toBe('u2');
  });

  it('멱등: ON CONFLICT 로 전부 기존이면 outbox 0', async () => {
    const m = makeMocks({
      contentPlain: 'deploy now',
      watchers: [{ userId: 'u1', keywords: ['deploy'] }],
      conflict: new Set(['u1']),
    });
    await makeProcessor(m).process(job());
    expect(m.record).not.toHaveBeenCalled();
  });
});
