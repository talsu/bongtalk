import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  CustomEmojiService,
  CUSTOM_EMOJI_ALIAS_CAP,
} from '../../../src/emojis/custom-emoji.service';
import { EmojiPreferenceService } from '../../../src/emojis/emoji-preference.service';
import { PrismaService, PrismaModule } from '../../../src/prisma/prisma.module';
import { S3Service } from '../../../src/storage/s3.service';
import { OutboxService } from '../../../src/common/outbox/outbox.service';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';

/**
 * S42 (D05) int spec against a real Postgres testcontainer. Verifies the
 * S42 migration (3 new tables + alias unique + prefs/config upsert) round-trips
 * exactly as prod, plus the alias CRUD concurrency, canMemberUpload gating,
 * and the picker-data assembly. S3Service + OutboxService are DI-stubbed
 * (MinIO not required; outbox stub captures events for assertion).
 *
 * Gate items needing a real DB (S05 교훈 — 마이그레이션·unique·race·upsert):
 *   - migration created CustomEmojiAlias / UserEmojiPreference / WorkspaceEmojiConfig
 *   - alias 10-cap → 409 ALIAS_LIMIT
 *   - alias vs CustomEmoji.name conflict → 409 ALIAS_CONFLICT
 *   - concurrent same-alias race → exactly one wins, other 409 ALIAS_CONFLICT
 *   - alias delete permission (creator / admin ok, other MEMBER 403)
 *   - canMemberUpload wiring: false → MEMBER 403, true → 200
 *   - user-preference upsert (idempotent userId-unique upsert)
 *   - picker-data shape with defaults when no rows exist
 */
