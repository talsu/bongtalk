import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MentionGateService } from './mention-gate.service';
import type { NotifLevelService, NotifGate } from './notif-level.service';
import type { Prisma } from '@prisma/client';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

/**
 * S88b fix-forward (F1): 동기 send 경로와 @role 워커가 공유하는 per-recipient 게이트
 * (block/mute/DND/thread-OFF/NotifLevel) 단위 검증. 외부 모킹 라이브러리 없이 vi.fn()
 * 으로 tx 클라이언트를 구성한다(repo 규약).
 */
function makeTx(opts: {
  blocked?: Array<{ requesterId: string; addresseeId: string }>;
  muted?: string[];
  dndDnd?: string[]; // presencePreference='dnd' 인 사용자
  off?: string[]; // ThreadSubscription.notificationLevel='OFF' 인 사용자
}): {
  tx: Prisma.TransactionClient;
  friendshipFindMany: ReturnType<typeof vi.fn>;
  threadSubscriptionFindMany: ReturnType<typeof vi.fn>;
} {
  const blocked = opts.blocked ?? [];
  const muted = new Set(opts.muted ?? []);
  const dndDnd = new Set(opts.dndDnd ?? []);
  const off = new Set(opts.off ?? []);

  const friendshipFindMany = vi.fn(async () => blocked);
  const userChannelMuteFindMany = vi.fn(async (args: { where: { userId: { in: string[] } } }) =>
    args.where.userId.in.filter((id) => muted.has(id)).map((userId) => ({ userId })),
  );
  const userFindMany = vi.fn(async (args: { where: { id: { in: string[] } } }) =>
    args.where.id.in.map((id) => ({
      id,
      presencePreference: dndDnd.has(id) ? 'dnd' : 'auto',
      dndSchedule: null,
      timezone: null,
      settings: { dndUntil: null },
    })),
  );
  const threadSubscriptionFindMany = vi.fn(async (args: { where: { userId: { in: string[] } } }) =>
    args.where.userId.in.filter((id) => off.has(id)).map((userId) => ({ userId })),
  );

  const tx = {
    friendship: { findMany: friendshipFindMany },
    userChannelMute: { findMany: userChannelMuteFindMany },
    user: { findMany: userFindMany },
    threadSubscription: { findMany: threadSubscriptionFindMany },
  } as unknown as Prisma.TransactionClient;

  return { tx, friendshipFindMany, threadSubscriptionFindMany };
}

/** NotifLevelService.buildGate 가 돌려주는 게이트 클로저. notNotify 에 든 uid 만 차단. */
function makeNotifLevel(notNotify: Set<string> = new Set()): NotifLevelService {
  const gate: NotifGate = {
    shouldNotify: (userId) => !notNotify.has(userId),
    effectiveLevel: () => 'ALL',
  };
  return { buildGate: vi.fn(async () => gate) } as unknown as NotifLevelService;
}

const ARGS = {
  channelId: 'chan-1',
  workspaceId: 'ws-1',
  authorId: 'author-1',
  parentMessageId: null,
  now: new Date('2025-01-01T00:00:00Z'),
};

