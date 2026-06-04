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
  updateMany: ReturnType<typeof vi.fn>;
};

function makeDeps(opts: {
  current?: Record<string, unknown> | null;
  updateThrows?: unknown;
  // reviewer MEDIUM (TOCTOU): updateMany 가 매칭 0건을 반환하는 동시-변경 경로 시뮬레이션.
  updateManyCount?: number;
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
    updateMany: vi.fn(async () => {
      if (opts.updateThrows) throw opts.updateThrows;
      return { count: opts.updateManyCount ?? 1 };
    }),
  };
  const deleteObject = vi.fn(async () => undefined);
  const prisma = { user } as unknown as PrismaService;
  const s3 = {
    presignPut: vi.fn(async () => 'http://put.stub'),
    presignPost: vi.fn(async () => ({
      url: 'http://post.stub',
      fields: { key: 'k', 'Content-Type': 'image/png', policy: 'p' },
    })),
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
    // reviewer MEDIUM (TOCTOU): handle 변경은 쿨다운 where 가드가 결합된 updateMany 로 적용된다.
    const arg = user.updateMany.mock.calls[0]?.[0] as {
      where: { id: string; OR: unknown[] };
      data: Record<string, unknown>;
    };
    expect(arg.data.handle).toBe('alice2');
    expect(arg.data.handleChangedAt).toBeInstanceOf(Date);
    expect(arg.where.id).toBe('u1');
    expect(Array.isArray(arg.where.OR)).toBe(true);
  });

  it('rejects a concurrent handle change that loses the atomic cooldown guard (count=0)', async () => {
    // updateMany 가 0건 매칭 = 동시 PATCH 가 직전에 handleChangedAt 을 now 로 찍음.
    // findUnique 재조회가 now 직전 변경(쿨다운 활성)을 돌려주도록 둔다.
    const { service, user } = makeDeps({
      current: {
        id: 'u1',
        email: 'a@b.com',
        username: 'alice',
        handle: 'alice',
        // 1차 assertCooldown 은 통과(과거) — 2차 atomic 가드만 막는다.
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
      updateManyCount: 0,
    });
    // 재조회는 동시 변경이 막 찍은 now(쿨다운 활성)를 반환.
    user.findUnique
      .mockResolvedValueOnce({ handle: 'alice', username: 'alice', handleChangedAt: null })
      .mockResolvedValueOnce({ handleChangedAt: new Date('2024-12-31T23:59:00Z') });
    await expect(service.updateProfile('u1', { handle: 'alice2' })).rejects.toMatchObject({
      code: ErrorCode.HANDLE_COOLDOWN_ACTIVE,
    });
  });

  it('skips bio length validation when bio is not in the patch (no regression for ≥191-char rows)', async () => {
    // 기존 191자 bio 유저가 bio 를 보내지 않고 다른 필드만 저장 → 통과해야 한다.
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
        bio: 'x'.repeat(300),
        avatarKey: null,
        customStatus: null,
      },
    });
    await expect(service.updateProfile('u1', { displayName: 'Alice' })).resolves.toBeDefined();
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

  it('returns a key under the user prefix + a presigned POST url+fields (HIGH#2)', async () => {
    const { service, s3 } = makeDeps({});
    const r = await service.presignAvatar('u1', 'image/png', 1024);
    expect(r.key.startsWith('avatars/u1/')).toBe(true);
    expect(r.key.endsWith('.png')).toBe(true);
    expect(r.url).toBe('http://post.stub');
    expect(r.fields).toMatchObject({ 'Content-Type': 'image/png' });
    // MinIO 가 업로드 시점에 크기/MIME 를 강제하도록 presignPost(content-length-range 상한
    // = AVATAR_MAX_BYTES)를 호출한다(presignPut 아님).
    const presignPost = s3.presignPost as unknown as ReturnType<typeof vi.fn>;
    expect(presignPost).toHaveBeenCalledWith(
      r.key,
      'image/png',
      AVATAR_MAX_BYTES,
      expect.any(Number),
    );
  });
});

describe('ProfileService.finalizeAvatar', () => {
  it('rejects a key not under the caller prefix with FORBIDDEN', async () => {
    const { service } = makeDeps({});
    await expect(service.finalizeAvatar('u1', 'avatars/u2/evil.png')).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
  });

  it('rejects a path-traversal key (..) with FORBIDDEN before touching storage (HIGH#1)', async () => {
    const { service, s3 } = makeDeps({});
    await expect(service.finalizeAvatar('u1', 'avatars/u1/../u2/evil.png')).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
    // traversal 은 HEAD 전에 즉시 거부 — 스토리지를 건드리지 않는다.
    const headObject = s3.headObject as unknown as ReturnType<typeof vi.fn>;
    expect(headObject).not.toHaveBeenCalled();
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
