import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  CustomEmojiService,
  CUSTOM_EMOJI_CAP,
  CUSTOM_EMOJI_MAX_BYTES,
} from '../../../src/emojis/custom-emoji.service';
import { DomainError } from '../../../src/common/errors/domain-error';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';

/**
 * S41 (D05): CustomEmojiService unit coverage. The cap path now uses the
 * PRD concurrency pattern (raw `INSERT … ON CONFLICT DO NOTHING RETURNING`
 * → `SELECT COUNT(*) … FOR UPDATE`), so the fakes drive `tx.$queryRaw`
 * rather than `tx.customEmoji.count/create`. Two knobs:
 *   - `insertedRows`: what the INSERT … RETURNING returns ([] = name taken).
 *   - `countAfterInsert`: the COUNT(*) … FOR UPDATE result (post-insert).
 */
function makeDeps(
  overrides: Partial<{ insertedRows: { id: string }[]; countAfterInsert: number }> = {},
) {
  const insertedRows = overrides.insertedRows ?? [{ id: 'inserted' }];
  const countAfterInsert = overrides.countAfterInsert ?? 1;
  const deleteSpy = vi.fn().mockResolvedValue({});
  const tx = {
    // The service issues a Workspace-row lock ($executeRaw) first, then the
    // INSERT ($queryRaw), then the COUNT ($queryRaw). $queryRaw returns by
    // call order: 1st → inserted rows, 2nd → count rows.
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce(insertedRows)
      .mockResolvedValueOnce([{ cnt: BigInt(countAfterInsert) }]),
    customEmoji: { delete: deleteSpy },
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
  const outbox = {
    record: vi.fn().mockResolvedValue('outbox-id'),
  } as unknown as ConstructorParameters<typeof CustomEmojiService>[2];
  return { prisma, s3, outbox, tx, deleteSpy };
}

const input = {
  workspaceId: '11111111-1111-1111-1111-111111111111',
  uploaderId: '22222222-2222-2222-2222-222222222222',
  // S42 (FR-PK04): presign 게이트가 OWNER/ADMIN 은 항상 통과시키므로 unit 의 기본
  // caller 는 ADMIN 으로 둔다(canMemberUpload 분기는 int 에서 별도 검증).
  uploaderRole: 'ADMIN' as const,
  name: 'party_parrot',
  mime: 'image/png',
  sizeBytes: 1024,
  filename: 'pp.png',
};

describe('CustomEmojiService.presignUpload', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects invalid names (regex mismatch)', async () => {
    const { prisma, s3, outbox } = makeDeps();
    const svc = new CustomEmojiService(prisma, s3, outbox);
    await expect(svc.presignUpload({ ...input, name: 'Bad Name!' })).rejects.toMatchObject({
      code: ErrorCode.CUSTOM_EMOJI_NAME_INVALID,
    });
  });

  it('rejects disallowed mime with INVALID_FILE (422)', async () => {
    const { prisma, s3, outbox } = makeDeps();
    const svc = new CustomEmojiService(prisma, s3, outbox);
    await expect(svc.presignUpload({ ...input, mime: 'image/svg+xml' })).rejects.toMatchObject({
      code: ErrorCode.INVALID_FILE,
    });
  });

  it('rejects JPEG (not in webp/png/gif whitelist) with INVALID_FILE', async () => {
    const { prisma, s3, outbox } = makeDeps();
    const svc = new CustomEmojiService(prisma, s3, outbox);
    await expect(svc.presignUpload({ ...input, mime: 'image/jpeg' })).rejects.toMatchObject({
      code: ErrorCode.INVALID_FILE,
    });
  });

  it('accepts image/webp (S41 FR-EM01)', async () => {
    const { prisma, s3, outbox } = makeDeps({ countAfterInsert: 5 });
    const svc = new CustomEmojiService(prisma, s3, outbox);
    const r = await svc.presignUpload({ ...input, mime: 'image/webp', filename: 'p.webp' });
    expect(r.putUrl).toBe('https://put.example');
  });

  it('rejects oversize payloads with INVALID_FILE', async () => {
    const { prisma, s3, outbox } = makeDeps();
    const svc = new CustomEmojiService(prisma, s3, outbox);
    await expect(
      svc.presignUpload({ ...input, sizeBytes: CUSTOM_EMOJI_MAX_BYTES + 1 }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_FILE });
  });

  it('rejects when workspace exceeds cap with EMOJI_WORKSPACE_LIMIT (409) + rolls back the row', async () => {
    // INSERT lands a row (RETURNING id), then COUNT … FOR UPDATE reports
    // cap+1 — the just-inserted row pushed past the cap, so the service
    // DELETEs it and throws EMOJI_WORKSPACE_LIMIT.
    const { prisma, s3, outbox, deleteSpy } = makeDeps({
      insertedRows: [{ id: 'inserted' }],
      countAfterInsert: CUSTOM_EMOJI_CAP + 1,
    });
    const svc = new CustomEmojiService(prisma, s3, outbox);
    await expect(svc.presignUpload(input)).rejects.toMatchObject({
      code: ErrorCode.EMOJI_WORKSPACE_LIMIT,
    });
    expect(deleteSpy).toHaveBeenCalledTimes(1);
  });

  it('translates an empty INSERT … RETURNING (ON CONFLICT) into CUSTOM_EMOJI_NAME_TAKEN', async () => {
    const { prisma, s3, outbox } = makeDeps({ insertedRows: [] });
    const svc = new CustomEmojiService(prisma, s3, outbox);
    await expect(svc.presignUpload(input)).rejects.toMatchObject({
      code: ErrorCode.CUSTOM_EMOJI_NAME_TAKEN,
    });
  });

  it('returns a presigned PUT + emoji id on success (count within cap)', async () => {
    const { prisma, s3, outbox } = makeDeps({ countAfterInsert: 5 });
    const svc = new CustomEmojiService(prisma, s3, outbox);
    const r = await svc.presignUpload(input);
    expect(r.putUrl).toBe('https://put.example');
    expect(r.emojiId).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.storageKey).toContain(`${input.workspaceId}/emojis/`);
  });
});

