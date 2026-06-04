import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationStatus, Prisma } from '@prisma/client';
import { ApplicationsService } from '../../../src/workspaces/applications/applications.service';
import type { PrismaService } from '../../../src/prisma/prisma.module';
import type { OutboxService } from '../../../src/common/outbox/outbox.service';
import type { ModerationService } from '../../../src/workspaces/moderation/moderation.service';
import type { IpSoftBlockService } from '../../../src/workspaces/moderation/ip-soft-block.service';
import type { DirectMessagesService } from '../../../src/channels/direct-messages/direct-messages.service';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';
import {
  MEMBER_APPLICATION_RECEIVED,
  MEMBER_APPLICATION_REVIEWED,
  MEMBER_JOINED,
} from '../../../src/workspaces/events/workspace-events';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SLUG = 'acme';
const APPLICANT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ADMIN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const APP_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function makeOutbox(): {
  svc: OutboxService;
  records: Array<{ eventType: string; payload: Record<string, unknown> }>;
} {
  const records: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const svc = {
    record: vi.fn(
      async (_tx: unknown, input: { eventType: string; payload: Record<string, unknown> }) => {
        records.push({ eventType: input.eventType, payload: input.payload });
        return 'outbox-id';
      },
    ),
  } as unknown as OutboxService;
  return { svc, records };
}

function makeModeration(banned = false): ModerationService {
  return { isBanned: vi.fn().mockResolvedValue(banned) } as unknown as ModerationService;
}

// S72 (D13 / FR-W22): IP soft-block 스텁. clientIp 미지정 정상 신청은 무차단 통과시킨다
// (assertNotIpBlocked → resolve). 차단 IP 분기는 ip-soft-block.service.spec 이 별도 검증한다.
function makeIpSoftBlock(blocked = false): IpSoftBlockService {
  return {
    assertNotIpBlocked: blocked
      ? vi
          .fn()
          .mockRejectedValue(
            Object.assign(new Error('blocked'), { code: ErrorCode.APPLICATION_NOT_APPLICABLE }),
          )
      : vi.fn().mockResolvedValue({ ipHash: null }),
  } as unknown as IpSoftBlockService;
}

function makeDms(channelId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'): {
  svc: DirectMessagesService;
  createInterviewDm: ReturnType<typeof vi.fn>;
} {
  const createInterviewDm = vi.fn().mockResolvedValue({ channelId, created: true });
  return { svc: { createInterviewDm } as unknown as DirectMessagesService, createInterviewDm };
}

async function expectDomainError(p: Promise<unknown>, code: ErrorCode) {
  await expect(p).rejects.toMatchObject({ code });
}

const VERIFIED = { userId: APPLICANT, emailVerified: true, userEmail: 'a@acme.com' };
const WS_APPLY = { id: WS, joinMode: 'APPLY', emailDomains: [] as string[], deletedAt: null };

