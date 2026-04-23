import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AttachmentsService } from '../../../src/attachments/attachments.service';
import { PrismaService, PrismaModule } from '../../../src/prisma/prisma.module';
import { S3Service } from '../../../src/storage/s3.service';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';

/**
 * task-038-B int spec: magic-byte validation on AttachmentsService
 * .finalize(). Real Postgres + mocked S3Service so we can feed
 * arbitrary bytes into getObjectRange and assert the mismatch path.
 */
describe('Attachment.finalize magic-byte validation (int)', () => {
  let pg: StartedTestContainer;
  let prisma: PrismaService;
  let svc: AttachmentsService;
  let deleteCalls: string[];
  let s3Stub: {
    headObject: (key: string) => Promise<{ contentLength: number; contentType: undefined }>;
    getObjectRange: (key: string, end: number) => Promise<Uint8Array>;
    deleteObject: (key: string) => Promise<void>;
    presignPut: () => Promise<string>;
    presignGet: () => Promise<string>;
    buildKey: (
      workspaceId: string | null,
      channelId: string,
      attachmentId: string,
      originalName: string,
    ) => string;
    maxBytes: number;
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
        POSTGRES_DB: 'qufox_att_int',
      })
      .withExposedPorts(5432)
      .start();
    const url = `postgresql://qufox:qufox@${pg.getHost()}:${pg.getMappedPort(5432)}/qufox_att_int?schema=public`;
    process.env.DATABASE_URL = url;
    const apiRoot = path.resolve(__dirname, '../../..');
    execSync('pnpm exec prisma migrate deploy', {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    });

    s3Stub = {
      mockBytes: new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]), // "hello"
      mockSize: 5,
      headObject: async () => ({ contentLength: s3Stub.mockSize, contentType: undefined }),
      getObjectRange: async () => s3Stub.mockBytes,
      deleteObject: async (key: string) => {
        deleteCalls.push(key);
      },
      presignPut: async () => 'http://stub',
      presignGet: async () => 'http://stub',
      buildKey: (_ws, ch, id, name) => `k/${ch}/${id}/${name}`,
      maxBytes: 100 * 1024 * 1024,
      presignPutTtl: 900,
      presignGetTtl: 1800,
    };
    deleteCalls = [];

    const mod = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [AttachmentsService, { provide: S3Service, useValue: s3Stub }],
    }).compile();
    await mod.init();
    prisma = mod.get(PrismaService);
    svc = mod.get(AttachmentsService);
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await pg.stop().catch(() => undefined);
  });

  async function seed(): Promise<{ userId: string; channelId: string }> {
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@t.local`,
        username: `att${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        passwordHash: 'x',
      },
    });
    const ws = await prisma.workspace.create({
      data: {
        id: randomUUID(),
        name: 'AttW',
        slug: `aw-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        ownerId: user.id,
      },
    });
    const ch = await prisma.channel.create({
      data: {
        id: randomUUID(),
        workspaceId: ws.id,
        name: 'attach',
        type: 'TEXT',
        isPrivate: false,
        position: 0,
      },
    });
    return { userId: user.id, channelId: ch.id };
  }

  it('rejects when JPEG mime is declared but the bytes are plain text', async () => {
    const { userId, channelId } = await seed();
    s3Stub.mockBytes = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]); // "hello"
    s3Stub.mockSize = 5;

    const presign = await svc.presignUpload({
      clientAttachmentId: randomUUID(),
      channelId,
      workspaceId: null,
      uploaderId: userId,
      mime: 'image/jpeg',
      sizeBytes: 5,
      originalName: 'liar.jpg',
    });

    await expect(svc.finalize(presign.attachmentId, userId)).rejects.toMatchObject({
      code: ErrorCode.INVALID_MAGIC_BYTES,
    });

    const row = await prisma.attachment.findUnique({ where: { id: presign.attachmentId } });
    expect(row).toBeNull();
    expect(deleteCalls).toContain(presign.key);
  }, 60_000);

  it('accepts real JPEG header for JPEG mime', async () => {
    const { userId, channelId } = await seed();
    s3Stub.mockBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    s3Stub.mockSize = 6;

    const presign = await svc.presignUpload({
      clientAttachmentId: randomUUID(),
      channelId,
      workspaceId: null,
      uploaderId: userId,
      mime: 'image/jpeg',
      sizeBytes: 6,
      originalName: 'real.jpg',
    });
    await expect(svc.finalize(presign.attachmentId, userId)).resolves.toBeUndefined();

    const row = await prisma.attachment.findUnique({ where: { id: presign.attachmentId } });
    expect(row?.finalizedAt).not.toBeNull();
  }, 60_000);

  it('skips magic-byte check for non-image mimes (application/pdf)', async () => {
    const { userId, channelId } = await seed();
    s3Stub.mockBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF" — unchecked
    s3Stub.mockSize = 4;

    const presign = await svc.presignUpload({
      clientAttachmentId: randomUUID(),
      channelId,
      workspaceId: null,
      uploaderId: userId,
      mime: 'application/pdf',
      sizeBytes: 4,
      originalName: 'doc.pdf',
    });
    await expect(svc.finalize(presign.attachmentId, userId)).resolves.toBeUndefined();
  }, 60_000);
});
