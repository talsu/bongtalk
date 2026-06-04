import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingService } from '../../../src/workspaces/onboarding/onboarding.service';
import type { PrismaService } from '../../../src/prisma/prisma.module';
import type { OnboardingWelcomeQueueService } from '../../../src/queue/onboarding-welcome-queue.service';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const Q_ID = '22222222-2222-4222-8222-222222222222';
const CH_ID = '33333333-3333-4333-8333-333333333333';
const ROLE_ID = '44444444-4444-4444-8444-444444444444';

async function expectDomainError(p: Promise<unknown>, code: ErrorCode) {
  await expect(p).rejects.toMatchObject({ code });
}

function makeWelcomeQueue(): {
  svc: OnboardingWelcomeQueueService;
  enqueue: ReturnType<typeof vi.fn>;
} {
  const enqueue = vi.fn().mockResolvedValue(undefined);
  return { svc: { enqueue } as unknown as OnboardingWelcomeQueueService, enqueue };
}

/**
 * complete() 의 $transaction 을 모킹한다. callback 에 넘기는 tx 는 $executeRaw(채널/역할
 * INSERT)와 workspaceMember.update 를 기록한다. raw SQL 문자열에서 테이블명을 추출해
 * 채널 구독·역할 부여 횟수를 센다.
 */
function makeTxRecorder() {
  const channelInserts: string[] = [];
  const roleInserts: string[] = [];
  const memberUpdates: Record<string, unknown>[] = [];
  const tx = {
    $executeRaw: vi.fn(async (...args: unknown[]) => {
      // Prisma.sql 태그드 템플릿 — 첫 인자는 strings 배열. 본문으로 테이블 분기.
      const strings = (args[0] as { strings?: string[] })?.strings ?? [];
      const sqlText = strings.join(' ');
      if (sqlText.includes('ChannelPermissionOverride')) channelInserts.push(sqlText);
      else if (sqlText.includes('MemberRole')) roleInserts.push(sqlText);
      return 1;
    }),
    workspaceMember: {
      update: vi.fn(async (input: { data: Record<string, unknown> }) => {
        memberUpdates.push(input.data);
        return {};
      }),
    },
  };
  return { tx, channelInserts, roleInserts, memberUpdates };
}

describe('S71 OnboardingService.getState', () => {
  it('비멤버는 WORKSPACE_NOT_MEMBER(404)로 거부합니다', async () => {
    const prisma = {
      workspaceMember: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const svc = new OnboardingService(prisma, makeWelcomeQueue().svc);
    await expectDomainError(svc.getState(WS, USER), ErrorCode.WORKSPACE_NOT_MEMBER);
  });

  it('규칙·질문·웰컴 카탈로그와 진행 상태를 합쳐 반환합니다', async () => {
    const prisma = {
      workspaceMember: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ rulesAcceptedAt: null, onboardingCompletedAt: null }),
      },
      workspaceRule: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: 'r1', position: 0, title: 'Be kind', description: null }]),
      },
      onboardingQuestion: { findMany: vi.fn().mockResolvedValue([]) },
      workspaceWelcome: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const svc = new OnboardingService(prisma, makeWelcomeQueue().svc);
    const state = await svc.getState(WS, USER);
    expect(state.rules).toHaveLength(1);
    expect(state.questions).toEqual([]);
    expect(state.welcome).toBeNull();
    expect(state.rulesAcceptedAt).toBeNull();
  });
});

describe('S71 OnboardingService.acceptRules', () => {
  it('rulesAcceptedAt 을 현재 시각으로 세팅합니다(멱등)', async () => {
    const update = vi.fn().mockResolvedValue({});
    const prisma = { workspaceMember: { update } } as unknown as PrismaService;
    const svc = new OnboardingService(prisma, makeWelcomeQueue().svc);
    const at = await svc.acceptRules(WS, USER);
    expect(at).toEqual(new Date('2025-01-01T00:00:00Z'));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { rulesAcceptedAt: at } }));
  });

  it('멤버 부재(P2025)는 WORKSPACE_NOT_MEMBER 로 변환합니다', async () => {
    const { Prisma } = await import('@prisma/client');
    const err = new Prisma.PrismaClientKnownRequestError('not found', {
      code: 'P2025',
      clientVersion: '5',
    });
    const prisma = {
      workspaceMember: { update: vi.fn().mockRejectedValue(err) },
    } as unknown as PrismaService;
    const svc = new OnboardingService(prisma, makeWelcomeQueue().svc);
    await expectDomainError(svc.acceptRules(WS, USER), ErrorCode.WORKSPACE_NOT_MEMBER);
  });
});