describe('S70 ApplicationsService.submit', () => {
  it('미인증(emailVerified=false) 신청자는 EMAIL_NOT_VERIFIED 로 거부합니다', async () => {
    const prisma = {
      workspace: { findUnique: vi.fn().mockResolvedValue(WS_APPLY) },
      workspaceMember: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const svc = new ApplicationsService(
      prisma,
      makeOutbox().svc,
      makeModeration(),
      makeIpSoftBlock(),
      makeDms().svc,
    );
    await expectDomainError(
      svc.submit({
        slug: SLUG,
        applicant: { userId: APPLICANT, emailVerified: false, userEmail: 'a@acme.com' },
        answers: [],
      }),
      ErrorCode.EMAIL_NOT_VERIFIED,
    );
  });

  it('차단된 신청자는 중립 404(WORKSPACE_NOT_FOUND)로 거부합니다', async () => {
    const prisma = {
      workspace: { findUnique: vi.fn().mockResolvedValue(WS_APPLY) },
      workspaceMember: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const svc = new ApplicationsService(
      prisma,
      makeOutbox().svc,
      makeModeration(true),
      makeIpSoftBlock(),
      makeDms().svc,
    );
    await expectDomainError(
      svc.submit({ slug: SLUG, applicant: VERIFIED, answers: [] }),
      ErrorCode.WORKSPACE_NOT_FOUND,
    );
  });

  it('APPLY 가 아닌 워크스페이스는 APPLICATION_NOT_APPLICABLE 로 거부합니다', async () => {
    const prisma = {
      workspace: { findUnique: vi.fn().mockResolvedValue({ ...WS_APPLY, joinMode: 'PUBLIC' }) },
    } as unknown as PrismaService;
    const svc = new ApplicationsService(
      prisma,
      makeOutbox().svc,
      makeModeration(),
      makeIpSoftBlock(),
      makeDms().svc,
    );
    await expectDomainError(
      svc.submit({ slug: SLUG, applicant: VERIFIED, answers: [] }),
      ErrorCode.APPLICATION_NOT_APPLICABLE,
    );
  });

  it('PENDING 신청이 이미 있으면 APPLICATION_PENDING_EXISTS(409)로 거부합니다', async () => {
    // perf(MINOR): 차단 상태 선조회를 findMany 1회로 통합한다.
    const prisma = {
      workspace: { findUnique: vi.fn().mockResolvedValue(WS_APPLY) },
      workspaceMember: { findUnique: vi.fn().mockResolvedValue(null) },
      workspaceMemberApplication: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: APP_ID, status: ApplicationStatus.PENDING, updatedAt: new Date() },
          ]),
      },
    } as unknown as PrismaService;
    const svc = new ApplicationsService(
      prisma,
      makeOutbox().svc,
      makeModeration(),
      makeIpSoftBlock(),
      makeDms().svc,
    );
    await expectDomainError(
      svc.submit({ slug: SLUG, applicant: VERIFIED, answers: [] }),
      ErrorCode.APPLICATION_PENDING_EXISTS,
    );
  });

  it('REJECTED 후 24h 미경과면 APPLICATION_COOLDOWN(429) + retryAfterMs 를 실어 거부합니다', async () => {
    // 현재 시각(2025-01-01T00:00:00Z) 기준 1시간 전 거절.
    const rejectedAt = new Date('2024-12-31T23:00:00Z');
    const prisma = {
      workspace: { findUnique: vi.fn().mockResolvedValue(WS_APPLY) },
      workspaceMember: { findUnique: vi.fn().mockResolvedValue(null) },
      workspaceMemberApplication: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: APP_ID, status: ApplicationStatus.REJECTED, updatedAt: rejectedAt },
          ]),
      },
    } as unknown as PrismaService;
    const svc = new ApplicationsService(
      prisma,
      makeOutbox().svc,
      makeModeration(),
      makeIpSoftBlock(),
      makeDms().svc,
    );
    await expect(
      svc.submit({ slug: SLUG, applicant: VERIFIED, answers: [] }),
    ).rejects.toMatchObject({
      code: ErrorCode.APPLICATION_COOLDOWN,
      details: { retryAfterMs: 23 * 60 * 60 * 1000 },
    });
  });

  it('WITHDRAWN 행이 있으면 새 행 대신 그 행을 PENDING 으로 되살리고 received outbox 를 남깁니다', async () => {
    const updateMock = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: APP_ID,
      workspaceId: WS,
      applicantId: APPLICANT,
      status: ApplicationStatus.PENDING,
      answers: data.answers,
      reviewedById: null,
      reviewNote: null,
      interviewChannelId: null,
      createdAt: new Date('2024-12-01T00:00:00Z'),
      updatedAt: new Date('2025-01-01T00:00:00Z'),
    }));
    const createMock = vi.fn();
    const tx = {
      workspaceMemberApplication: {
        findFirst: vi.fn().mockResolvedValue({ id: APP_ID }),
        update: updateMock,
        create: createMock,
      },
      user: { findUnique: vi.fn().mockResolvedValue({ username: 'alice' }) },
    };
    const prisma = {
      workspace: { findUnique: vi.fn().mockResolvedValue(WS_APPLY) },
      workspaceMember: { findUnique: vi.fn().mockResolvedValue(null) },
      // 차단 상태(PENDING/INTERVIEW/REJECTED) 없음 — findMany 빈 배열.
      workspaceMemberApplication: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    const outbox = makeOutbox();
    const svc = new ApplicationsService(
      prisma,
      outbox.svc,
      makeModeration(),
      makeIpSoftBlock(),
      makeDms().svc,
    );

    const result = await svc.submit({
      slug: SLUG,
      applicant: VERIFIED,
      answers: [{ questionId: 'q1', answer: 'hi' }],
    });

    expect(updateMock).toHaveBeenCalledOnce();
    expect(createMock).not.toHaveBeenCalled();
    expect(result.status).toBe('PENDING');
    expect(outbox.records.map((r) => r.eventType)).toContain(MEMBER_APPLICATION_RECEIVED);
    expect(outbox.records[0].payload).toMatchObject({
      applicantName: 'alice',
      applicationId: APP_ID,
    });
  });

  it('동시 신청으로 create 가 P2002 면 APPLICATION_PENDING_EXISTS(409)로 변환합니다(M-2)', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: 'test',
    });
    const tx = {
      workspaceMemberApplication: {
        findFirst: vi.fn().mockResolvedValue(null), // 되살릴 행 없음 → create 경로
        update: vi.fn(),
        create: vi.fn().mockRejectedValue(p2002),
      },
      user: { findUnique: vi.fn().mockResolvedValue({ username: 'bob' }) },
    };
    const prisma = {
      workspace: { findUnique: vi.fn().mockResolvedValue(WS_APPLY) },
      workspaceMember: { findUnique: vi.fn().mockResolvedValue(null) },
      workspaceMemberApplication: { findMany: vi.fn().mockResolvedValue([]) },
      $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    const svc = new ApplicationsService(
      prisma,
      makeOutbox().svc,
      makeModeration(),
      makeIpSoftBlock(),
      makeDms().svc,
    );
    await expectDomainError(
      svc.submit({ slug: SLUG, applicant: VERIFIED, answers: [] }),
      ErrorCode.APPLICATION_PENDING_EXISTS,
    );
  });
});

