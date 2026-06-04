import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { ProfileService } from './profile.service';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { HANDLE_COOLDOWN_DAYS, AVATAR_MAX_BYTES } from '@qufox/shared-types';
import type { PrismaService } from '../prisma/prisma.module';
import type { S3Service } from '../storage/s3.service';

/**
 * S73 (D14 / FR-PS-01·02·03): 전역 프로필 + 아바타 도메인 단위 테스트.
 *
 * 외부(Prisma / S3)는 vi.fn() 으로만 모킹. 시간 고정(2025-01-01).
 *   - handle 형식([a-z0-9_.]{3,32}) / 30일 쿨다운 / nextAllowedAt.
 *   - 프로필 필드 길이(displayName 1-80·bio 190 등).
 *   - 아바타 presign(MIME/크기) / finalize(HEAD·magic-byte·prefix) / delete.
 */
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

type UserStub = {
  findUnique: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

function makeDeps(opts: {
  current?: Record<string, unknown> | null;
  updateThrows?: unknown;
  headObject?: { contentLength: number; contentType: string | undefined } | null;
  headBytes?: Uint8Array | null;
}): {
  prisma: PrismaService;
  s3: S3Service;
  user: UserStub;
  s3Calls: { deleteObject: ReturnType<typeof vi.fn> };
  service: ProfileService;
} {
  const defaultRow = {
    id: 'u1',
    email: 'a@b.com',
    username: 'alice',
    handle: 'alice',
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
  };
  // 모든 override row 가 links 를 명시하지 않아도 toView 가 동작하도록 base 를 병합한다.
  const row = opts.current ? { ...defaultRow, ...opts.current } : defaultRow;
  const user: UserStub = {
    findUnique: vi.fn(async () => row),
    update: vi.fn(async () => {
      if (opts.updateThrows) throw opts.updateThrows;
      return row;
    }),
  };
  const deleteObject = vi.fn(async () => undefined);
  const prisma = { user } as unknown as PrismaService;
  const s3 = {
    presignPut: vi.fn(async () => 'http://put.stub'),
    presignGet: vi.fn(async () => 'http://get.stub/avatar'),
    headObject: vi.fn(async () =>
      opts.headObject === undefined
        ? { contentLength: 1024, contentType: 'image/png' }
        : opts.headObject,
    ),
    getObjectRange: vi.fn(async () => (opts.headBytes === undefined ? PNG_MAGIC : opts.headBytes)),
    deleteObject,
    presignPutTtl: 900,
    presignGetTtl: 1800,
  } as unknown as S3Service;
  return { prisma, s3, user, s3Calls: { deleteObject }, service: new ProfileService(prisma, s3) };
}

describe('ProfileService.getProfile', () => {
  it('falls back handle to username when handle is null', async () => {
    const { service } = makeDeps({
      current: {
        id: 'u1',
        email: 'a@b.com',
        username: 'bob',
        handle: null,
        displayName: null,
        fullName: null,
        pronouns: null,
        title: null,
        timezone: null,
        bio: null,
        handleChangedAt: null,
        avatarKey: null,
        customStatus: null,
      },
    });
    const view = await service.getProfile('u1');
    expect(view.handle).toBe('bob');
    expect(view.avatarUrl).toBeNull();
  });

  it('resolves avatarUrl via presignGet when avatarKey is set', async () => {
    const { service } = makeDeps({
      current: {
        id: 'u1',
        email: 'a@b.com',
        username: 'alice',
        handle: 'alice',
        displayName: 'Alice',
        fullName: null,
        pronouns: null,
        title: null,
        timezone: null,
        bio: null,
        handleChangedAt: new Date('2024-12-01T00:00:00Z'),
        avatarKey: 'avatars/u1/abc.png',
        customStatus: null,
      },
    });
    const view = await service.getProfile('u1');
    expect(view.avatarUrl).toBe('http://get.stub/avatar');
    expect(view.handleChangedAt).toBe('2024-12-01T00:00:00.000Z');
  });
});

describe('ProfileService.updateProfile — handle', () => {
  it('rejects an invalid handle with VALIDATION_FAILED', async () => {
    const { service } = makeDeps({});
    await expect(service.updateProfile('u1', { handle: 'Bad Handle' })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_FAILED,
    });
  });

  it('treats setting the same effective handle as a no-op (no cooldown)', async () => {
    const { service, user } = makeDeps({
      current: {
        id: 'u1',
        email: 'a@b.com',
        username: 'alice',
        handle: 'alice',
        // 쿨다운이 켜져 있어도 동일 handle 이면 검증 스킵.
        handleChangedAt: new Date('2024-12-31T00:00:00Z'),
        displayName: null,
        fullName: null,
        pronouns: null,
        title: null,
        timezone: null,
        bio: null,
        avatarKey: null,
        customStatus: null,
      },
    });
    const r = await service.updateProfile('u1', { handle: 'alice' });
    expect(r.handleChanged).toBe(false);
    // update 호출되더라도 data.handle 은 없어야 한다.
    const updateArg = user.update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(updateArg.data.handle).toBeUndefined();
  });

  it('blocks a handle change within the 30-day cooldown with nextAllowedAt', async () => {
    // 마지막 변경: 2024-12-31 (now=2025-01-01 → 1일 경과, 30일 쿨다운 중).
    const last = new Date('2024-12-31T00:00:00Z');
    const { service } = makeDeps({
      current: {
        id: 'u1',
        email: 'a@b.com',
        username: 'alice',
        handle: 'alice',
        handleChangedAt: last,
        displayName: null,
        fullName: null,
        pronouns: null,
        title: null,
        timezone: null,
        bio: null,
        avatarKey: null,
        customStatus: null,
      },
    });
    try {
      await service.updateProfile('u1', { handle: 'alice2' });
      expect.unreachable('should have thrown');
    } catch (e) {
      const err = e as DomainError;
      expect(err.code).toBe(ErrorCode.HANDLE_COOLDOWN_ACTIVE);
      const expected = new Date(
        last.getTime() + HANDLE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString();
      expect((err.details as { nextAllowedAt: string }).nextAllowedAt).toBe(expected);
    }
  });

  it('allows a handle change after the cooldown has elapsed + stamps handleChangedAt', async () => {
    // 마지막 변경: 2024-11-01 (61일 경과 — 쿨다운 종료).
    const { service, user } = makeDeps({
      current: {
        id: 'u1',
        email: 'a@b.com',
        username: 'alice',
        handle: 'alice',
        handleChangedAt: new Date('2024-11-01T00:00:00Z'),
        displayName: null,
        fullName: null,
        pronouns: null,
        title: null,
        timezone: null,
        bio: null,
        avatarKey: null,
        customStatus: null,
      },
    });
    const r = await service.updateProfile('u1', { handle: 'alice2' });
    expect(r.handleChanged).toBe(true);
    const updateArg = user.update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(updateArg.data.handle).toBe('alice2');
    expect(updateArg.data.handleChangedAt).toBeInstanceOf(Date);
  });

  it('allows the first-ever handle set when handleChangedAt is null', async () => {
    const { service } = makeDeps({
      current: {
        id: 'u1',
        email: 'a@b.com',
        username: 'alice',
        handle: null,
        handleChangedAt: null,
        displayName: null,
        fullName: null,
        pronouns: null,
        title: null,
        timezone: null,
        bio: null,
        avatarKey: null,
        customStatus: null,
      },
    });
    const r = await service.updateProfile('u1', { handle: 'newhandle' });
    expect(r.handleChanged).toBe(true);
  });

  it('maps a P2002 unique violation to HANDLE_TAKEN', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('unique', {
      code: 'P2002',
      clientVersion: '5.22.0',
    });
    const { service } = makeDeps({
      current: {
        id: 'u1',
        email: 'a@b.com',
        username: 'alice',
        handle: 'alice',
        handleChangedAt: null,
        displayName: null,
        fullName: null,
        pronouns: null,
        title: null,
        timezone: null,
        bio: null,
        avatarKey: null,
        customStatus: null,
      },
      updateThrows: p2002,
    });
    await expect(service.updateProfile('u1', { handle: 'taken' })).rejects.toMatchObject({
      code: ErrorCode.HANDLE_TAKEN,
    });
  });
});

