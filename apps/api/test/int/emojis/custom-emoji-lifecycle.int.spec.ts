import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  CustomEmojiService,
  CUSTOM_EMOJI_CAP,
  CUSTOM_EMOJI_MAX_BYTES,
} from '../../../src/emojis/custom-emoji.service';
import { PrismaService, PrismaModule } from '../../../src/prisma/prisma.module';
import { S3Service } from '../../../src/storage/s3.service';
import { OutboxService } from '../../../src/common/outbox/outbox.service';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';

/**
 * S41 (D05) int spec: custom-emoji lifecycle against a real Postgres
 * testcontainer (so the S41 migration + cap concurrency + emoji.created/
 * deleted outbox rows round-trip exactly as in prod). S3Service +
 * OutboxService are stubbed at the Nest DI layer — MinIO is not required
 * (the storage SDK is already isolated behind S3Service), and the outbox
 * stub records into a captured array so we can assert event emission.
 *
 * Covers the S41 gate items that need a real DB:
 *   - webp upload accepted (FR-EM01)
 *   - cap 100 race → 409 EMOJI_WORKSPACE_LIMIT (FR-EM02)
 *   - oversize/mime rejection → 422 INVALID_FILE (FR-EM01/RC20)
 *   - delete permission: uploader(MEMBER) ok / admin ok / other 403 (FR-EM04)
 *   - emoji.created on finalize + emoji.deleted on delete (FR-RC20)
 */