describe('S70 ApplicationsService.process', () => {
  function pendingApp() {
    return {
      id: APP_ID,
      workspaceId: WS,
      applicantId: APPLICANT,
      status: ApplicationStatus.PENDING,
      answers: [],
      reviewedById: null,
      reviewNote: null,
      interviewChannelId: null,
      createdAt: new Date('2025-01-01T00:00:00Z'),
      updatedAt: new Date('2025-01-01T00:00:00Z'),
    };
  }

  it('MODERATOR 의 approve 는 APPLICATION_FORBIDDEN(403)으로 거부합니다', async () => {
    const prisma = {} as unknown as PrismaService;
    const svc = new ApplicationsService(
      prisma,
      makeOutbox().svc,
      makeModeration(),
      makeIpSoftBlock(),
      makeDms().svc,
    );
    await expectDomainError(
      svc.process({
        workspaceId: WS,
        applicationId: APP_ID,
        actorId: ADMIN,
        actorRole: 'MODERATOR',
        action: 'approve',
      }),
      ErrorCode.APPLICATION_FORBIDDEN,
    );
  });

  it('approve(ADMIN)는 WorkspaceMember 생성 + MEMBER_JOINED + reviewed(approved) outbox 를 남깁니다', async () => {
    const memberCreate = vi.fn().mockResolvedValue(undefined);
    const tx = {
      // M-1: 트랜잭션 내 ban 재확인 — 미차단(null).
      bannedMember: { findUnique: vi.fn().mockResolvedValue(null) },
      workspaceMemberApplication: {
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          ...pendingApp(),
          status: ApplicationStatus.APPROVED,
          reviewedById: ADMIN,
          ...data,
        })),
      },
      workspaceMember: { create: memberCreate },
      role: { findMany: vi.fn().mockResolvedValue([{ id: 'r-member', name: 'MEMBER' }]) },
      memberRole: {
        findMany: vi.fn().mockResolvedValue([]),
        createMany: vi.fn(),
        deleteMany: vi.fn(),
      },
    };
    const prisma = {
      workspaceMemberApplication: { findFirst: vi.fn().mockResolvedValue(pendingApp()) },
      $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    const outbox = makeOutbox();
    const svc = new ApplicationsService(
      prisma,
      outbox.svc,
      makeModeration(),
      makeIpSoftBlock(),
      makeDms().svc,
    );

    const result = await svc.process({
      workspaceId: WS,
      applicationId: APP_ID,
      actorId: ADMIN,
      actorRole: 'ADMIN',
      action: 'approve',
    });

    expect(memberCreate).toHaveBeenCalledOnce();
    expect(result.status).toBe('APPROVED');
    const types = outbox.records.map((r) => r.eventType);
    expect(types).toContain(MEMBER_JOINED);
    expect(types).toContain(MEMBER_APPLICATION_REVIEWED);
    const reviewed = outbox.records.find((r) => r.eventType === MEMBER_APPLICATION_REVIEWED);
    expect(reviewed?.payload).toMatchObject({ status: 'approved', applicantId: APPLICANT });
  });

  it('submit↔approve 사이에 ban 되면 approve 는 중립 404 로 거부하고 멤버를 만들지 않습니다(M-1)', async () => {
    const memberCreate = vi.fn();
    const tx = {
      // M-1: 트랜잭션 내 ban 재확인 — 차단됨(행 존재).
      bannedMember: { findUnique: vi.fn().mockResolvedValue({ userId: APPLICANT }) },
      workspaceMemberApplication: { update: vi.fn() },
      workspaceMember: { create: memberCreate },
    };
    const prisma = {
      workspaceMemberApplication: { findFirst: vi.fn().mockResolvedValue(pendingApp()) },
      $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    const outbox = makeOutbox();
    const svc = new ApplicationsService(
      prisma,
      outbox.svc,
      makeModeration(),
      makeIpSoftBlock(),
      makeDms().svc,
    );

    await expectDomainError(
      svc.process({
        workspaceId: WS,
        applicationId: APP_ID,
        actorId: ADMIN,
        actorRole: 'ADMIN',
        action: 'approve',
      }),
      ErrorCode.WORKSPACE_NOT_FOUND,
    );
    expect(memberCreate).not.toHaveBeenCalled();
    expect(outbox.records).toHaveLength(0);
  });

  it('reject(MODERATOR)는 reviewNote 를 기록하고 reviewed(rejected) outbox 를 남깁니다', async () => {
    const tx = {
      workspaceMemberApplication: {
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          ...pendingApp(),
          status: ApplicationStatus.REJECTED,
          ...data,
        })),
      },
    };
    const prisma = {
      workspaceMemberApplication: { findFirst: vi.fn().mockResolvedValue(pendingApp()) },
      $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    const outbox = makeOutbox();
    const svc = new ApplicationsService(
      prisma,
      outbox.svc,
      makeModeration(),
      makeIpSoftBlock(),
      makeDms().svc,
    );

    const result = await svc.process({
      workspaceId: WS,
      applicationId: APP_ID,
      actorId: ADMIN,
      actorRole: 'MODERATOR',
      action: 'reject',
      reviewNote: '  경험이 부족합니다  ',
    });

    expect(result.status).toBe('REJECTED');
    expect(result.reviewNote).toBe('경험이 부족합니다'); // trim 정규화
    const reviewed = outbox.records.find((r) => r.eventType === MEMBER_APPLICATION_REVIEWED);
    expect(reviewed?.payload).toMatchObject({
      status: 'rejected',
      reviewNote: '경험이 부족합니다',
    });
  });

  it('interview(ADMIN)는 1:1 DM 을 생성해 interviewChannelId 를 기록합니다', async () => {
    const DM_CH = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const tx = {
      workspaceMemberApplication: {
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          ...pendingApp(),
          status: ApplicationStatus.INTERVIEW,
          ...data,
        })),
      },
    };
    const prisma = {
      workspaceMemberApplication: { findFirst: vi.fn().mockResolvedValue(pendingApp()) },
      $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    const dms = makeDms(DM_CH);
    const outbox = makeOutbox();
    const svc = new ApplicationsService(
      prisma,
      outbox.svc,
      makeModeration(),
      makeIpSoftBlock(),
      dms.svc,
    );

    const result = await svc.process({
      workspaceId: WS,
      applicationId: APP_ID,
      actorId: ADMIN,
      actorRole: 'ADMIN',
      action: 'interview',
    });

    expect(dms.createInterviewDm).toHaveBeenCalledWith(WS, ADMIN, APPLICANT);
    expect(result.status).toBe('INTERVIEW');
    expect(result.interviewChannelId).toBe(DM_CH);
    const reviewed = outbox.records.find((r) => r.eventType === MEMBER_APPLICATION_REVIEWED);
    expect(reviewed?.payload).toMatchObject({ status: 'interview', interviewChannelId: DM_CH });
  });

  it('이미 종결된(APPROVED) 신청 처리는 APPLICATION_INVALID_STATE(409)로 거부합니다', async () => {
    const prisma = {
      workspaceMemberApplication: {
        findFirst: vi
          .fn()
          .mockResolvedValue({ ...pendingApp(), status: ApplicationStatus.APPROVED }),
      },
    } as unknown as PrismaService;
    const svc = new ApplicationsService(
      prisma,
      makeOutbox().svc,
      makeModeration(),
      makeIpSoftBlock(),
      makeDms().svc,
    );
    await expectDomainError(
      svc.process({
        workspaceId: WS,
        applicationId: APP_ID,
        actorId: ADMIN,
        actorRole: 'ADMIN',
        action: 'approve',
      }),
      ErrorCode.APPLICATION_INVALID_STATE,
    );
  });
});

