import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeProfileController } from '../../../src/me/me-profile.controller';
import { ProfileService } from '../../../src/me/profile.service';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';
import type { PrismaService } from '../../../src/prisma/prisma.module';
import type { RateLimitService } from '../../../src/auth/services/rate-limit.service';
import type { RealtimeGateway } from '../../../src/realtime/realtime.gateway';
import type { S3Service } from '../../../src/storage/s3.service';

/**
 * S73 (D14): MeProfileController 단위 — Zod strict parse + ProfileService 위임 +
 * 실시간 방송. bio/links 검증은 ProfileService 가 보유하므로 컨트롤러는 그 결과를
 * 그대로 반환한다(task-046 M1 / 047 M2 carryover 무회귀를 controller 경유로 재검증).
 */
beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const ME = '11111111-1111-4111-8111-111111111111';

function baseRow(over: Record<string, unknown> = {}) {
  return {
    id: ME,
    email: 'me@e.com',
    username: 'me',
    handle: 'me',
    displayName: null,
    fullName: null,
    pronouns: null,
    title: null,
    timezone: null,
    bio: null,
    handleChangedAt: null,
    avatarKey: null,
    customStatus: null,
    links: null,
    ...over,
  };
}

function makeCtrl({
  findUnique,
  update,
}: { findUnique?: ReturnType<typeof vi.fn>; update?: ReturnType<typeof vi.fn> } = {}) {
  const prisma = {
    user: {
      findUnique: findUnique ?? vi.fn().mockResolvedValue(baseRow()),
      update: update ?? vi.fn().mockResolvedValue(baseRow()),
    },
    workspaceMember: { findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;
  const rate = { enforce: vi.fn().mockResolvedValue(undefined) } as unknown as RateLimitService;
  const s3 = {
    presignGet: vi.fn().mockResolvedValue('http://get.stub'),
    presignPutTtl: 900,
    presignGetTtl: 1800,
  } as unknown as S3Service;
  const gateway = { broadcastUserProfileUpdate: vi.fn() } as unknown as RealtimeGateway;
  const service = new ProfileService(prisma, s3);
  return { ctrl: new MeProfileController(prisma, rate, service, gateway), prisma, rate, gateway };
}

const CALLER = { id: ME, email: 'me@e.com', username: 'me', emailVerified: true };

describe('MeProfileController.get', () => {
  it('returns the profile view (handle ?? username) + bio', async () => {
    const findUnique = vi.fn().mockResolvedValue(baseRow({ bio: 'hello world', handle: null }));
    const { ctrl } = makeCtrl({ findUnique });
    const res = await ctrl.get(CALLER);
    expect(res.bio).toBe('hello world');
    expect(res.handle).toBe('me');
  });

  it('throws when the user row is missing', async () => {
    const { ctrl } = makeCtrl({ findUnique: vi.fn().mockResolvedValue(null) });
    await expect(ctrl.get(CALLER)).rejects.toThrow(/profile not found/);
  });
});

describe('MeProfileController.patch — bio (task-046 M1 carryover)', () => {
  it('bio null → stored null', async () => {
    const update = vi.fn().mockResolvedValue(baseRow());
    const findUnique = vi.fn().mockResolvedValue(baseRow());
    const { ctrl } = makeCtrl({ update, findUnique });
    const res = await ctrl.patch(CALLER, { bio: null });
    expect(res.bio).toBeNull();
  });

  it('bio whitespace → null', async () => {
    const update = vi.fn().mockResolvedValue(baseRow());
    const { ctrl } = makeCtrl({ update });
    await ctrl.patch(CALLER, { bio: '   ' });
    const arg = update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(arg.data.bio).toBeNull();
  });

  it('bio over 190 (app layer) → rejected', async () => {
    const { ctrl } = makeCtrl();
    await expect(ctrl.patch(CALLER, { bio: 'x'.repeat(191) })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_FAILED,
    });
  });

  it('enforces rate limit 10/min/user', async () => {
    const { ctrl, rate } = makeCtrl();
    await ctrl.patch(CALLER, { bio: 'hi' });
    expect(rate.enforce).toHaveBeenCalledWith([
      { key: `me-profile:u:${ME}`, windowSec: 60, max: 10 },
    ]);
  });

  it('broadcasts user.profile.updated after a successful patch', async () => {
    const { ctrl, gateway } = makeCtrl();
    await ctrl.patch(CALLER, { displayName: 'Me' });
    expect(gateway.broadcastUserProfileUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ userId: ME }),
    );
  });
});

describe('MeProfileController.patch — links (task-047 M2 carryover)', () => {
  it('links empty array → JsonNull stored', async () => {
    const update = vi.fn().mockResolvedValue(baseRow());
    const { ctrl } = makeCtrl({ update });
    await ctrl.patch(CALLER, { links: [] });
    const arg = update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    // Prisma.JsonNull is a sentinel object — assert it is not a real array.
    expect(Array.isArray(arg.data.links)).toBe(false);
  });

  it('links with a non-http url → VALIDATION_FAILED (Zod strict)', async () => {
    const { ctrl } = makeCtrl();
    await expect(
      ctrl.patch(CALLER, { links: [{ url: 'javascript:alert(1)' }] }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });

  it('links over cap 3 → VALIDATION_FAILED', async () => {
    const links = Array.from({ length: 4 }, (_, i) => ({ url: `https://e${i}.com` }));
    const { ctrl } = makeCtrl();
    await expect(ctrl.patch(CALLER, { links })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_FAILED,
    });
  });

  it('valid links round-trip through the view', async () => {
    const expected = [{ url: 'https://example.com', label: 'home' }];
    const update = vi.fn().mockResolvedValue(baseRow());
    const findUnique = vi.fn().mockResolvedValue(baseRow({ links: expected }));
    const { ctrl } = makeCtrl({ update, findUnique });
    const res = await ctrl.patch(CALLER, { links: expected });
    expect(res.links).toEqual(expected);
  });
});

describe('MeProfileController.patch — unknown keys rejected (Zod strict)', () => {
  it('rejects a non-whitelisted field', async () => {
    const { ctrl } = makeCtrl();
    await expect(
      ctrl.patch(CALLER, { avatarUrl: 'http://evil' } as unknown as Record<string, unknown>),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });
});
