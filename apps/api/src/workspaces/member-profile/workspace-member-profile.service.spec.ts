import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceMemberProfileService } from './workspace-member-profile.service';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { WS_NICKNAME_MAX, WS_BIO_MAX, WS_AVATAR_MAX_BYTES } from '@qufox/shared-types';
import type { PrismaService } from '../../prisma/prisma.module';
import type { S3Service } from '../../storage/s3.service';

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
    presignGet: vi.fn(async () => 'http://get.stub/ws-avatar'),
    headObject: vi.fn(async () =>
      opts.headObject === undefined
        ? { contentLength: 1024, contentType: 'image/png' }
        : opts.headObject,
    ),
    getObjectRange: vi.fn(async () => (opts.headBytes === undefined ? PNG_MAGIC : opts.headBytes)),
    deleteObject,
  } as unknown as S3Service;
  return {
    service: new WorkspaceMemberProfileService(prisma, s3),
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
    expect(view.avatarUrl).toBe('http://get.stub/ws-avatar');
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
    expect(r.avatarUrl).toBe('http://get.stub/ws-avatar');
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