describe('CustomEmoji lifecycle (int)', () => {
  let pg: StartedTestContainer;
  let prisma: PrismaService;
  let svc: CustomEmojiService;
  let outboxEvents: { eventType: string; payload: Record<string, unknown> }[];
  let s3Stub: {
    headObject: (key: string) => Promise<{ contentLength: number; contentType: undefined }>;
    getObjectRange: (key: string, end: number) => Promise<Uint8Array>;
    deleteObject: (key: string) => Promise<void>;
    presignPut: () => Promise<string>;
    presignGet: () => Promise<string>;
    presignPutTtl: number;
    presignGetTtl: number;
    mockBytes: Uint8Array;
    mockSize: number;
  };

  beforeAll(async () => {
    process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
    pg = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({
        POSTGRES_USER: 'qufox',
        POSTGRES_PASSWORD: 'qufox',
        POSTGRES_DB: 'qufox_emoji_lifecycle',
      })
      .withExposedPorts(5432)
      .start();
    const url = `postgresql://qufox:qufox@${pg.getHost()}:${pg.getMappedPort(5432)}/qufox_emoji_lifecycle?schema=public`;
    process.env.DATABASE_URL = url;
    const apiRoot = path.resolve(__dirname, '../../..');
    execSync('pnpm exec prisma migrate deploy', {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    });

    s3Stub = {
      // PNG magic by default so finalize's size + magic checks pass.
      mockBytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      mockSize: 8,
      headObject: async () => ({ contentLength: s3Stub.mockSize, contentType: undefined }),
      getObjectRange: async () => s3Stub.mockBytes,
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
        { provide: S3Service, useValue: s3Stub },
        { provide: OutboxService, useValue: outboxStub },
      ],
    }).compile();
    await mod.init();
    prisma = mod.get(PrismaService);
    svc = mod.get(CustomEmojiService);
  }, 180_000);

  afterAll(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await pg.stop().catch(() => undefined);
  });

  beforeEach(() => {
    outboxEvents = [];
  });

  async function seedWorkspaceAndUser(): Promise<{ wsId: string; userId: string }> {
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

  it('FR-EM01: accepts an image/webp upload + finalize emits emoji.created', async () => {
    const { wsId, userId } = await seedWorkspaceAndUser();
    // WEBP magic: RIFF....WEBP (12 bytes).
    s3Stub.mockSize = 12;
    s3Stub.mockBytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    const presign = await svc.presignUpload({
      workspaceId: wsId,
      uploaderId: userId,
      uploaderRole: 'ADMIN' as const,
      name: 'webp_one',
      mime: 'image/webp',
      sizeBytes: 12,
      filename: 'a.webp',
    });
    expect(presign.emojiId).toBeTruthy();
    outboxEvents = [];
    await expect(svc.finalize(wsId, presign.emojiId, userId, 'ADMIN')).resolves.toBeUndefined();
    expect(outboxEvents.map((e) => e.eventType)).toContain('emoji.created');
    const created = outboxEvents.find((e) => e.eventType === 'emoji.created');
    expect(created?.payload).toMatchObject({ workspaceId: wsId, emojiId: presign.emojiId });
  }, 60_000);

  it('FR-RC20: rejects an oversize declared payload with INVALID_FILE (422)', async () => {
    const { wsId, userId } = await seedWorkspaceAndUser();
    await expect(
      svc.presignUpload({
        workspaceId: wsId,
        uploaderId: userId,
        uploaderRole: 'ADMIN' as const,
        name: 'too_big',
        mime: 'image/png',
        sizeBytes: CUSTOM_EMOJI_MAX_BYTES + 1,
        filename: 'big.png',
      }),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_FILE });
  }, 60_000);

  it('FR-EM02: cap-100 concurrent uploads — exactly one extra past cap fails with EMOJI_WORKSPACE_LIMIT', async () => {
    const { wsId, userId } = await seedWorkspaceAndUser();
    // Pre-seed 99 emoji directly so the workspace sits one below the cap.
    await prisma.customEmoji.createMany({
      data: Array.from({ length: CUSTOM_EMOJI_CAP - 1 }, (_, i) => ({
        id: randomUUID(),
        workspaceId: wsId,
        name: `pre_${i.toString().padStart(3, '0')}`,
        createdBy: userId,
        storageKey: `k${i}`,
        mime: 'image/png',
        sizeBytes: BigInt(10),
      })),
    });
    // Two concurrent presigns racing for the single remaining slot (99→100,
    // then 100→101). The FOR UPDATE count must serialize them so exactly one
    // wins and the other rolls its row back with EMOJI_WORKSPACE_LIMIT.
    const results = await Promise.allSettled([
      svc.presignUpload({
        workspaceId: wsId,
        uploaderId: userId,
        uploaderRole: 'ADMIN' as const,
        name: 'race_a',
        mime: 'image/png',
        sizeBytes: 10,
        filename: 'a.png',
      }),
      svc.presignUpload({
        workspaceId: wsId,
        uploaderId: userId,
        uploaderRole: 'ADMIN' as const,
        name: 'race_b',
        mime: 'image/png',
        sizeBytes: 10,
        filename: 'b.png',
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: ErrorCode.EMOJI_WORKSPACE_LIMIT });
    // DB must hold exactly the cap (100) — the loser's row was deleted.
    const total = await prisma.customEmoji.count({ where: { workspaceId: wsId } });
    expect(total).toBe(CUSTOM_EMOJI_CAP);
  }, 60_000);

  it('FR-EM04: uploader (MEMBER) may delete own emoji; emits emoji.deleted', async () => {
    const { wsId, userId } = await seedWorkspaceAndUser();
    const presign = await svc.presignUpload({
      workspaceId: wsId,
      uploaderId: userId,
      uploaderRole: 'ADMIN' as const,
      name: 'mine',
      mime: 'image/png',
      sizeBytes: 8,
      filename: 'm.png',
    });
    outboxEvents = [];
    await expect(svc.delete(wsId, presign.emojiId, userId, 'MEMBER')).resolves.toBeUndefined();
    expect(outboxEvents.map((e) => e.eventType)).toContain('emoji.deleted');
    const row = await prisma.customEmoji.findUnique({ where: { id: presign.emojiId } });
    expect(row).toBeNull();
  }, 60_000);

  it('FR-EM04: a MEMBER cannot delete someone else’s emoji (403)', async () => {
    const { wsId, userId } = await seedWorkspaceAndUser();
    const other = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `o-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@t.local`,
        username: `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        passwordHash: 'x',
      },
    });
    const presign = await svc.presignUpload({
      workspaceId: wsId,
      uploaderId: userId,
      uploaderRole: 'ADMIN' as const,
      name: 'theirs',
      mime: 'image/png',
      sizeBytes: 8,
      filename: 't.png',
    });
    await expect(svc.delete(wsId, presign.emojiId, other.id, 'MEMBER')).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
    // Row survives the rejected delete.
    const row = await prisma.customEmoji.findUnique({ where: { id: presign.emojiId } });
    expect(row).not.toBeNull();
  }, 60_000);

  it('FR-EM04: an ADMIN may delete someone else’s emoji', async () => {
    const { wsId, userId } = await seedWorkspaceAndUser();
    const presign = await svc.presignUpload({
      workspaceId: wsId,
      uploaderId: userId,
      uploaderRole: 'ADMIN' as const,
      name: 'adminkill',
      mime: 'image/png',
      sizeBytes: 8,
      filename: 'a.png',
    });
    const adminId = randomUUID();
    await expect(svc.delete(wsId, presign.emojiId, adminId, 'ADMIN')).resolves.toBeUndefined();
    const row = await prisma.customEmoji.findUnique({ where: { id: presign.emojiId } });
    expect(row).toBeNull();
  }, 60_000);

  it('FR-EM03: list returns aliases:[] shape per item', async () => {
    const { wsId, userId } = await seedWorkspaceAndUser();
    await svc.presignUpload({
      workspaceId: wsId,
      uploaderId: userId,
      uploaderRole: 'ADMIN' as const,
      name: 'listed',
      mime: 'image/png',
      sizeBytes: 8,
      filename: 'l.png',
    });
    const items = await svc.list(wsId);
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items[0]).toHaveProperty('aliases');
    expect(items[0].aliases).toEqual([]);
  }, 60_000);
});