describe('S71 OnboardingService.complete — 원자 tx + 멱등', () => {
  it('SINGLE 선택지의 채널 구독 + 역할 부여를 단일 tx 로 처리하고 completedAt 을 세팅합니다', async () => {
    const rec = makeTxRecorder();
    const question = {
      id: Q_ID,
      position: 0,
      type: 'SINGLE',
      isRequired: true,
      label: 'interests',
      options: [{ id: 'o1', label: 'FE', channelIds: [CH_ID], roleId: ROLE_ID }],
    };
    const prisma = {
      workspaceMember: { findUnique: vi.fn().mockResolvedValue({ userId: USER }) },
      onboardingQuestion: { findMany: vi.fn().mockResolvedValue([question]) },
      channel: { findMany: vi.fn().mockResolvedValue([{ id: CH_ID }]) },
      role: { findMany: vi.fn().mockResolvedValue([{ id: ROLE_ID }]) },
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(rec.tx)),
    } as unknown as PrismaService;
    const wq = makeWelcomeQueue();
    const svc = new OnboardingService(prisma, wq.svc);
    const res = await svc.complete(WS, USER, {
      answers: [{ questionId: Q_ID, optionIds: ['o1'] }],
    });
    expect(res.joinedChannelCount).toBe(1);
    expect(res.assignedRoleCount).toBe(1);
    expect(rec.channelInserts).toHaveLength(1);
    expect(rec.roleInserts).toHaveLength(1);
    expect(rec.memberUpdates[0].onboardingCompletedAt).toEqual(new Date('2025-01-01T00:00:00Z'));
    // 시스템 DM/입장 메시지는 tx 커밋 후 BullMQ enqueue.
    expect(wq.enqueue).toHaveBeenCalledWith(WS, USER);
  });

  it('채널/역할 INSERT 는 ON CONFLICT DO NOTHING 으로 멱등합니다', async () => {
    const rec = makeTxRecorder();
    const question = {
      id: Q_ID,
      position: 0,
      type: 'MULTI',
      isRequired: false,
      label: 'q',
      options: [{ id: 'o1', label: 'a', channelIds: [CH_ID], roleId: ROLE_ID }],
    };
    const prisma = {
      workspaceMember: { findUnique: vi.fn().mockResolvedValue({ userId: USER }) },
      onboardingQuestion: { findMany: vi.fn().mockResolvedValue([question]) },
      channel: { findMany: vi.fn().mockResolvedValue([{ id: CH_ID }]) },
      role: { findMany: vi.fn().mockResolvedValue([{ id: ROLE_ID }]) },
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(rec.tx)),
    } as unknown as PrismaService;
    const svc = new OnboardingService(prisma, makeWelcomeQueue().svc);
    await svc.complete(WS, USER, { answers: [{ questionId: Q_ID, optionIds: ['o1'] }] });
    expect(rec.channelInserts[0]).toContain('ON CONFLICT');
    expect(rec.channelInserts[0]).toContain('DO NOTHING');
    expect(rec.roleInserts[0]).toContain('ON CONFLICT');
    expect(rec.roleInserts[0]).toContain('DO NOTHING');
  });

  it("'건너뛰기'(빈 answers)는 채널/역할 미실행 · completedAt 만 세팅합니다", async () => {
    const rec = makeTxRecorder();
    const prisma = {
      workspaceMember: { findUnique: vi.fn().mockResolvedValue({ userId: USER }) },
      onboardingQuestion: { findMany: vi.fn().mockResolvedValue([]) },
      channel: { findMany: vi.fn() },
      role: { findMany: vi.fn() },
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(rec.tx)),
    } as unknown as PrismaService;
    const svc = new OnboardingService(prisma, makeWelcomeQueue().svc);
    const res = await svc.complete(WS, USER, { answers: [] });
    expect(res.joinedChannelCount).toBe(0);
    expect(res.assignedRoleCount).toBe(0);
    expect(rec.channelInserts).toHaveLength(0);
    expect(rec.roleInserts).toHaveLength(0);
    expect(rec.memberUpdates[0].onboardingCompletedAt).toBeInstanceOf(Date);
  });

  it('카탈로그에 없는 optionId 는 ONBOARDING_INVALID_OPTION(400)으로 거부합니다', async () => {
    const question = {
      id: Q_ID,
      position: 0,
      type: 'SINGLE',
      isRequired: true,
      label: 'q',
      options: [{ id: 'o1', label: 'a', channelIds: [], roleId: null }],
    };
    const prisma = {
      workspaceMember: { findUnique: vi.fn().mockResolvedValue({ userId: USER }) },
      onboardingQuestion: { findMany: vi.fn().mockResolvedValue([question]) },
      channel: { findMany: vi.fn() },
      role: { findMany: vi.fn() },
    } as unknown as PrismaService;
    const svc = new OnboardingService(prisma, makeWelcomeQueue().svc);
    await expectDomainError(
      svc.complete(WS, USER, { answers: [{ questionId: Q_ID, optionIds: ['nope'] }] }),
      ErrorCode.ONBOARDING_INVALID_OPTION,
    );
  });

  it('SHORT_TEXT 답변은 onboardingAnswers 에 저장합니다', async () => {
    const rec = makeTxRecorder();
    const question = {
      id: Q_ID,
      position: 0,
      type: 'SHORT_TEXT',
      isRequired: false,
      label: 'about you',
      options: [],
    };
    const prisma = {
      workspaceMember: { findUnique: vi.fn().mockResolvedValue({ userId: USER }) },
      onboardingQuestion: { findMany: vi.fn().mockResolvedValue([question]) },
      channel: { findMany: vi.fn() },
      role: { findMany: vi.fn() },
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(rec.tx)),
    } as unknown as PrismaService;
    const svc = new OnboardingService(prisma, makeWelcomeQueue().svc);
    await svc.complete(WS, USER, {
      answers: [{ questionId: Q_ID, optionIds: [], text: 'hello world' }],
    });
    expect(rec.memberUpdates[0].onboardingAnswers).toEqual([
      { questionId: Q_ID, text: 'hello world' },
    ]);
  });
});

