import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceRole } from '@prisma/client';
import { PendingInvitesService } from './pending-invites.service';
import { hashToken } from './pending-invite-tokens';
import { ErrorCode } from '../../common/errors/error-code.enum';

/**
 * S68 (D13 / FR-W04·W04a): PendingInvitesService 단위 테스트(stub 으로 분기/보안 검증).
 *   - 50개 배치 미가입/가입/이미멤버/이미보류/실패 분기.
 *   - ★핵심 AC: DB 저장 데이터에 token 평문 없음(tokenHash 만, sha256 대조).
 *   - 수락 role 위조(ADMIN) → 400 EMAIL_INVITE_ROLE_MISMATCH.
 */
beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

type StoredPending = {
  id: string;
  workspaceId: string;
  email: string;
  role: WorkspaceRole;
  tokenHash: string;
  invitedById: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  canceledAt: Date | null;
  lastSentAt: Date;
};

function makeService(opts: {
  // 이미 가입된 이메일 집합.
  registeredEmails?: Set<string>;
  // 이미 워크스페이스 멤버인 (email) 집합.
  existingMemberEmails?: Set<string>;
  // 이미 활성 보류 초대가 있는 이메일 집합.
  pendingEmails?: Set<string>;
}) {
  const registered = opts.registeredEmails ?? new Set<string>();
  const members = opts.existingMemberEmails ?? new Set<string>();
  const pendingEmails = opts.pendingEmails ?? new Set<string>();
  const emailToUserId = (email: string): string => `user-${email}`;

  const createdPending: StoredPending[] = [];
  const createdMembers: Array<{ userId: string; role: WorkspaceRole }> = [];
  const mailSent: Array<{ to: string; inviteUrl: string }> = [];

  const prisma = {
    workspace: {
      findUnique: vi.fn(async () => ({
        id: 'ws',
        name: 'Acme',
        slug: 'acme',
        deletedAt: null,
      })),
    },
    user: {
      findUnique: vi.fn(async (args: { where: { email?: string; id?: string } }) => {
        if (args.where.email !== undefined) {
          return registered.has(args.where.email) ? { id: emailToUserId(args.where.email) } : null;
        }
        return { username: 'admin' };
      }),
      // S68 fix-forward (perf SERIOUS): inviteByEmail 이 사전 일괄 조회한다.
      findMany: vi.fn(async (args: { where: { email: { in: string[] } } }) =>
        args.where.email.in
          .filter((e) => registered.has(e))
          .map((e) => ({ id: emailToUserId(e), email: e })),
      ),
    },
    workspaceMember: {
      findUnique: vi.fn(async (args: { where: { workspaceId_userId: { userId: string } } }) => {
        const uid = args.where.workspaceId_userId.userId;
        // member if uid corresponds to a member email.
        const matchEmail = [...members].some((e) => emailToUserId(e) === uid);
        return matchEmail ? { workspaceId: 'ws', userId: uid } : null;
      }),
      create: vi.fn(async (args: { data: { userId: string; role: WorkspaceRole } }) => {
        createdMembers.push({ userId: args.data.userId, role: args.data.role });
        return args.data;
      }),
    },
    workspacePendingInvite: {
      findUnique: vi.fn(async (args: { where: { workspaceId_email?: { email: string } } }) => {
        const email = args.where.workspaceId_email?.email;
        if (email && pendingEmails.has(email)) {
          return {
            id: `pending-${email}`,
            workspaceId: 'ws',
            email,
            acceptedAt: null,
            canceledAt: null,
          };
        }
        return null;
      }),
      // S68 fix-forward (perf SERIOUS): inviteByEmail 이 사전 일괄 조회한다.
      findMany: vi.fn(async (args: { where: { email: { in: string[] } } }) =>
        args.where.email.in
          .filter((e) => pendingEmails.has(e))
          .map((e) => ({ email: e, acceptedAt: null, canceledAt: null })),
      ),
      upsert: vi.fn(async (args: { create: StoredPending }) => {
        createdPending.push(args.create);
        return args.create;
      }),
    },
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      // syncMemberSystemRole touches tx.role/tx.memberRole — provide no-op stubs.
      const tx = {
        ...prisma,
        role: { findMany: vi.fn(async () => [{ id: 'r-member', name: 'MEMBER' }]) },
        memberRole: {
          deleteMany: vi.fn(async () => ({ count: 0 })),
          create: vi.fn(async () => ({})),
          createMany: vi.fn(async () => ({ count: 0 })),
          findMany: vi.fn(async () => []),
        },
      };
      return cb(tx);
    }),
  };

  const redis = {
    set: vi.fn(async () => 'OK'),
    get: vi.fn(async () => null),
    del: vi.fn(async () => 1),
  };
  const outbox = { record: vi.fn(async () => undefined) };
  const moderation = { isBanned: vi.fn(async () => false) };
  // S72 (D13 / FR-W22): IP soft-block 스텁 — 차단 IP 없는 정상 수락이라 무차단(ipHash=null) 통과.
  const ipSoftBlock = { assertNotIpBlocked: vi.fn(async () => ({ ipHash: null })) };
  const mail = {
    sendVerificationEmail: vi.fn(async () => undefined),
    sendWorkspaceInviteEmail: vi.fn(async (to: string, inviteUrl: string) => {
      mailSent.push({ to, inviteUrl });
    }),
  };

  const svc = new PendingInvitesService(
    prisma as never,
    redis as never,
    outbox as never,
    moderation as never,
    ipSoftBlock as never,
    mail as never,
  );
  return { svc, prisma, createdPending, createdMembers, mailSent };
}

