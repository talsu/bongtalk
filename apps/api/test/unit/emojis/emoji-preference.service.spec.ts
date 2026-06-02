import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EmojiPreferenceService } from '../../../src/emojis/emoji-preference.service';
import { CustomEmojiService } from '../../../src/emojis/custom-emoji.service';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';

/**
 * S42 (D05 / FR-PK01/PK03/PK04): EmojiPreferenceService validation + assembly.
 * Prisma + CustomEmojiService are vi.fn() stubs — these specs pin the input
 * validation (skinTone/quickReactions/recentEmojis bounds) + the picker-data
 * default fill, without a DB. Concurrency / actual upsert round-trips live in
 * the int spec.
 */
function makeService(
  overrides: {
    upsertUser?: ReturnType<typeof vi.fn>;
    upsertConfig?: ReturnType<typeof vi.fn>;
    findUser?: ReturnType<typeof vi.fn>;
    findConfig?: ReturnType<typeof vi.fn>;
    list?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const upsertUser =
    overrides.upsertUser ??
    vi.fn().mockResolvedValue({ defaultSkinTone: 1, quickReactions: [], recentEmojis: [] });
  const upsertConfig =
    overrides.upsertConfig ??
    vi.fn().mockResolvedValue({ quickReactions: [], canMemberUpload: false });
  const findUser = overrides.findUser ?? vi.fn().mockResolvedValue(null);
  const findConfig = overrides.findConfig ?? vi.fn().mockResolvedValue(null);
  const list = overrides.list ?? vi.fn().mockResolvedValue([]);
  const prisma = {
    userEmojiPreference: { upsert: upsertUser, findUnique: findUser },
    workspaceEmojiConfig: { upsert: upsertConfig, findUnique: findConfig },
  } as unknown as ConstructorParameters<typeof EmojiPreferenceService>[0];
  const emojis = { list } as unknown as CustomEmojiService;
  return { svc: new EmojiPreferenceService(prisma, emojis), upsertUser, upsertConfig, list };
}

describe('EmojiPreferenceService.updateUserPreference (FR-PK03)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects skinTone < 1', async () => {
    const { svc } = makeService();
    await expect(svc.updateUserPreference('u1', { defaultSkinTone: 0 })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_FAILED,
    });
  });

  it('rejects skinTone > 6', async () => {
    const { svc } = makeService();
    await expect(svc.updateUserPreference('u1', { defaultSkinTone: 7 })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_FAILED,
    });
  });

  it('rejects more than 3 quickReactions', async () => {
    const { svc } = makeService();
    await expect(
      svc.updateUserPreference('u1', { quickReactions: ['a', 'b', 'c', 'd'] }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });

  it('rejects an over-long quickReaction (>64)', async () => {
    const { svc } = makeService();
    await expect(
      svc.updateUserPreference('u1', { quickReactions: ['x'.repeat(65)] }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });

  it('rejects more than 36 recentEmojis', async () => {
    const { svc } = makeService();
    const tooMany = Array.from({ length: 37 }, (_, i) => `e${i}`);
    await expect(svc.updateUserPreference('u1', { recentEmojis: tooMany })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_FAILED,
    });
  });

  it('accepts valid input + upserts', async () => {
    const upsertUser = vi.fn().mockResolvedValue({
      defaultSkinTone: 3,
      quickReactions: ['🎉'],
      recentEmojis: [],
    });
    const { svc } = makeService({ upsertUser });
    const out = await svc.updateUserPreference('u1', {
      defaultSkinTone: 3,
      quickReactions: ['🎉'],
    });
    expect(out.defaultSkinTone).toBe(3);
    expect(upsertUser).toHaveBeenCalledOnce();
  });
});

describe('EmojiPreferenceService.updateWorkspaceConfig (FR-PK04)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects more than 3 quickReactions', async () => {
    const { svc } = makeService();
    await expect(
      svc.updateWorkspaceConfig('w1', { quickReactions: ['a', 'b', 'c', 'd'] }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });

  it('accepts canMemberUpload toggle + upserts', async () => {
    const upsertConfig = vi.fn().mockResolvedValue({ quickReactions: [], canMemberUpload: true });
    const { svc } = makeService({ upsertConfig });
    const out = await svc.updateWorkspaceConfig('w1', { canMemberUpload: true });
    expect(out.canMemberUpload).toBe(true);
    expect(upsertConfig).toHaveBeenCalledOnce();
  });
});

describe('EmojiPreferenceService.getPickerData (FR-PK01)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fills defaults when no config/preference rows exist', async () => {
    const { svc } = makeService({
      list: vi.fn().mockResolvedValue([{ id: 'e1', name: 'parrot', aliases: ['birb'] }]),
    });
    const data = await svc.getPickerData('w1', 'u1');
    expect(data.workspaceQuickReactions).toEqual(['👍', '❤️', '😂']);
    expect(data.userQuickReactions).toBeNull();
    expect(data.recentEmojis).toEqual([]);
    expect(data.defaultSkinTone).toBe(1);
    expect(data.customEmojis[0].aliases).toEqual(['birb']);
  });

  it('reflects present config + user preference', async () => {
    const { svc } = makeService({
      findConfig: vi.fn().mockResolvedValue({ quickReactions: ['🚀', '🎯', '✅'] }),
      findUser: vi.fn().mockResolvedValue({
        quickReactions: ['😎'],
        recentEmojis: ['🔥'],
        defaultSkinTone: 5,
      }),
    });
    const data = await svc.getPickerData('w1', 'u1');
    expect(data.workspaceQuickReactions).toEqual(['🚀', '🎯', '✅']);
    expect(data.userQuickReactions).toEqual(['😎']);
    expect(data.recentEmojis).toEqual(['🔥']);
    expect(data.defaultSkinTone).toBe(5);
  });
});