describe('Emoji aliases + prefs (int)', () => {
  let pg: StartedTestContainer;
  let prisma: PrismaService;
  let svc: CustomEmojiService;
  let prefs: EmojiPreferenceService;
  let outboxEvents: { eventType: string; payload: Record<string, unknown> }[];

  beforeAll(async () => {
    process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
    pg = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({
        POSTGRES_USER: 'qufox',
        POSTGRES_PASSWORD: 'qufox',
        POSTGRES_DB: 'qufox_emoji_s42',
      })
      .withExposedPorts(5432)
      .start();
    const url = `postgresql://qufox:qufox@${pg.getHost()}:${pg.getMappedPort(5432)}/qufox_emoji_s42?schema=public`;
    process.env.DATABASE_URL = url;
    const apiRoot = path.resolve(__dirname, '../../..');
    execSync('pnpm exec prisma migrate deploy', {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    });

    const s3Stub = {
      headObject: async () => ({ contentLength: 8, contentType: undefined }),
      getObjectRange: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      deleteObject: async () => undefined,
      presignPut: async () => 'http://put.stub',
      presignGet: async () => 'http://get.stub',
      presignPutTtl: 900,
      presignGetTtl: 1800,
    };
    outboxEvents = [];
    const outboxStub = {
      record: async (
        _tx: unknown,
        input: { eventType: string; payload: Record<string, unknown> },
      ) => {
        outboxEvents.push({ eventType: input.eventType, payload: input.payload });
        return 'stub-id';
      },
    };

    const mod = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
        CustomEmojiService,
        EmojiPreferenceService,
        { provide: S3Service, useValue: s3Stub },
        { provide: OutboxService, useValue: outboxStub },
      ],
    }).compile();
    await mod.init();
    prisma = mod.get(PrismaService);
    svc = mod.get(CustomEmojiService);
    prefs = mod.get(EmojiPreferenceService);
  }, 180_000);

  afterAll(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await pg.stop().catch(() => undefined);
  });

  beforeEach(() => {
    outboxEvents = [];
  });

  async function seed(): Promise<{ wsId: string; userId: string }> {
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@t.local`,
        username: `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        passwordHash: 'x',
      },
    });
    const ws = await prisma.workspace.create({
      data: {
        id: randomUUID(),
        name: 'W',
        slug: `ws-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        ownerId: user.id,
      },
    });
    return { wsId: ws.id, userId: user.id };
  }

  async function seedEmoji(wsId: string, userId: string, name: string): Promise<string> {
    const id = randomUUID();
    await prisma.customEmoji.create({
      data: {
        id,
        workspaceId: wsId,
        name,
        createdBy: userId,
        storageKey: `k-${id}`,
        mime: 'image/png',
        sizeBytes: BigInt(8),
      },
    });
    return id;
  }

  it('migration: the three S42 tables exist', async () => {
    const rows = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('CustomEmojiAlias', 'UserEmojiPreference', 'WorkspaceEmojiConfig')
       ORDER BY table_name
    `;
    expect(rows.map((r) => r.table_name)).toEqual([
      'CustomEmojiAlias',
      'UserEmojiPreference',
      'WorkspaceEmojiConfig',
    ]);
  }, 60_000);

  it('FR-EM05: addAlias adds + list reflects + outbox emoji.alias_updated', async () => {
    const { wsId, userId } = await seed();
    const emojiId = await seedEmoji(wsId, userId, 'parrot');
    const res = await svc.addAlias(wsId, emojiId, 'birb', userId);
    expect(res.aliases).toEqual(['birb']);
    expect(outboxEvents.map((e) => e.eventType)).toContain('emoji.alias_updated');
    const items = await svc.list(wsId);
    const item = items.find((i) => i.id === emojiId);
    expect(item?.aliases).toEqual(['birb']);
  }, 60_000);

  it('FR-EM05: alias 10-cap → 409 ALIAS_LIMIT', async () => {
    const { wsId, userId } = await seed();
    const emojiId = await seedEmoji(wsId, userId, 'capped');
    for (let i = 0; i < CUSTOM_EMOJI_ALIAS_CAP; i++) {
      await svc.addAlias(wsId, emojiId, `al_${i.toString().padStart(2, '0')}`, userId);
    }
    await expect(svc.addAlias(wsId, emojiId, 'one_too_many', userId)).rejects.toMatchObject({
      code: ErrorCode.ALIAS_LIMIT,
    });
  }, 60_000);

  it('FR-EM05: alias colliding with another emoji name → 409 ALIAS_CONFLICT', async () => {
    const { wsId, userId } = await seed();
    await seedEmoji(wsId, userId, 'taken_name');
    const emojiId = await seedEmoji(wsId, userId, 'other');
    await expect(svc.addAlias(wsId, emojiId, 'taken_name', userId)).rejects.toMatchObject({
      code: ErrorCode.ALIAS_CONFLICT,
    });
  }, 60_000);

  it('FR-EM05: alias colliding with an existing alias → 409 ALIAS_CONFLICT', async () => {
    const { wsId, userId } = await seed();
    const e1 = await seedEmoji(wsId, userId, 'first');
    const e2 = await seedEmoji(wsId, userId, 'second');
    await svc.addAlias(wsId, e1, 'shared', userId);
    await expect(svc.addAlias(wsId, e2, 'shared', userId)).rejects.toMatchObject({
      code: ErrorCode.ALIAS_CONFLICT,
    });
  }, 60_000);

  it('FR-EM05: concurrent same-alias race — exactly one wins, other 409', async () => {
    const { wsId, userId } = await seed();
    const e1 = await seedEmoji(wsId, userId, 'race1');
    const e2 = await seedEmoji(wsId, userId, 'race2');
    const results = await Promise.allSettled([
      svc.addAlias(wsId, e1, 'contested', userId),
      svc.addAlias(wsId, e2, 'contested', userId),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: ErrorCode.ALIAS_CONFLICT });
    const count = await prisma.customEmojiAlias.count({
      where: { workspaceId: wsId, alias: 'contested' },
    });
    expect(count).toBe(1);
  }, 60_000);

  it('FR-EM05: removeAlias — creator ok, foreign MEMBER 403, admin ok', async () => {
    const { wsId, userId } = await seed();
    const emojiId = await seedEmoji(wsId, userId, 'deltest');
    await svc.addAlias(wsId, emojiId, 'a1', userId);
    await svc.addAlias(wsId, emojiId, 'a2', userId);

    const otherId = randomUUID();
    // Foreign MEMBER cannot remove a creator's alias.
    await expect(svc.removeAlias(wsId, emojiId, 'a1', otherId, 'MEMBER')).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
    // Creator removes own alias.
    await expect(svc.removeAlias(wsId, emojiId, 'a1', userId, 'MEMBER')).resolves.toBeUndefined();
    // Admin removes remaining alias even though not the creator.
    await expect(svc.removeAlias(wsId, emojiId, 'a2', otherId, 'ADMIN')).resolves.toBeUndefined();
    const remaining = await prisma.customEmojiAlias.count({ where: { customEmojiId: emojiId } });
    expect(remaining).toBe(0);
  }, 60_000);

  it('FR-EM05: CustomEmoji delete cascades its aliases', async () => {
    const { wsId, userId } = await seed();
    const emojiId = await seedEmoji(wsId, userId, 'cascade');
    await svc.addAlias(wsId, emojiId, 'gone_too', userId);
    await prisma.customEmoji.delete({ where: { id: emojiId } });
    const aliasCount = await prisma.customEmojiAlias.count({ where: { customEmojiId: emojiId } });
    expect(aliasCount).toBe(0);
  }, 60_000);

  it('FR-PK04: canMemberUpload false (no row) → MEMBER presign 403; true → 200', async () => {
    const { wsId, userId } = await seed();
    // No config row → default false → MEMBER blocked.
    await expect(
      svc.presignUpload({
        workspaceId: wsId,
        uploaderId: userId,
        uploaderRole: 'MEMBER',
        name: 'mem_one',
        mime: 'image/png',
        sizeBytes: 8,
        filename: 'a.png',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });

    // Flip canMemberUpload = true via the config upsert.
    await prefs.updateWorkspaceConfig(wsId, { canMemberUpload: true });
    const presign = await svc.presignUpload({
      workspaceId: wsId,
      uploaderId: userId,
      uploaderRole: 'MEMBER',
      name: 'mem_two',
      mime: 'image/png',
      sizeBytes: 8,
      filename: 'b.png',
    });
    expect(presign.emojiId).toBeTruthy();
  }, 60_000);

  it('FR-PK04: ADMIN can always presign regardless of config', async () => {
    const { wsId, userId } = await seed();
    const presign = await svc.presignUpload({
      workspaceId: wsId,
      uploaderId: userId,
      uploaderRole: 'ADMIN',
      name: 'admin_up',
      mime: 'image/png',
      sizeBytes: 8,
      filename: 'a.png',
    });
    expect(presign.emojiId).toBeTruthy();
  }, 60_000);

  it('FR-PK03: user-preference upsert is idempotent on userId', async () => {
    const { userId } = await seed();
    const first = await prefs.updateUserPreference(userId, {
      defaultSkinTone: 3,
      quickReactions: ['🎉', '🔥'],
    });
    expect(first.defaultSkinTone).toBe(3);
    expect(first.quickReactions).toEqual(['🎉', '🔥']);
    // recentEmojis defaulted by the schema.
    expect(first.recentEmojis).toEqual([]);

    const second = await prefs.updateUserPreference(userId, { recentEmojis: ['👍', '😀'] });
    expect(second.recentEmojis).toEqual(['👍', '😀']);
    // Prior skinTone preserved (partial update).
    expect(second.defaultSkinTone).toBe(3);

    const rows = await prisma.userEmojiPreference.count({ where: { userId } });
    expect(rows).toBe(1);
  }, 60_000);

  it('FR-PK01: picker-data returns defaults when no rows exist', async () => {
    const { wsId, userId } = await seed();
    await seedEmoji(wsId, userId, 'pickme');
    const data = await prefs.getPickerData(wsId, userId);
    expect(data.workspaceQuickReactions).toEqual(['👍', '❤️', '😂']);
    expect(data.userQuickReactions).toBeNull();
    expect(data.recentEmojis).toEqual([]);
    expect(data.defaultSkinTone).toBe(1);
    expect(data.customEmojis.map((e) => e.name)).toContain('pickme');
    // No rows were created by the read.
    expect(await prisma.workspaceEmojiConfig.count({ where: { workspaceId: wsId } })).toBe(0);
    expect(await prisma.userEmojiPreference.count({ where: { userId } })).toBe(0);
  }, 60_000);

  it('FR-PK01: picker-data merges workspace + user preferences when present', async () => {
    const { wsId, userId } = await seed();
    await prefs.updateWorkspaceConfig(wsId, { quickReactions: ['🚀', '🎯', '✅'] });
    await prefs.updateUserPreference(userId, {
      quickReactions: ['😎', '🤝'],
      recentEmojis: ['🔥'],
      defaultSkinTone: 4,
    });
    const data = await prefs.getPickerData(wsId, userId);
    expect(data.workspaceQuickReactions).toEqual(['🚀', '🎯', '✅']);
    expect(data.userQuickReactions).toEqual(['😎', '🤝']);
    expect(data.recentEmojis).toEqual(['🔥']);
    expect(data.defaultSkinTone).toBe(4);
  }, 60_000);
});