describe('S70 ApplicationsService.withdraw', () => {
  it('PENDING 신청만 취소(WITHDRAWN)할 수 있습니다', async () => {
    const prisma = {
      workspaceMemberApplication: {
        findFirst: vi.fn().mockResolvedValue({
          id: APP_ID,
          workspaceId: WS,
          applicantId: APPLICANT,
          status: ApplicationStatus.PENDING,
          answers: [],
          reviewedById: null,
          reviewNote: null,
          interviewChannelId: null,
          createdAt: new Date('2025-01-01T00:00:00Z'),
          updatedAt: new Date('2025-01-01T00:00:00Z'),
        }),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: APP_ID,
          workspaceId: WS,
          applicantId: APPLICANT,
          status: ApplicationStatus.WITHDRAWN,
          answers: [],
          reviewedById: null,
          reviewNote: null,
          interviewChannelId: null,
          createdAt: new Date('2025-01-01T00:00:00Z'),
          updatedAt: new Date('2025-01-01T00:00:00Z'),
          ...data,
        })),
      },
    } as unknown as PrismaService;
    const svc = new ApplicationsService(
      prisma,
      makeOutbox().svc,
      makeModeration(),
      makeIpSoftBlock(),
      makeDms().svc,
    );
    const result = await svc.withdraw({
      workspaceId: WS,
      applicationId: APP_ID,
      userId: APPLICANT,
    });
    expect(result.status).toBe('WITHDRAWN');
  });

  it('PENDING 이 아닌 신청 취소는 APPLICATION_INVALID_STATE(409)로 거부합니다', async () => {
    const prisma = {
      workspaceMemberApplication: {
        findFirst: vi.fn().mockResolvedValue({
          id: APP_ID,
          workspaceId: WS,
          applicantId: APPLICANT,
          status: ApplicationStatus.APPROVED,
          answers: [],
          reviewedById: null,
          reviewNote: null,
          interviewChannelId: null,
          createdAt: new Date('2025-01-01T00:00:00Z'),
          updatedAt: new Date('2025-01-01T00:00:00Z'),
        }),
      },
    } as unknown as PrismaService;
    const svc = new ApplicationsService(
      prisma,
      makeOutbox().svc,
      makeModeration(),
      makeIpSoftBlock(),
      makeDms().svc,
    );
    await expectDomainError(
      svc.withdraw({ workspaceId: WS, applicationId: APP_ID, userId: APPLICANT }),
      ErrorCode.APPLICATION_INVALID_STATE,
    );
  });

  it('존재하지 않거나 타인 신청 취소는 APPLICATION_NOT_FOUND(404)로 거부합니다', async () => {
    const prisma = {
      workspaceMemberApplication: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const svc = new ApplicationsService(
      prisma,
      makeOutbox().svc,
      makeModeration(),
      makeIpSoftBlock(),
      makeDms().svc,
    );
    await expectDomainError(
      svc.withdraw({ workspaceId: WS, applicationId: APP_ID, userId: APPLICANT }),
      ErrorCode.APPLICATION_NOT_FOUND,
    );
  });
});