describe('CustomEmojiService.delete authorization (S41 FR-EM04)', () => {
  beforeEach(() => vi.clearAllMocks());

  function makeDeleteDeps(
    row: { workspaceId: string; createdBy: string; storageKey: string } | null,
  ) {
    const prisma = {
      customEmoji: {
        findUnique: vi.fn().mockResolvedValue(row),
        delete: vi.fn().mockResolvedValue({}),
      },
    } as unknown as ConstructorParameters<typeof CustomEmojiService>[0];
    const s3 = {
      deleteObject: vi.fn().mockResolvedValue(undefined),
    } as unknown as ConstructorParameters<typeof CustomEmojiService>[1];
    const outbox = {
      record: vi.fn().mockResolvedValue('id'),
    } as unknown as ConstructorParameters<typeof CustomEmojiService>[2];
    return { prisma, s3, outbox };
  }

  const wsId = 'ws-1';
  const uploaderId = 'uploader-1';
  const otherId = 'other-1';
  const row = { workspaceId: wsId, createdBy: uploaderId, storageKey: 'k' };

  it('allows the uploader (MEMBER) to delete their own emoji', async () => {
    const { prisma, s3, outbox } = makeDeleteDeps(row);
    const svc = new CustomEmojiService(prisma, s3, outbox);
    await expect(svc.delete(wsId, 'e1', uploaderId, 'MEMBER')).resolves.toBeUndefined();
    expect(outbox.record).toHaveBeenCalledTimes(1);
  });

  it('allows OWNER/ADMIN to delete someone else’s emoji', async () => {
    const { prisma, s3, outbox } = makeDeleteDeps(row);
    const svc = new CustomEmojiService(prisma, s3, outbox);
    await expect(svc.delete(wsId, 'e1', otherId, 'ADMIN')).resolves.toBeUndefined();
  });

  it('rejects a MEMBER deleting someone else’s emoji with FORBIDDEN', async () => {
    const { prisma, s3, outbox } = makeDeleteDeps(row);
    const svc = new CustomEmojiService(prisma, s3, outbox);
    await expect(svc.delete(wsId, 'e1', otherId, 'MEMBER')).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
  });

  it('rejects deleting a missing emoji with CUSTOM_EMOJI_NOT_FOUND', async () => {
    const { prisma, s3, outbox } = makeDeleteDeps(null);
    const svc = new CustomEmojiService(prisma, s3, outbox);
    await expect(svc.delete(wsId, 'e1', uploaderId, 'OWNER')).rejects.toMatchObject({
      code: ErrorCode.CUSTOM_EMOJI_NOT_FOUND,
    });
  });
});