describe('S68 inviteByEmail — batch branch resolution', () => {
  it('splits a mixed batch into ADDED_MEMBER / PENDING / ALREADY_MEMBER / ALREADY_PENDING', async () => {
    const { svc } = makeService({
      registeredEmails: new Set(['member@x.com', 'existing-member@x.com']),
      existingMemberEmails: new Set(['existing-member@x.com']),
      pendingEmails: new Set(['already-pending@x.com']),
    });
    const res = await svc.inviteByEmail(
      'ws',
      'inviter',
      ['member@x.com', 'new@x.com', 'existing-member@x.com', 'already-pending@x.com'],
      'MEMBER',
    );
    const byEmail = Object.fromEntries(res.results.map((r) => [r.email, r.outcome]));
    expect(byEmail['member@x.com']).toBe('ADDED_MEMBER');
    expect(byEmail['new@x.com']).toBe('PENDING');
    expect(byEmail['existing-member@x.com']).toBe('ALREADY_MEMBER');
    expect(byEmail['already-pending@x.com']).toBe('ALREADY_PENDING');
    expect(res.addedCount).toBe(1);
    expect(res.sentCount).toBe(1);
  });

  it('dedupes repeated emails within a batch', async () => {
    const { svc } = makeService({});
    const res = await svc.inviteByEmail('ws', 'inviter', ['dup@x.com', 'dup@x.com'], 'MEMBER');
    expect(res.results).toHaveLength(1);
  });

  it('handles a 50-email batch of fresh addresses as all PENDING', async () => {
    const { svc, createdPending } = makeService({});
    const emails = Array.from({ length: 50 }, (_, i) => `u${i}@x.com`);
    const res = await svc.inviteByEmail('ws', 'inviter', emails, 'MEMBER');
    expect(res.results).toHaveLength(50);
    expect(res.sentCount).toBe(50);
    expect(createdPending).toHaveLength(50);
  });
});

describe('S68 ★핵심 AC — sha256(rawToken) stored, no plaintext token in DB', () => {
  it('persists tokenHash only and it matches sha256 of the emailed rawToken', async () => {
    const { svc, createdPending, mailSent } = makeService({});
    await svc.inviteByEmail('ws', 'inviter', ['new@x.com'], 'MEMBER');
    expect(createdPending).toHaveLength(1);
    const stored = createdPending[0] as unknown as Record<string, unknown>;
    // 저장 데이터엔 tokenHash 만 있고 평문 token 키가 없다.
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect('token' in stored).toBe(false);
    expect('rawToken' in stored).toBe(false);
    // S68 fix-forward (security MEDIUM-1): rawToken 은 URL fragment(#token=…)로 옮겼다.
    // fragment 에서 추출해 sha256 이 저장값과 일치하는지 확인한다.
    const url = mailSent[0].inviteUrl;
    expect(url).toMatch(/#token=/);
    const rawToken = url.split('#token=')[1];
    expect(hashToken(rawToken)).toBe(stored.tokenHash);
    // 저장값은 rawToken 평문과 절대 같지 않다.
    expect(stored.tokenHash).not.toBe(rawToken);
  });
});

describe('S68 acceptByToken — role forgery rejected (EMAIL_INVITE_ROLE_MISMATCH)', () => {
  it('rejects a pending invite whose role is ADMIN (not directly invitable)', async () => {
    const { svc, prisma } = makeService({});
    // 정상 발급 후 tokenHash 로 ADMIN role 행을 조회하도록 stub 을 재배선한다.
    const rawToken = 'forged-token';
    prisma.workspacePendingInvite.findUnique = vi.fn(async () => ({
      id: 'p1',
      workspaceId: 'ws',
      email: 'x@x.com',
      role: WorkspaceRole.ADMIN,
      tokenHash: hashToken(rawToken),
      invitedById: 'inviter',
      expiresAt: new Date('2025-02-01T00:00:00Z'),
      acceptedAt: null,
      canceledAt: null,
      lastSentAt: new Date('2025-01-01T00:00:00Z'),
    })) as never;
    await expect(
      svc.acceptByToken(rawToken, {
        userId: 'u1',
        userEmail: 'x@x.com',
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.EMAIL_INVITE_ROLE_MISMATCH });
  });
});

describe('S68 acceptByToken — 이메일 소유권 강제 (reviewer B1 보안 BLOCKER)', () => {
  it('actor 이메일이 초대 대상 이메일과 다르면 403 EMAIL_INVITE_EMAIL_MISMATCH (분기③ 서버 강제)', async () => {
    const { svc, prisma } = makeService({});
    const rawToken = 'mismatch-token';
    // 보류 초대는 invitee@acme.com 대상이지만, 다른 계정(other@acme.com)이 수락을 시도한다.
    prisma.workspacePendingInvite.findUnique = vi.fn(async () => ({
      id: 'p1',
      workspaceId: 'ws',
      email: 'invitee@acme.com',
      role: WorkspaceRole.MEMBER,
      tokenHash: hashToken(rawToken),
      invitedById: 'inviter',
      expiresAt: new Date('2025-02-01T00:00:00Z'),
      acceptedAt: null,
      canceledAt: null,
      lastSentAt: new Date('2025-01-01T00:00:00Z'),
    })) as never;
    await expect(
      svc.acceptByToken(rawToken, {
        userId: 'u-other',
        userEmail: 'OTHER@acme.com', // 대문자 — normalizeEmail 후에도 invitee 와 불일치.
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.EMAIL_INVITE_EMAIL_MISMATCH });
  });
});