describe('ProfileService.updateProfile — field validation', () => {
  it('rejects a displayName over 80 chars', async () => {
    const { service } = makeDeps({});
    await expect(
      service.updateProfile('u1', { displayName: 'x'.repeat(81) }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });

  it('rejects a bio over 190 chars (app layer, not DB)', async () => {
    const { service } = makeDeps({});
    await expect(service.updateProfile('u1', { bio: 'x'.repeat(191) })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_FAILED,
    });
  });

  it('normalizes empty/whitespace fields to null', async () => {
    const { service, user } = makeDeps({});
    await service.updateProfile('u1', { fullName: '   ', title: '' });
    const updateArg = user.update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(updateArg.data.fullName).toBeNull();
    expect(updateArg.data.title).toBeNull();
  });
});

describe('ProfileService.presignAvatar', () => {
  it('rejects a disallowed mime with INVALID_MIME', async () => {
    const { service } = makeDeps({});
    await expect(service.presignAvatar('u1', 'image/gif', 1024)).rejects.toMatchObject({
      code: ErrorCode.INVALID_MIME,
    });
  });

  it('rejects oversize with FILE_TOO_LARGE', async () => {
    const { service } = makeDeps({});
    await expect(
      service.presignAvatar('u1', 'image/png', AVATAR_MAX_BYTES + 1),
    ).rejects.toMatchObject({ code: ErrorCode.FILE_TOO_LARGE });
  });

  it('returns a key under the user prefix + a putUrl', async () => {
    const { service } = makeDeps({});
    const r = await service.presignAvatar('u1', 'image/png', 1024);
    expect(r.key.startsWith('avatars/u1/')).toBe(true);
    expect(r.key.endsWith('.png')).toBe(true);
    expect(r.putUrl).toBe('http://put.stub');
  });
});

describe('ProfileService.finalizeAvatar', () => {
  it('rejects a key not under the caller prefix with FORBIDDEN', async () => {
    const { service } = makeDeps({});
    await expect(service.finalizeAvatar('u1', 'avatars/u2/evil.png')).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
  });

  it('rejects when the object never landed (HEAD null)', async () => {
    const { service } = makeDeps({ headObject: null });
    await expect(service.finalizeAvatar('u1', 'avatars/u1/x.png')).rejects.toMatchObject({
      code: ErrorCode.INVALID_FILE,
    });
  });

  it('rejects + deletes when HEAD size exceeds the cap', async () => {
    const { service, s3Calls } = makeDeps({
      headObject: { contentLength: AVATAR_MAX_BYTES + 1, contentType: 'image/png' },
    });
    await expect(service.finalizeAvatar('u1', 'avatars/u1/x.png')).rejects.toMatchObject({
      code: ErrorCode.FILE_TOO_LARGE,
    });
    expect(s3Calls.deleteObject).toHaveBeenCalledWith('avatars/u1/x.png');
  });

  it('rejects + deletes on magic-byte mismatch', async () => {
    const { service, s3Calls } = makeDeps({
      headObject: { contentLength: 1024, contentType: 'image/png' },
      headBytes: new Uint8Array([0x00, 0x01, 0x02, 0x03]),
    });
    await expect(service.finalizeAvatar('u1', 'avatars/u1/x.png')).rejects.toMatchObject({
      code: ErrorCode.INVALID_MAGIC_BYTES,
    });
    expect(s3Calls.deleteObject).toHaveBeenCalledWith('avatars/u1/x.png');
  });

  it('confirms a valid avatar + returns presigned avatarUrl + deletes the previous key', async () => {
    const { service, user, s3Calls } = makeDeps({
      current: {
        id: 'u1',
        email: 'a@b.com',
        username: 'alice',
        handle: 'alice',
        avatarKey: 'avatars/u1/old.png',
        handleChangedAt: null,
        displayName: null,
        fullName: null,
        pronouns: null,
        title: null,
        timezone: null,
        bio: null,
        customStatus: null,
      },
      headObject: { contentLength: 1024, contentType: 'image/png' },
    });
    const r = await service.finalizeAvatar('u1', 'avatars/u1/new.png');
    expect(r.avatarUrl).toBe('http://get.stub/avatar');
    const updateArg = user.update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(updateArg.data.avatarKey).toBe('avatars/u1/new.png');
    expect(s3Calls.deleteObject).toHaveBeenCalledWith('avatars/u1/old.png');
  });
});

describe('ProfileService.deleteAvatar', () => {
  it('is a no-op when no avatar is set', async () => {
    const { service, user, s3Calls } = makeDeps({});
    await service.deleteAvatar('u1');
    expect(user.update).not.toHaveBeenCalled();
    expect(s3Calls.deleteObject).not.toHaveBeenCalled();
  });

  it('resets avatarKey to null + deletes the object', async () => {
    const { service, user, s3Calls } = makeDeps({
      current: {
        id: 'u1',
        email: 'a@b.com',
        username: 'alice',
        handle: 'alice',
        avatarKey: 'avatars/u1/x.png',
        handleChangedAt: null,
        displayName: null,
        fullName: null,
        pronouns: null,
        title: null,
        timezone: null,
        bio: null,
        customStatus: null,
      },
    });
    await service.deleteAvatar('u1');
    const updateArg = user.update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(updateArg.data.avatarKey).toBeNull();
    expect(s3Calls.deleteObject).toHaveBeenCalledWith('avatars/u1/x.png');
  });
});
