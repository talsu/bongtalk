import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import { OnboardingWelcomeProcessor } from '../../../src/queue/onboarding-welcome.processor';
import type { PrismaService } from '../../../src/prisma/prisma.module';
import type { OutboxService } from '../../../src/common/outbox/outbox.service';
import type { OnboardingWelcomeJobData } from '../../../src/queue/onboarding-welcome.constants';
import { MESSAGE_CREATED } from '../../../src/messages/events/message-events';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CH_ID = '33333333-3333-4333-8333-333333333333';

function makeOutbox() {
  const records: { eventType: string; payload: Record<string, unknown> }[] = [];
  const svc = {
    record: vi.fn(
      async (_tx: unknown, input: { eventType: string; payload: Record<string, unknown> }) => {
        records.push({ eventType: input.eventType, payload: input.payload });
        return 'id';
      },
    ),
  } as unknown as OutboxService;
  return { svc, records };
}

function job(data: OnboardingWelcomeJobData): Job<OnboardingWelcomeJobData> {
  return { data } as Job<OnboardingWelcomeJobData>;
}

/** $transaction 콜백을 즉시 실행하는 tx 모킹(message.create + outbox 기록을 통과시킴). */
function makeTx(createdId = 'msg-1') {
  return {
    channel: { create: vi.fn(async () => ({ id: CH_ID })) },
    channelPermissionOverride: { create: vi.fn(async () => ({})) },
    message: {
      create: vi.fn(async () => ({
        id: createdId,
        authorId: OWNER,
        content: 'x',
        contentRaw: 'x',
        createdAt: new Date('2025-01-01T00:00:00Z'),
        parentMessageId: null,
      })),
    },
  };
}

describe('S71 OnboardingWelcomeProcessor', () => {
  it('웰컴 설정이 없으면 skip 합니다(메시지/DM 미발행)', async () => {
    const outbox = makeOutbox();
    const prisma = {
      workspaceWelcome: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const proc = new OnboardingWelcomeProcessor(prisma, outbox.svc);
    await proc.process(job({ workspaceId: WS, userId: MEMBER }));
    expect(outbox.records).toHaveLength(0);
  });

  it('welcomeChannelId 가 있으면 입장 SYSTEM_MEMBER_JOINED 메시지를 게시합니다', async () => {
    const outbox = makeOutbox();
    const tx = makeTx();
    const prisma = {
      workspaceWelcome: {
        findUnique: vi.fn().mockResolvedValue({ welcomeChannelId: CH_ID, message: null }),
      },
      workspace: { findUnique: vi.fn().mockResolvedValue({ ownerId: OWNER }) },
      workspaceMember: { findUnique: vi.fn().mockResolvedValue({ userId: MEMBER }) },
      channel: { findFirst: vi.fn().mockResolvedValue({ id: CH_ID }) },
      user: { findUnique: vi.fn().mockResolvedValue({ username: 'alice' }) },
      $transaction: vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    } as unknown as PrismaService;
    const proc = new OnboardingWelcomeProcessor(prisma, outbox.svc);
    await proc.process(job({ workspaceId: WS, userId: MEMBER }));
    const created = outbox.records.filter((r) => r.eventType === MESSAGE_CREATED);
    expect(created).toHaveLength(1);
    expect((created[0].payload.message as { type: string }).type).toBe('SYSTEM_MEMBER_JOINED');
    expect(created[0].payload.workspaceId).toBe(WS);
  });

  it('welcome.message 가 있으면 owner→member DM 에 웰컴 본문을 게시합니다', async () => {
    const outbox = makeOutbox();
    const tx = makeTx();
    const prisma = {
      workspaceWelcome: {
        findUnique: vi.fn().mockResolvedValue({ welcomeChannelId: null, message: '환영합니다!' }),
      },
      workspace: { findUnique: vi.fn().mockResolvedValue({ ownerId: OWNER }) },
      workspaceMember: { findUnique: vi.fn().mockResolvedValue({ userId: MEMBER }) },
      // DM createOrGet — 기존 채널 없음 → 새로 생성.
      channel: { findFirst: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    } as unknown as PrismaService;
    const proc = new OnboardingWelcomeProcessor(prisma, outbox.svc);
    await proc.process(job({ workspaceId: WS, userId: MEMBER }));
    // dm.created + message.created 가 기록된다(DM 메시지는 workspaceId=null 라우팅).
    const msgCreated = outbox.records.filter((r) => r.eventType === MESSAGE_CREATED);
    expect(msgCreated).toHaveLength(1);
    expect(msgCreated[0].payload.workspaceId).toBeNull();
    expect((msgCreated[0].payload.message as { type: string }).type).toBe('DEFAULT');
  });

  it('멤버가 떠났으면(멤버십 부재) skip 합니다', async () => {
    const outbox = makeOutbox();
    const prisma = {
      workspaceWelcome: {
        findUnique: vi.fn().mockResolvedValue({ welcomeChannelId: CH_ID, message: 'hi' }),
      },
      workspace: { findUnique: vi.fn().mockResolvedValue({ ownerId: OWNER }) },
      workspaceMember: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const proc = new OnboardingWelcomeProcessor(prisma, outbox.svc);
    await proc.process(job({ workspaceId: WS, userId: MEMBER }));
    expect(outbox.records).toHaveLength(0);
  });
});