describe('CustomEmojiService.addAlias (S42 FR-EM05)', () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * addAlias issues, in order: $executeRaw(없음 — 잠금은 SELECT FOR UPDATE via
   * $queryRaw), then $queryRaw calls: (1) target SELECT FOR NO KEY UPDATE,
   * (2) COUNT, (3) name-clash SELECT, (4) INSERT … ON CONFLICT RETURNING, then
   * tx.customEmojiAlias.findMany. We drive each $queryRaw return by call order.
   */
  function makeAliasDeps(opts: {
    target?: { id: string; name: string }[];
    count?: number;
    nameClash?: { id: string }[];
    inserted?: { id: string }[];
    finalAliases?: { alias: string }[];
  }) {
    const target = opts.target ?? [{ id: 'e1', name: 'parrot' }];
    const count = opts.count ?? 0;
    const nameClash = opts.nameClash ?? [];
    const inserted = opts.inserted ?? [{ id: 'alias-1' }];
    const finalAliases = opts.finalAliases ?? [{ alias: 'birb' }];
    const tx = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce(target)
        .mockResolvedValueOnce([{ cnt: BigInt(count) }])
        .mockResolvedValueOnce(nameClash)
        .mockResolvedValueOnce(inserted),
      customEmojiAlias: { findMany: vi.fn().mockResolvedValue(finalAliases) },
    };
    const prisma = {
      $transaction: vi
        .fn()
        .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as ConstructorParameters<typeof CustomEmojiService>[0];
    const s3 = {} as unknown as ConstructorParameters<typeof CustomEmojiService>[1];
    const outbox = {
      record: vi.fn().mockResolvedValue('id'),
    } as unknown as ConstructorParameters<typeof CustomEmojiService>[2];
    return { prisma, s3, outbox, tx };
  }

  it('rejects an invalid alias slug', async () => {
    const { prisma, s3, outbox } = makeAliasDeps({});
    const svc = new CustomEmojiService(prisma, s3, outbox);
    await expect(svc.addAlias('w1', 'e1', 'Bad Alias!', 'u1')).rejects.toMatchObject({
      code: ErrorCode.CUSTOM_EMOJI_NAME_INVALID,
    });
  });

  it('rejects when the target emoji is missing (CUSTOM_EMOJI_NOT_FOUND)', async () => {
    const { prisma, s3, outbox } = makeAliasDeps({ target: [] });
    const svc = new CustomEmojiService(prisma, s3, outbox);
    await expect(svc.addAlias('w1', 'e1', 'birb', 'u1')).rejects.toMatchObject({
      code: ErrorCode.CUSTOM_EMOJI_NOT_FOUND,
    });
  });

  it('rejects past the 10-alias cap with ALIAS_LIMIT', async () => {
    const { prisma, s3, outbox } = makeAliasDeps({ count: 10 });
    const svc = new CustomEmojiService(prisma, s3, outbox);
    await expect(svc.addAlias('w1', 'e1', 'birb', 'u1')).rejects.toMatchObject({
      code: ErrorCode.ALIAS_LIMIT,
    });
  });

  it('rejects a name collision with ALIAS_CONFLICT', async () => {
    const { prisma, s3, outbox } = makeAliasDeps({ nameClash: [{ id: 'other' }] });
    const svc = new CustomEmojiService(prisma, s3, outbox);
    await expect(svc.addAlias('w1', 'e1', 'birb', 'u1')).rejects.toMatchObject({
      code: ErrorCode.ALIAS_CONFLICT,
    });
  });

  it('rejects an alias collision (empty INSERT RETURNING) with ALIAS_CONFLICT', async () => {
    const { prisma, s3, outbox } = makeAliasDeps({ inserted: [] });
    const svc = new CustomEmojiService(prisma, s3, outbox);
    await expect(svc.addAlias('w1', 'e1', 'birb', 'u1')).rejects.toMatchObject({
      code: ErrorCode.ALIAS_CONFLICT,
    });
  });

  it('adds the alias + emits emoji.alias_updated on success', async () => {
    const { prisma, s3, outbox } = makeAliasDeps({ finalAliases: [{ alias: 'birb' }] });
    const svc = new CustomEmojiService(prisma, s3, outbox);
    const res = await svc.addAlias('w1', 'e1', 'birb', 'u1');
    expect(res.aliases).toEqual(['birb']);
    expect(outbox.record).toHaveBeenCalledTimes(1);
    expect((outbox.record as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({
      eventType: 'emoji.alias_updated',
    });
  });
});

describe('CustomEmojiService.removeAlias (S42 FR-EM05)', () => {
  beforeEach(() => vi.clearAllMocks());

  function makeRemoveDeps(
    row: { id: string; customEmojiId: string; createdBy: string } | null,
    remaining: { alias: string }[] = [],
  ) {
    const prisma = {
      customEmojiAlias: {
        findUnique: vi.fn().mockResolvedValue(row),
        delete: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue(remaining),
      },
    } as unknown as ConstructorParameters<typeof CustomEmojiService>[0];
    const s3 = {} as unknown as ConstructorParameters<typeof CustomEmojiService>[1];
    const outbox = {
      record: vi.fn().mockResolvedValue('id'),
    } as unknown as ConstructorParameters<typeof CustomEmojiService>[2];
    return { prisma, s3, outbox };
  }

  const aliasRow = { id: 'a1', customEmojiId: 'e1', createdBy: 'creator' };

  it('lets the creator remove their own alias', async () => {
    const { prisma, s3, outbox } = makeRemoveDeps(aliasRow);
    const svc = new CustomEmojiService(prisma, s3, outbox);
    await expect(svc.removeAlias('w1', 'e1', 'birb', 'creator', 'MEMBER')).resolves.toBeUndefined();
    expect(outbox.record).toHaveBeenCalledTimes(1);
  });

  it('lets OWNER/ADMIN remove a foreign alias', async () => {
    const { prisma, s3, outbox } = makeRemoveDeps(aliasRow);
    const svc = new CustomEmojiService(prisma, s3, outbox);
    await expect(svc.removeAlias('w1', 'e1', 'birb', 'someone', 'ADMIN')).resolves.toBeUndefined();
  });

  it('rejects a foreign MEMBER with FORBIDDEN', async () => {
    const { prisma, s3, outbox } = makeRemoveDeps(aliasRow);
    const svc = new CustomEmojiService(prisma, s3, outbox);
    await expect(svc.removeAlias('w1', 'e1', 'birb', 'someone', 'MEMBER')).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
  });

  it('rejects a missing alias with CUSTOM_EMOJI_NOT_FOUND', async () => {
    const { prisma, s3, outbox } = makeRemoveDeps(null);
    const svc = new CustomEmojiService(prisma, s3, outbox);
    await expect(svc.removeAlias('w1', 'e1', 'birb', 'creator', 'OWNER')).rejects.toMatchObject({
      code: ErrorCode.CUSTOM_EMOJI_NOT_FOUND,
    });
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
