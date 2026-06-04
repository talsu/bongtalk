import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceMemberProfileService } from './workspace-member-profile.service';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { WS_NICKNAME_MAX, WS_BIO_MAX, WS_AVATAR_MAX_BYTES } from '@qufox/shared-types';
import type { PrismaService } from '../../prisma/prisma.module';
import type { S3Service } from '../../storage/s3.service';
import type { PresenceService } from '../../realtime/presence/presence.service';

/**
 * S74 (D14 / FR-PS-06): 워크스페이스별 프로필 도메인 단위 테스트. 외부(Prisma/S3)는
 * vi.fn() 으로만 모킹. 시간 고정(2025-01-01).
 */
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

function makeDeps(opts: {
  profileRow?: {
    nickname: string | null;
    avatarKey: string | null;
    workspaceBio: string | null;
  } | null;
  headObject?: { contentLength: number; contentType: string | undefined } | null;
  headBytes?: Uint8Array | null;
}): {
  service: WorkspaceMemberProfileService;
  upsert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  deleteObject: ReturnType<typeof vi.fn>;
} {
  const row = opts.profileRow ?? null;
  const upsert = vi.fn(async () => row);
  const update = vi.fn(async () => row);
  const deleteObject = vi.fn(async () => undefined);
  const prisma = {
    workspaceMemberProfile: {
      findUnique: vi.fn(async () => row),
      upsert,
      update,
    },
  } as unknown as PrismaService;
  const s3 = {
    presignPost: vi.fn(async () => ({
      url: 'http://post.stub',
      fields: { key: 'k', 'Content-Type': 'image/png' },
    })),
    // 키별로 분기해 avatar/banner/ws-avatar URL 을 구분한다(full-profile 검증용).
    presignGet: vi.fn(async (key: string) => `http://get.stub/${key}`),
    headObject: vi.fn(async () =>
      opts.headObject === undefined
        ? { contentLength: 1024, contentType: 'image/png' }
        : opts.headObject,
    ),
    getObjectRange: vi.fn(async () => (opts.headBytes === undefined ? PNG_MAGIC : opts.headBytes)),
    deleteObject,
  } as unknown as S3Service;
  // S75 (FR-PS-07/08): full-profile 의 프레즌스 마스킹은 PresenceService.bulkFor 단일 지점이다.
  // 단위 테스트는 viewer 기준 마스킹 결과(이미 마스킹된 status)를 직접 스텁한다.
  const presence = {
    bulkFor: vi.fn(async (_viewerId: string, userIds: string[]) =>
      userIds.map((userId) => ({
        userId,
        status: 'online' as const,
        real: 'online' as const,
        masked: false,
        updatedAt: '2025-01-01T00:00:00.000Z',
      })),
    ),
  } as unknown as PresenceService;
  return {
    service: new WorkspaceMemberProfileService(prisma, s3, presence),
    upsert,
    update,
    deleteObject,
  };
}

describe('WorkspaceMemberProfileService.getProfile', () => {
  it('returns an all-null view when no override row exists', async () => {
    const { service } = makeDeps({ profileRow: null });
    const view = await service.getProfile('w1', 'u1');
    expect(view).toEqual({
      workspaceId: 'w1',
      userId: 'u1',
      nickname: null,
      avatarUrl: null,
      workspaceBio: null,
    });
  });

  it('resolves avatarUrl via presignGet when ws avatarKey is set', async () => {
    const { service } = makeDeps({
      profileRow: { nickname: 'Ace', avatarKey: 'ws-avatars/w1/u1/x.png', workspaceBio: 'hi' },
    });
    const view = await service.getProfile('w1', 'u1');
    expect(view.nickname).toBe('Ace');
    expect(view.avatarUrl).toBe('http://get.stub/ws-avatars/w1/u1/x.png');
    expect(view.workspaceBio).toBe('hi');
  });
});