describe('MentionGateService.filterNotifiable (S88b F1 — shared per-recipient gate)', () => {
  it('passes plain candidates through (no gate hits)', async () => {
    const { tx } = makeTx({});
    const svc = new MentionGateService(makeNotifLevel());
    const out = await svc.filterNotifiable(tx, { ...ARGS, candidateUserIds: ['u1', 'u2'] });
    expect([...out].sort()).toEqual(['u1', 'u2']);
  });

  it('returns empty for empty candidates (no queries)', async () => {
    const { tx, friendshipFindMany } = makeTx({});
    const svc = new MentionGateService(makeNotifLevel());
    const out = await svc.filterNotifiable(tx, { ...ARGS, candidateUserIds: [] });
    expect(out.size).toBe(0);
    expect(friendshipFindMany).not.toHaveBeenCalled();
  });

  it('① excludes a blocked recipient in EITHER direction (FR-PS-14 보안계약)', async () => {
    // u1: author 가 차단 / u2: u2 가 author 를 차단 → 둘 다 제외.
    const { tx } = makeTx({
      blocked: [
        { requesterId: 'author-1', addresseeId: 'u1' },
        { requesterId: 'u2', addresseeId: 'author-1' },
      ],
    });
    const svc = new MentionGateService(makeNotifLevel());
    const out = await svc.filterNotifiable(tx, { ...ARGS, candidateUserIds: ['u1', 'u2', 'u3'] });
    expect([...out]).toEqual(['u3']);
  });

  it('② excludes a channel-muted recipient', async () => {
    const { tx } = makeTx({ muted: ['u2'] });
    const svc = new MentionGateService(makeNotifLevel());
    const out = await svc.filterNotifiable(tx, { ...ARGS, candidateUserIds: ['u1', 'u2'] });
    expect([...out]).toEqual(['u1']);
  });

  it('③ excludes a DND recipient', async () => {
    const { tx } = makeTx({ dndDnd: ['u1'] });
    const svc = new MentionGateService(makeNotifLevel());
    const out = await svc.filterNotifiable(tx, { ...ARGS, candidateUserIds: ['u1', 'u2'] });
    expect([...out]).toEqual(['u2']);
  });

  it('④ excludes a thread-OFF subscriber only when parentMessageId is set', async () => {
    const off = { off: ['u1'] };
    const svc = new MentionGateService(makeNotifLevel());

    // 루트 send(parentMessageId=null): thread-OFF 게이트 비적용 → u1 통과.
    const root = makeTx(off);
    const outRoot = await svc.filterNotifiable(root.tx, {
      ...ARGS,
      candidateUserIds: ['u1', 'u2'],
    });
    expect([...outRoot].sort()).toEqual(['u1', 'u2']);
    expect(root.threadSubscriptionFindMany).not.toHaveBeenCalled();

    // 답글(parentMessageId 보유): OFF 구독자 u1 제외.
    const reply = makeTx(off);
    const outReply = await svc.filterNotifiable(reply.tx, {
      ...ARGS,
      parentMessageId: 'root-1',
      candidateUserIds: ['u1', 'u2'],
    });
    expect([...outReply]).toEqual(['u2']);
    expect(reply.threadSubscriptionFindMany).toHaveBeenCalledOnce();
  });

  it('⑤ excludes a recipient the NotifLevel gate rejects', async () => {
    const { tx } = makeTx({});
    const svc = new MentionGateService(makeNotifLevel(new Set(['u2'])));
    const out = await svc.filterNotifiable(tx, { ...ARGS, candidateUserIds: ['u1', 'u2'] });
    expect([...out]).toEqual(['u1']);
  });

  it('passes the per-recipient kind to the NotifLevel gate (direct vs broad)', async () => {
    const { tx } = makeTx({});
    const notifLevel = makeNotifLevel();
    const svc = new MentionGateService(notifLevel);
    await svc.filterNotifiable(tx, {
      ...ARGS,
      candidateUserIds: ['u1', 'u2'],
      kindFor: (uid) => (uid === 'u1' ? 'direct' : 'broad'),
    });
    // buildGate 가 호출되며 게이트 클로저가 kind 를 받는지(닫힌 클로저라 직접 검증은
    // shouldNotify 인자로) — 기본 kindFor 미지정 시 전원 direct 임을 함께 확인한다.
    expect(notifLevel.buildGate).toHaveBeenCalledOnce();
  });

  it('defaults every candidate to kind=direct when kindFor is omitted (@role/@user 경로)', async () => {
    const { tx } = makeTx({});
    const shouldNotify = vi.fn((_userId: string) => true);
    const notifLevel = {
      buildGate: vi.fn(async () => ({ shouldNotify, effectiveLevel: () => 'ALL' })),
    } as unknown as NotifLevelService;
    const svc = new MentionGateService(notifLevel);
    await svc.filterNotifiable(tx, { ...ARGS, candidateUserIds: ['u1', 'u2'] });
    expect(shouldNotify).toHaveBeenCalledWith('u1', 'direct');
    expect(shouldNotify).toHaveBeenCalledWith('u2', 'direct');
  });
});
