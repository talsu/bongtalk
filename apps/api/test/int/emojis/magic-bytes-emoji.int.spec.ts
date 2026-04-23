import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CustomEmojiService } from '../../../src/emojis/custom-emoji.service';
import { PrismaService, PrismaModule } from '../../../src/prisma/prisma.module';
import { S3Service } from '../../../src/storage/s3.service';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';

/**
 * task-038-B int spec: magic-byte validation on CustomEmoji.finalize.
 *
 * Shape: real Postgres testcontainer (so the Prisma row round-trips
 * exactly as in prod), S3Service mocked at the Nest DI layer so the
 * test can feed arbitrary bytes into `getObjectRange`. No MinIO
 * container is required — the storage SDK is already isolated behind
 * S3Service, so stubbing it is the correct integration surface.
 */
describe('CustomEmoji.finalize magic-byte validation (int)', () => {
  let pg: StartedTestContainer;
  let prisma: PrismaService;
  let svc: CustomEmojiService;
  let deleteCalls: string[];
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
        POSTGRES_DB: 'qufox_emoji_int',
      })
      .withExposedPorts(5432)
      .start();
    const url = `postgresql://qufox:qufox@${pg.getHost()}:${pg.getMappedPort(5432)}/qufox_emoji_int?schema=public`;
    process.env.DATABASE_URL = url;
    const apiRoot = path.resolve(__dirname, '../../..');
    execSync('pnpm exec prisma migrate deploy', {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    });

    s3Stub = {
      mockBytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      mockSize: 8,
      headObject: async () => ({
        contentLength: s3Stub.mockSize,
        contentType: undefined,
      }),
      getObjectRange: async () => s3Stub.mockBytes,
      deleteObject: async (key: string) => {
        deleteCalls.push(key);
      },
      presignPut: async () => 'http://stub',
      presignGet: async () => 'http://stub',
      presignPutTtl: 900,
      presignGetTtl: 1800,
    };
    deleteCalls = [];

    const mod = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [CustomEmojiService, { provide: S3Service, useValue: s3Stub }],
    }).compile();
    await mod.init();
    prisma = mod.get(PrismaService);
    svc = mod.get(CustomEmojiService);
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await pg.stop().catch(() => undefined);
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

  it('rejects when PNG bytes declared as GIF; deletes object + row', async () => {
    const { wsId, userId } = await seedWorkspaceAndUser();

    // Reserve the row via the real presignUpload flow. MIME declared
    // is image/gif, size small. The service writes a CustomEmoji row
    // with mime='image/gif'.
    s3Stub.mockSize = 8; // match the mockBytes length below so HEAD passes
    s3Stub.mockBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const presign = await svc.presignUpload({
      workspaceId: wsId,
      uploaderId: userId,
      name: 'gif_lie',
      mime: 'image/gif',
      sizeBytes: 8,
      filename: 'a.gif',
    });
    expect(presign.emojiId).toBeTruthy();

    await expect(svc.finalize(wsId, presign.emojiId, userId)).rejects.toMatchObject({
      code: ErrorCode.INVALID_MAGIC_BYTES,
    });

    // Row removed + S3 delete called with the same key.
    const row = await prisma.customEmoji.findUnique({ where: { id: presign.emojiId } });
    expect(row).toBeNull();
    expect(deleteCalls).toContain(presign.storageKey);
  }, 60_000);

  it('accepts PNG bytes for declared PNG mime', async () => {
    const { wsId, userId } = await seedWorkspaceAndUser();
    s3Stub.mockSize = 8;
    s3Stub.mockBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const presign = await svc.presignUpload({
      workspaceId: wsId,
      uploaderId: userId,
      name: 'valid_png',
      mime: 'image/png',
      sizeBytes: 8,
      filename: 'a.png',
    });
    await expect(svc.finalize(wsId, presign.emojiId, userId)).resolves.toBeUndefined();

    const row = await prisma.customEmoji.findUnique({ where: { id: presign.emojiId } });
    expect(row).not.toBeNull();
  }, 60_000);
});