describe('WorkspaceMemberProfileService.updateProfile (upsert)', () => {
  it('upserts the trimmed nickname + bio', async () => {
    const { service, upsert } = makeDeps({
      profileRow: { nickname: 'Ace', avatarKey: null, workspaceBio: 'hi' },
    });
    await service.updateProfile('w1', 'u1', { nickname: '  Ace  ', workspaceBio: 'hi' });
    const arg = upsert.mock.calls[0]?.[0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(arg.update.nickname).toBe('Ace');
    expect(arg.update.workspaceBio).toBe('hi');
  });

  it('null clears the override (fallback to global)', async () => {
    const { service, upsert } = makeDeps({
      profileRow: { nickname: null, avatarKey: null, workspaceBio: null },
    });
    await service.updateProfile('w1', 'u1', { nickname: null });
    const arg = upsert.mock.calls[0]?.[0] as { update: Record<string, unknown> };
    expect(arg.update.nickname).toBeNull();
  });

  it('rejects nickname over WS_NICKNAME_MAX', async () => {
    const { service } = makeDeps({ profileRow: null });
    await expect(
      service.updateProfile('w1', 'u1', { nickname: 'a'.repeat(WS_NICKNAME_MAX + 1) }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });

  it('rejects workspaceBio over WS_BIO_MAX', async () => {
    const { service } = makeDeps({ profileRow: null });
    await expect(
      service.updateProfile('w1', 'u1', { workspaceBio: 'a'.repeat(WS_BIO_MAX + 1) }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });
});

describe('WorkspaceMemberProfileService.presignAvatar', () => {
  it('rejects disallowed mime', async () => {
    const { service } = makeDeps({ profileRow: null });
    await expect(service.presignAvatar('w1', 'u1', 'image/gif', 100)).rejects.toMatchObject({
      code: ErrorCode.INVALID_MIME,
    });
  });

  it('rejects oversize', async () => {
    const { service } = makeDeps({ profileRow: null });
    await expect(
      service.presignAvatar('w1', 'u1', 'image/png', WS_AVATAR_MAX_BYTES + 1),
    ).rejects.toMatchObject({ code: ErrorCode.FILE_TOO_LARGE });
  });

  it('returns a key under ws-avatars/<wsId>/<userId>/', async () => {
    const { service } = makeDeps({ profileRow: null });
    const r = await service.presignAvatar('w1', 'u1', 'image/png', 100);
    expect(r.key.startsWith('ws-avatars/w1/u1/')).toBe(true);
    expect(r.key.endsWith('.png')).toBe(true);
  });
});

describe('WorkspaceMemberProfileService.finalizeAvatar', () => {
  it('rejects a key not under the member/workspace prefix', async () => {
    const { service } = makeDeps({ profileRow: null });
    await expect(
      service.finalizeAvatar('w1', 'u1', 'ws-avatars/w1/u2/x.png'),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });

  it('rejects traversal before storage', async () => {
    const { service } = makeDeps({ profileRow: null });
    await expect(
      service.finalizeAvatar('w1', 'u1', 'ws-avatars/w1/u1/../u2/x.png'),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });

  it('rejects + deletes on magic mismatch', async () => {
    const { service, deleteObject } = makeDeps({
      profileRow: null,
      headObject: { contentLength: 1024, contentType: 'image/png' },
      headBytes: new Uint8Array([0, 1, 2, 3]),
    });
    await expect(
      service.finalizeAvatar('w1', 'u1', 'ws-avatars/w1/u1/x.png'),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_MAGIC_BYTES });
    expect(deleteObject).toHaveBeenCalledWith('ws-avatars/w1/u1/x.png');
  });

  it('confirms + upserts the avatarKey + deletes previous', async () => {
    const { service, upsert, deleteObject } = makeDeps({
      profileRow: { nickname: null, avatarKey: 'ws-avatars/w1/u1/old.png', workspaceBio: null },
      headObject: { contentLength: 1024, contentType: 'image/png' },
    });
    const r = await service.finalizeAvatar('w1', 'u1', 'ws-avatars/w1/u1/new.png');
    expect(r.avatarUrl).toBe('http://get.stub/ws-avatars/w1/u1/new.png');
    const arg = upsert.mock.calls[0]?.[0] as { update: Record<string, unknown> };
    expect(arg.update.avatarKey).toBe('ws-avatars/w1/u1/new.png');
    expect(deleteObject).toHaveBeenCalledWith('ws-avatars/w1/u1/old.png');
  });
});

describe('WorkspaceMemberProfileService.deleteAvatar', () => {
  it('is a no-op when no ws avatar is set', async () => {
    const { service, update, deleteObject } = makeDeps({
      profileRow: { nickname: 'Ace', avatarKey: null, workspaceBio: null },
    });
    await service.deleteAvatar('w1', 'u1');
    expect(update).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it('resets avatarKey to null + deletes the object', async () => {
    const { service, update, deleteObject } = makeDeps({
      profileRow: { nickname: null, avatarKey: 'ws-avatars/w1/u1/x.png', workspaceBio: null },
    });
    await service.deleteAvatar('w1', 'u1');
    const arg = update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(arg.data.avatarKey).toBeNull();
    expect(deleteObject).toHaveBeenCalledWith('ws-avatars/w1/u1/x.png');
  });
});

// ── S75 (D14 / FR-PS-07·08): full-profile 합성 ─────────────────────────────────

type FullProfileMemberRow = {
  role: string;
  user: {
    id: string;
    username: string;
    handle: string | null;
    displayName: string | null;
    fullName: string | null;
    pronouns: string | null;
    title: string | null;
    timezone: string | null;
    bio: string | null;
    avatarKey: string | null;
    bannerKey: string | null;
    customStatus: string | null;
    customStatusEmoji: string | null;
    customStatusExpiresAt: Date | null;
  };
  memberRoles: Array<{
    role: { id: string; name: string; colorHex: string | null; isSystem: boolean };
  }>;
};

function makeFullProfileDeps(opts: {
  memberRow: FullProfileMemberRow | null;
  wsProfileRow?: {
    nickname: string | null;
    avatarKey: string | null;
    workspaceBio: string | null;
  } | null;
  /** bulkFor 가 viewer 기준으로 이미 마스킹해 돌려주는 status. */
  maskedStatus?: 'online' | 'idle' | 'dnd' | 'offline';
}): WorkspaceMemberProfileService {
  const prisma = {
    workspaceMember: { findUnique: vi.fn(async () => opts.memberRow) },
    workspaceMemberProfile: { findUnique: vi.fn(async () => opts.wsProfileRow ?? null) },
  } as unknown as PrismaService;
  const s3 = {
    presignGet: vi.fn(async (key: string) => `http://get.stub/${key}`),
  } as unknown as S3Service;
  const presence = {
    bulkFor: vi.fn(async (_viewerId: string, userIds: string[]) =>
      userIds.map((userId) => ({
        userId,
        status: opts.maskedStatus ?? 'online',
        real: opts.maskedStatus ?? 'online',
        masked: false,
        updatedAt: '2025-01-01T00:00:00.000Z',
      })),
    ),
  } as unknown as PresenceService;
  return new WorkspaceMemberProfileService(prisma, s3, presence);
}

function baseMemberRow(over: Partial<FullProfileMemberRow['user']> = {}): FullProfileMemberRow {
  return {
    role: 'MEMBER',
    user: {
      id: 'u1',
      username: 'alice',
      handle: 'alice',
      displayName: 'Alice',
      fullName: 'Alice Kim',
      pronouns: 'she/her',
      title: 'Engineer',
      timezone: 'Asia/Seoul',
      bio: 'global bio',
      avatarKey: null,
      bannerKey: null,
      customStatus: null,
      customStatusEmoji: null,
      customStatusExpiresAt: null,
      ...over,
    },
    memberRoles: [],
  };
}

describe('WorkspaceMemberProfileService.getFullProfile (FR-PS-07/08)', () => {
  it('composes effective* with ws override winning over global', async () => {
    const row = baseMemberRow({ avatarKey: 'avatars/u1/g.png' });
    row.user.displayName = 'Alice';
    const service = makeFullProfileDeps({
      memberRow: row,
      wsProfileRow: {
        nickname: 'Ace',
        avatarKey: 'ws-avatars/w1/u1/x.png',
        workspaceBio: 'ws bio',
      },
    });
    const view = await service.getFullProfile('w1', 'viewer', 'u1');
    expect(view.effectiveDisplayName).toBe('Ace');
    expect(view.effectiveAvatarUrl).toBe('http://get.stub/ws-avatars/w1/u1/x.png');
    expect(view.effectiveBio).toBe('ws bio');
    expect(view.wsNickname).toBe('Ace');
    expect(view.avatarUrl).toBe('http://get.stub/avatars/u1/g.png');
  });

  it('falls back to global when no ws override exists', async () => {
    const service = makeFullProfileDeps({
      memberRow: baseMemberRow({ avatarKey: 'avatars/u1/g.png' }),
      wsProfileRow: null,
    });
    const view = await service.getFullProfile('w1', 'viewer', 'u1');
    expect(view.effectiveDisplayName).toBe('Alice');
    expect(view.effectiveAvatarUrl).toBe('http://get.stub/avatars/u1/g.png');
    expect(view.effectiveBio).toBe('global bio');
    expect(view.wsNickname).toBeNull();
  });

  it('uses handle ?? username and surfaces presence/timezone/banner', async () => {
    const service = makeFullProfileDeps({
      memberRow: baseMemberRow({ handle: null, bannerKey: 'banners/u1/b.png' }),
      maskedStatus: 'idle',
    });
    const view = await service.getFullProfile('w1', 'viewer', 'u1');
    expect(view.handle).toBe('alice'); // handle null → username
    expect(view.presenceStatus).toBe('idle');
    expect(view.timezone).toBe('Asia/Seoul');
    expect(view.bannerUrl).toBe('http://get.stub/banners/u1/b.png');
  });

  it('masks an expired custom status (text + emoji → null)', async () => {
    const service = makeFullProfileDeps({
      memberRow: baseMemberRow({
        customStatus: 'lunch',
        customStatusEmoji: '🍔',
        // 2024 — 2025-01-01 고정 시각보다 과거 → 만료.
        customStatusExpiresAt: new Date('2024-12-31T00:00:00Z'),
      }),
    });
    const view = await service.getFullProfile('w1', 'viewer', 'u1');
    expect(view.customStatus).toBeNull();
    expect(view.customStatusEmoji).toBeNull();
  });

  it('keeps a non-expired custom status', async () => {
    const service = makeFullProfileDeps({
      memberRow: baseMemberRow({
        customStatus: 'busy',
        customStatusEmoji: '🔴',
        customStatusExpiresAt: new Date('2025-06-01T00:00:00Z'),
      }),
    });
    const view = await service.getFullProfile('w1', 'viewer', 'u1');
    expect(view.customStatus).toBe('busy');
    expect(view.customStatusEmoji).toBe('🔴');
  });

  it('returns only custom roles (system backfill roles filtered out)', async () => {
    const row = baseMemberRow();
    row.role = 'ADMIN';
    row.memberRoles = [
      { role: { id: 'sys', name: 'ADMIN', colorHex: null, isSystem: true } },
      { role: { id: 'r1', name: 'Builder', colorHex: '#5865F2', isSystem: false } },
    ];
    const service = makeFullProfileDeps({ memberRow: row });
    const view = await service.getFullProfile('w1', 'viewer', 'u1');
    expect(view.systemRole).toBe('ADMIN');
    expect(view.customRoles).toEqual([{ id: 'r1', name: 'Builder', color: '#5865F2' }]);
  });

  it('throws WORKSPACE_NOT_MEMBER when the member row is absent (race guard)', async () => {
    const service = makeFullProfileDeps({ memberRow: null });
    await expect(service.getFullProfile('w1', 'viewer', 'u-gone')).rejects.toMatchObject({
      code: ErrorCode.WORKSPACE_NOT_MEMBER,
    });
  });
});