describe('S71 OnboardingService — admin CRUD limits', () => {
  it('규칙 10개 초과 생성은 ONBOARDING_RULES_LIMIT(409)으로 거부합니다', async () => {
    const prisma = {
      workspaceRule: { count: vi.fn().mockResolvedValue(10), create: vi.fn() },
    } as unknown as PrismaService;
    const svc = new OnboardingService(prisma, makeWelcomeQueue().svc);
    await expectDomainError(svc.createRule(WS, { title: 'r11' }), ErrorCode.ONBOARDING_RULES_LIMIT);
  });

  it('질문 5개 초과 생성은 ONBOARDING_QUESTIONS_LIMIT(409)으로 거부합니다', async () => {
    const prisma = {
      onboardingQuestion: { count: vi.fn().mockResolvedValue(5), create: vi.fn() },
    } as unknown as PrismaService;
    const svc = new OnboardingService(prisma, makeWelcomeQueue().svc);
    await expectDomainError(
      svc.createQuestion(WS, { type: 'SHORT_TEXT', isRequired: false, label: 'q6', options: [] }),
      ErrorCode.ONBOARDING_QUESTIONS_LIMIT,
    );
  });

  it('수정 대상 규칙 부재는 ONBOARDING_RULE_NOT_FOUND(404)으로 거부합니다', async () => {
    const prisma = {
      workspaceRule: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const svc = new OnboardingService(prisma, makeWelcomeQueue().svc);
    await expectDomainError(
      svc.updateRule(WS, 'rX', { title: 'x' }),
      ErrorCode.ONBOARDING_RULE_NOT_FOUND,
    );
  });
});
