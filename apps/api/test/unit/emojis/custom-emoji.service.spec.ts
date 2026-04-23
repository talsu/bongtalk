import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  CustomEmojiService,
  CUSTOM_EMOJI_CAP,
  CUSTOM_EMOJI_MAX_BYTES,
} from '../../../src/emojis/custom-emoji.service';
import { DomainError } from '../../../src/common/errors/domain-error';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';

// Minimal PrismaService / S3Service fakes — the service only touches
// `prisma.customEmoji.{count,create,delete,findUnique,findMany}` and
// `$transaction`, plus the S3 presign + delete methods.
function makeDeps(overrides: Partial<{ count: number; p2002: boolean }> = {}) {
  const count = overrides.count ?? 0;
  const tx = {
    customEmoji: {
      count: vi.fn().mockResolvedValue(count),
      create: vi.fn().mockImplementation(async () => {
        if (overrides.p2002) {
          throw Object.assign(
            new Prisma.PrismaClientKnownRequestError('dup', {
              code: 'P2002',
              clientVersion: '5.x',
            }),
          );
        }
        return {};
      }),
    },
  };
  const prisma = {
    $transaction: vi
      .fn()
      .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
  } as unknown as ConstructorParameters<typeof CustomEmojiService>[0];
  const s3 = {
    presignPut: vi.fn().mockResolvedValue('https://put.example'),
    presignGet: vi.fn().mockResolvedValue('https://get.example'),
    presignPutTtl: 900,
    presignGetTtl: 1800,
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  } as unknown as ConstructorParameters<typeof CustomEmojiService>[1];
  return { prisma, s3, tx };
}

const input = {
  workspaceId: '11111111-1111-1111-1111-111111111111',
  uploaderId: '22222222-2222-2222-2222-222222222222',
  name: 'party_parrot',
  mime: 'image/png',
  sizeBytes: 1024,
  filename: 'pp.png',
};

describe('CustomEmojiService.presignUpload', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects invalid names (regex mismatch)', async () => {
    const { prisma, s3 } = makeDeps();
    const svc = new CustomEmojiService(prisma, s3);
    await expect(svc.presignUpload({ ...input, name: 'Bad Name!' })).rejects.toMatchObject({
      code: ErrorCode.CUSTOM_EMOJI_NAME_INVALID,
    });
  });

  it('rejects disallowed mime', async () => {
    const { prisma, s3 } = makeDeps();
    const svc = new CustomEmojiService(prisma, s3);
    await expect(svc.presignUpload({ ...input, mime: 'image/svg+xml' })).rejects.toMatchObject({
      code: ErrorCode.CUSTOM_EMOJI_MIME_REJECTED,
    });
  });

  it('rejects oversize payloads', async () => {
    const { prisma, s3 } = makeDeps();
    const svc = new CustomEmojiService(prisma, s3);
    await expect(
      svc.presignUpload({ ...input, sizeBytes: CUSTOM_EMOJI_MAX_BYTES + 1 }),
    ).rejects.toMatchObject({ code: ErrorCode.CUSTOM_EMOJI_TOO_LARGE });
  });

  it('rejects when workspace is already at cap', async () => {
    const { prisma, s3 } = makeDeps({ count: CUSTOM_EMOJI_CAP });
    const svc = new CustomEmojiService(prisma, s3);
    await expect(svc.presignUpload(input)).rejects.toMatchObject({
      code: ErrorCode.CUSTOM_EMOJI_CAP_REACHED,
    });
  });

  it('translates P2002 into CUSTOM_EMOJI_NAME_TAKEN', async () => {
    const { prisma, s3 } = makeDeps({ p2002: true });
    const svc = new CustomEmojiService(prisma, s3);
    await expect(svc.presignUpload(input)).rejects.toMatchObject({
      code: ErrorCode.CUSTOM_EMOJI_NAME_TAKEN,
    });
  });

  it('returns a presigned PUT + emoji id on success', async () => {
    const { prisma, s3 } = makeDeps({ count: 5 });
    const svc = new CustomEmojiService(prisma, s3);
    const r = await svc.presignUpload(input);
    expect(r.putUrl).toBe('https://put.example');
    expect(r.emojiId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.storageKey).toContain(`${input.workspaceId}/emojis/`);
  });
});

// Assert DomainError.code is surfaced so `.toMatchObject({ code: ... })`
// works against these errors in the tests above.
describe('DomainError compatibility', () => {
  it('exposes code', () => {
    const err = new DomainError(ErrorCode.CUSTOM_EMOJI_NAME_INVALID, 'x');
    expect(err.code).toBe(ErrorCode.CUSTOM_EMOJI_NAME_INVALID);
  });
});
