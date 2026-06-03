import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import Redis from 'ioredis';
import { execSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaService, PrismaModule } from '../../../src/prisma/prisma.module';
import { S3Service } from '../../../src/storage/s3.service';
import { REDIS } from '../../../src/redis/redis.module';
import { AttachmentUploadService } from '../../../src/attachments/attachment-upload.service';
import { AttachmentsService } from '../../../src/attachments/attachments.service';
import { AttachmentGcService } from '../../../src/attachments/attachment-gc.service';
import { AttachmentProxyController } from '../../../src/attachments/attachment-proxy.controller';
import { UploadRateLimitService } from '../../../src/attachments/upload-rate-limit.service';
import { ChannelAccessByIdGuard } from '../../../src/attachments/guards/channel-access-by-id.guard';
import { ChannelAccessService } from '../../../src/channels/permission/channel-access.service';
import { WorkspacesService } from '../../../src/workspaces/workspaces.service';
import { OutboxService } from '../../../src/common/outbox/outbox.service';
// S63 fix-forward (G · S62 fallout): ChannelAccessService 는 non-Optional AuditService 에,
// WorkspacesService 는 MemberRoleService(S62) + ModerationService(S63 A-1)에 의존하므로
// standalone test module 에도 직접 등록한다(@Global AuditModule 은 AppModule 경유 시만 자동).
import { AuditService } from '../../../src/common/audit/audit.service';
import { MemberRoleService } from '../../../src/workspaces/roles/member-role.service';
import { ModerationService } from '../../../src/workspaces/moderation/moderation.service';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';

/**
 * S55 (D11) int spec — orphan GC + download/thumbnail 프록시 + 업로드 정책 + admin
 * 설정 PATCH.
 *
 * Shape: 실 Postgres(testcontainer) + 실 Redis(testcontainer) + S3Service 스텁(S54
 * 패턴 — 스토리지 SDK 는 S3Service 뒤로 격리, MinIO 컨테이너 불요). 프록시 컨트롤러는
 * 직접 인스턴스화하고 fake Express Response 로 302/스트리밍/헤더를 검증한다(전체 HTTP
 * 서버 부팅 회피). 전체 test:int 의 invites-rate-limit Redis hang 회피 위해 단독 파일.
 *
 * 모든 테스트는 vi.setSystemTime('2025-01-01T00:00:00Z'). BullMQ 실타이머는 쓰지
 * 않는다(GC 는 AttachmentGcService.sweep(now) 를 직접 호출 — repeatable 스케줄은
 * processor 단위에서 별도).
 */
describe('S55 attachment policy + GC + proxy (int)', () => {
  let pg: StartedTestContainer;
  let redisC: StartedTestContainer;
  let redis: Redis;
  let prisma: PrismaService;
  let uploads: AttachmentUploadService;
  let attachments: AttachmentsService;
  let gc: AttachmentGcService;
  let proxy: AttachmentProxyController;
  let workspaces: WorkspacesService;

  // S3 스텁 상태(케이스별 교체).
  const s3State = {
    bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG
    size: 8,
    deleted: [] as string[],
    streamBody: Buffer.from('private-bytes'),
    lastPresignAttachment: undefined as boolean | undefined,
    lastPresignExpiresIn: undefined as number | undefined,
  };
  const s3Stub = {
    maxBytes: 100 * 1024 * 1024,
    presignPutTtl: 900,
    presignGetTtl: 1800,
    buildKey: (ws: string | null, ch: string, id: string, name: string) =>
      `${ws ?? '__dm__'}/${ch}/${id}/${name}`,
    presignPost: async (key: string) => ({ url: 'http://minio.local/bucket', fields: { key } }),
    presignPut: async () => 'http://minio.local/put',
    presignGet: async (_key: string, opts?: { attachment?: boolean; expiresIn?: number }) => {
      s3State.lastPresignAttachment = opts?.attachment;
      s3State.lastPresignExpiresIn = opts?.expiresIn;
      return `http://minio.local/signed?disp=${opts?.attachment ? 'att' : 'inline'}`;
    },
    headObject: async () => ({ contentLength: s3State.size, contentType: undefined }),
    getObjectRange: async () => s3State.bytes,
    getObjectStream: async () => ({
      stream: Readable.from([s3State.streamBody]) as unknown as NodeJS.ReadableStream,
      contentType: 'image/png',
      contentLength: s3State.streamBody.byteLength,
    }),
    deleteObject: async (key: string) => {
      s3State.deleted.push(key);
    },
  };

  beforeAll(async () => {
    process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
    pg = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({
        POSTGRES_USER: 'qufox',
        POSTGRES_PASSWORD: 'qufox',
        POSTGRES_DB: 'qufox_s55_int',
      })
      .withExposedPorts(5432)
      .start();
    const url = `postgresql://qufox:qufox@${pg.getHost()}:${pg.getMappedPort(5432)}/qufox_s55_int?schema=public`;
    process.env.DATABASE_URL = url;
    const apiRoot = path.resolve(__dirname, '../../..');
    execSync('pnpm exec prisma migrate deploy', {
      cwd: apiRoot,
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    });

    redisC = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();
    redis = new Redis({ host: redisC.getHost(), port: redisC.getMappedPort(6379) });

    const mod = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [
        AttachmentUploadService,
        AttachmentsService,
        AttachmentGcService,
        UploadRateLimitService,
        ChannelAccessByIdGuard,
        ChannelAccessService,
        AuditService,
        MemberRoleService,
        ModerationService,
        WorkspacesService,
        { provide: S3Service, useValue: s3Stub },
        { provide: REDIS, useValue: redis },
        // getSetting/updateSetting 는 outbox 를 쓰지 않으므로 no-op 스텁으로 충분.
        { provide: OutboxService, useValue: { record: async () => undefined } },
      ],
    }).compile();
    await mod.init();
    prisma = mod.get(PrismaService);
    uploads = mod.get(AttachmentUploadService);
    attachments = mod.get(AttachmentsService);
    gc = mod.get(AttachmentGcService);
    workspaces = mod.get(WorkspacesService);
    proxy = new AttachmentProxyController(
      attachments,
      mod.get(ChannelAccessByIdGuard),
      s3Stub as unknown as S3Service,
    );
  }, 240_000);

  afterAll(async () => {
    await redis?.quit().catch(() => undefined);
    await prisma?.$disconnect().catch(() => undefined);
    await redisC?.stop().catch(() => undefined);
    await pg?.stop().catch(() => undefined);
  });

  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    s3State.deleted = [];
    s3State.bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    s3State.size = 8;
    s3State.lastPresignAttachment = undefined;
    s3State.lastPresignExpiresIn = undefined;
  });

  const now = () => new Date('2025-01-01T00:00:00Z');

  let seedCounter = 0;
  async function seed(opts?: {
    isPrivate?: boolean;
    fileUploadEnabled?: boolean;
    channelMaxBytes?: number | null;
  }): Promise<{ userId: string; channelId: string; workspaceId: string }> {
    seedCounter += 1;
    const tag = `${Date.now().toString(36)}${seedCounter}`;
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `s55-${tag}@t.local`,
        username: `s55u${tag}`.slice(0, 30),
        passwordHash: 'x',
      },
    });
    const ws = await prisma.workspace.create({
      data: { id: randomUUID(), name: 'S55W', slug: `s55-${tag}`.slice(0, 30), ownerId: user.id },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId: ws.id, userId: user.id, role: 'OWNER' },
    });
    const ch = await prisma.channel.create({
      data: {
        id: randomUUID(),
        workspaceId: ws.id,
        name: `c${tag}`.slice(0, 30),
        type: 'TEXT',
        isPrivate: opts?.isPrivate ?? false,
        position: 0,
        fileUploadEnabled: opts?.fileUploadEnabled ?? true,
        maxFileSizeBytes:
          opts?.channelMaxBytes === undefined || opts.channelMaxBytes === null
            ? null
            : BigInt(opts.channelMaxBytes),
      },
    });
    return { userId: user.id, channelId: ch.id, workspaceId: ws.id };
  }

  // ── 정책 게이트: fileUploadEnabled=false → 403 ─────────────────────────────
  it('FR-CH-18: upload-url is forbidden when channel.fileUploadEnabled=false', async () => {
    const { userId, channelId } = await seed({ fileUploadEnabled: false });
    await uploads['rateLimit'].reset(userId);
    await expect(
      uploads.createUploadUrl(
        userId,
        channelId,
        { filename: 'a.png', size: 8, mimeType: 'image/png', count: 1 },
        now(),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.FILE_UPLOAD_DISABLED });
  }, 30_000);

  // ── 정책: 워크스페이스 maxFileSizeBytes 상한 적용 ─────────────────────────
  it('FR-AM-20: workspace maxFileSizeBytes caps the upload (ATTACHMENT_TOO_LARGE)', async () => {
    const { userId, channelId, workspaceId } = await seed();
    await uploads['rateLimit'].reset(userId);
    await workspaces.updateSetting(workspaceId, { maxFileSizeBytes: 1000 });
    await expect(
      uploads.createUploadUrl(
        userId,
        channelId,
        { filename: 'big.png', size: 5000, mimeType: 'image/png', count: 1 },
        now(),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.ATTACHMENT_TOO_LARGE });
    // under the cap succeeds
    const ok = await uploads.createUploadUrl(
      userId,
      channelId,
      { filename: 'small.png', size: 500, mimeType: 'image/png', count: 1 },
      now(),
    );
    expect(ok.sessions).toHaveLength(1);
  }, 30_000);

  // ── 정책: 채널 maxFileSizeBytes 가 워크스페이스보다 우선 ──────────────────
  it('FR-AM-20: channel maxFileSizeBytes takes precedence over workspace', async () => {
    const { userId, channelId, workspaceId } = await seed({ channelMaxBytes: 200 });
    await uploads['rateLimit'].reset(userId);
    await workspaces.updateSetting(workspaceId, { maxFileSizeBytes: 100_000 });
    // 150 < ws(100k) but > channel(200) → rejected by channel override
    await expect(
      uploads.createUploadUrl(
        userId,
        channelId,
        { filename: 'm.png', size: 150, mimeType: 'image/png', count: 1 },
        now(),
      ),
    ).resolves.toBeTruthy();
    await expect(
      uploads.createUploadUrl(
        userId,
        channelId,
        { filename: 'm2.png', size: 250, mimeType: 'image/png', count: 1 },
        now(),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.ATTACHMENT_TOO_LARGE });
  }, 30_000);

  // ── 정책: 워크스페이스 blockedExtensions 추가 차단 ────────────────────────
  it('FR-AM-20: workspace blockedExtensions blocks an otherwise-allowed extension', async () => {
    const { userId, channelId, workspaceId } = await seed();
    await uploads['rateLimit'].reset(userId);
    // png is allowed globally; block it at the workspace level.
    await workspaces.updateSetting(workspaceId, { blockedExtensions: ['png'] });
    await expect(
      uploads.createUploadUrl(
        userId,
        channelId,
        { filename: 'blocked.png', size: 8, mimeType: 'image/png', count: 1 },
        now(),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.ATTACHMENT_EXTENSION_BLOCKED });
  }, 30_000);

  // ── admin 설정: WorkspaceSetting upsert round-trip ────────────────────────
  it('FR-AM-20: updateSetting upserts + getSetting reads back', async () => {
    const { workspaceId } = await seed();
    const initial = await workspaces.getSetting(workspaceId);
    expect(initial.maxFileSizeBytes).toBeNull();
    expect(initial.blockedExtensions).toEqual([]);
    const updated = await workspaces.updateSetting(workspaceId, {
      maxFileSizeBytes: 5000,
      blockedExtensions: ['ISO', 'bin'],
    });
    expect(updated.maxFileSizeBytes).toBe(5000);
    expect(updated.blockedExtensions).toEqual(['iso', 'bin']);
    // partial update preserves the other field
    const partial = await workspaces.updateSetting(workspaceId, { maxFileSizeBytes: null });
    expect(partial.maxFileSizeBytes).toBeNull();
    expect(partial.blockedExtensions).toEqual(['iso', 'bin']);
  }, 30_000);

  // ── linkedAt 정합: pre-link(targetChannelId) → linkedAt=null ──────────────
  it('S55 linkedAt: complete with targetChannelId leaves linkedAt null', async () => {
    const { userId, channelId } = await seed();
    await uploads['rateLimit'].reset(userId);
    const presign = await uploads.createUploadUrl(
      userId,
      channelId,
      { filename: 'pre.png', size: 8, mimeType: 'image/png', count: 1 },
      now(),
    );
    const res = await uploads.complete(
      userId,
      channelId,
      { targetChannelId: channelId, sessions: [{ sessionId: presign.sessions[0].sessionId }] },
      now(),
    );
    const att = await prisma.attachment.findUnique({ where: { id: res.attachmentIds[0] } });
    expect(att?.linkedAt).toBeNull();
    expect(att?.messageId).toBeNull();
    expect(att?.finalizedAt).not.toBeNull();
  }, 30_000);

  // ── linkedAt 정합: messageId 동봉 → linkedAt=now ─────────────────────────
  it('S55 linkedAt: complete with messageId sets linkedAt=now', async () => {
    const { userId, channelId } = await seed();
    await uploads['rateLimit'].reset(userId);
    const msg = await prisma.message.create({
      data: { id: randomUUID(), channelId, authorId: userId, content: 'm', contentPlain: 'm' },
    });
    const presign = await uploads.createUploadUrl(
      userId,
      channelId,
      { filename: 'm.png', size: 8, mimeType: 'image/png', count: 1 },
      now(),
    );
    const res = await uploads.complete(
      userId,
      channelId,
      { messageId: msg.id, sessions: [{ sessionId: presign.sessions[0].sessionId }] },
      now(),
    );
    const att = await prisma.attachment.findUnique({ where: { id: res.attachmentIds[0] } });
    expect(att?.linkedAt).not.toBeNull();
    expect(att?.messageId).toBe(msg.id);
  }, 30_000);

  // ── GC: 미연결(linkedAt NULL) 24h+ orphan 수거 ────────────────────────────
  it('FR-AM-29: GC deletes an unlinked orphan older than 24h (object + row)', async () => {
    const { userId, channelId } = await seed();
    // S55 리뷰 GC-1: orphan 은 grace(24h) 경과해야 수거된다. messageId NULL·linkedAt NULL
    // 이라도 createdAt 이 24h 이내면 보존(pre-link 전송 대기 가능성). 25h 전으로 둔다.
    const orphan = await prisma.attachment.create({
      data: {
        id: randomUUID(),
        channelId,
        uploaderId: userId,
        kind: 'IMAGE',
        mime: 'image/png',
        sizeBytes: BigInt(8),
        storageKey: 'k/orphan/1',
        originalName: 'o.png',
        finalizedAt: now(),
        linkedAt: null,
        createdAt: new Date(now().getTime() - 25 * 60 * 60 * 1000),
      },
    });
    const res = await gc.sweep(now());
    expect(res.attachmentsDeleted).toBeGreaterThanOrEqual(1);
    expect(s3State.deleted).toContain('k/orphan/1');
    expect(await prisma.attachment.findUnique({ where: { id: orphan.id } })).toBeNull();
  }, 30_000);

  // ── GC: 방금 complete 한 pre-link(messageId NULL·linkedAt NULL·<24h)는 보존 ──
  // S55 리뷰 BLOCKER(GC-1) 회귀: 실제 pre-link shape(messageId=NULL)로 검증한다.
  // 종전 selector 의 `{ messageId: null }` 단독 절은 이 행을 즉시 삭제(데이터 파괴)했다.
  it('FR-AM-29: GC preserves a fresh pre-link (messageId NULL, linkedAt NULL, < 24h)', async () => {
    const { userId, channelId } = await seed();
    const recent = await prisma.attachment.create({
      data: {
        id: randomUUID(),
        channelId,
        messageId: null, // ← 실제 complete(targetChannelId) pre-link shape
        uploaderId: userId,
        kind: 'IMAGE',
        mime: 'image/png',
        sizeBytes: BigInt(8),
        storageKey: 'k/recent/1',
        originalName: 'r.png',
        finalizedAt: now(),
        linkedAt: null,
        createdAt: now(),
      },
    });
    await gc.sweep(now());
    expect(await prisma.attachment.findUnique({ where: { id: recent.id } })).not.toBeNull();
    expect(s3State.deleted).not.toContain('k/recent/1');
  }, 30_000);

  // ── GC: 연결된 첨부 보존(messageId + linkedAt 모두 set) ────────────────────
  it('FR-AM-29: GC preserves a fully linked attachment', async () => {
    const { userId, channelId } = await seed();
    const msg = await prisma.message.create({
      data: { id: randomUUID(), channelId, authorId: userId, content: 'm', contentPlain: 'm' },
    });
    const linked = await prisma.attachment.create({
      data: {
        id: randomUUID(),
        channelId,
        messageId: msg.id,
        uploaderId: userId,
        kind: 'IMAGE',
        mime: 'image/png',
        sizeBytes: BigInt(8),
        storageKey: 'k/linked/1',
        originalName: 'l.png',
        finalizedAt: now(),
        linkedAt: now(),
      },
    });
    await gc.sweep(now());
    expect(await prisma.attachment.findUnique({ where: { id: linked.id } })).not.toBeNull();
  }, 30_000);

  // ── GC: linkedAt NULL + createdAt 24h+ orphan 수거 ───────────────────────
  it('FR-AM-29: GC deletes a stale pre-link (linkedAt null, > 24h old)', async () => {
    const { userId, channelId } = await seed();
    const msg = await prisma.message.create({
      data: { id: randomUUID(), channelId, authorId: userId, content: 'm', contentPlain: 'm' },
    });
    const stale = await prisma.attachment.create({
      data: {
        id: randomUUID(),
        channelId,
        messageId: msg.id,
        uploaderId: userId,
        kind: 'IMAGE',
        mime: 'image/png',
        sizeBytes: BigInt(8),
        storageKey: 'k/stale/1',
        originalName: 's.png',
        finalizedAt: new Date(now().getTime() - 48 * 3600 * 1000),
        linkedAt: null,
        createdAt: new Date(now().getTime() - 48 * 3600 * 1000),
      },
    });
    const res = await gc.sweep(now());
    expect(res.attachmentsDeleted).toBeGreaterThanOrEqual(1);
    expect(await prisma.attachment.findUnique({ where: { id: stale.id } })).toBeNull();
  }, 30_000);

  // ── GC: magic mismatch → BLOCKED 마킹 후 삭제 ─────────────────────────────
  it('FR-AM-29 / FR-AM-26: GC marks BLOCKED on magic mismatch then deletes', async () => {
    const { userId, channelId } = await seed();
    // declared png but bytes are "hello" → mismatch on GC re-check.
    s3State.bytes = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]);
    const orphan = await prisma.attachment.create({
      data: {
        id: randomUUID(),
        channelId,
        uploaderId: userId,
        kind: 'IMAGE',
        mime: 'image/png',
        sizeBytes: BigInt(5),
        storageKey: 'k/liar/1',
        originalName: 'liar.png',
        finalizedAt: now(),
        linkedAt: null,
        // S55 리뷰 GC-1: orphan 은 24h grace 경과 후 수거 — 25h 전.
        createdAt: new Date(now().getTime() - 25 * 60 * 60 * 1000),
      },
    });
    const res = await gc.sweep(now());
    expect(res.attachmentsBlocked).toBeGreaterThanOrEqual(1);
    expect(s3State.deleted).toContain('k/liar/1');
    expect(await prisma.attachment.findUnique({ where: { id: orphan.id } })).toBeNull();
  }, 30_000);

  // ── GC: 만료 미완료 세션 정리 ─────────────────────────────────────────────
  it('FR-AM-29: GC deletes expired open upload sessions', async () => {
    const { userId, channelId } = await seed();
    const expired = await prisma.attachmentUploadSession.create({
      data: {
        id: randomUUID(),
        uploaderId: userId,
        channelId,
        filename: 'exp.png',
        extension: 'png',
        sizeBytes: BigInt(8),
        mimeType: 'image/png',
        storageKey: 'k/session/expired',
        expiresAt: new Date(now().getTime() - 60_000),
        completed: false,
      },
    });
    // a not-yet-expired open session must survive.
    const live = await prisma.attachmentUploadSession.create({
      data: {
        id: randomUUID(),
        uploaderId: userId,
        channelId,
        filename: 'live.png',
        extension: 'png',
        sizeBytes: BigInt(8),
        mimeType: 'image/png',
        storageKey: 'k/session/live',
        expiresAt: new Date(now().getTime() + 60_000),
        completed: false,
      },
    });
    const res = await gc.sweep(now());
    expect(res.sessionsDeleted).toBeGreaterThanOrEqual(1);
    expect(s3State.deleted).toContain('k/session/expired');
    expect(
      await prisma.attachmentUploadSession.findUnique({ where: { id: expired.id } }),
    ).toBeNull();
    expect(
      await prisma.attachmentUploadSession.findUnique({ where: { id: live.id } }),
    ).not.toBeNull();
  }, 30_000);

  // ── 프록시: public 채널 → 302 redirect(60s TTL) ───────────────────────────
  it('FR-AM-17: public-channel download redirects (302) with a short-TTL presigned URL', async () => {
    const { userId, channelId } = await seed({ isPrivate: false });
    const att = await prisma.attachment.create({
      data: {
        id: randomUUID(),
        channelId,
        uploaderId: userId,
        kind: 'IMAGE',
        mime: 'image/png',
        sizeBytes: BigInt(8),
        storageKey: 'k/pub/1',
        originalName: 'p.png',
        finalizedAt: now(),
        linkedAt: now(),
        processingStatus: 'READY',
      },
    });
    const res = fakeRes();
    await proxy.download(att.id, { id: userId } as never, res.res);
    expect(res.statusCode).toBe(302);
    expect(res.redirectUrl).toContain('http://minio.local/signed');
    expect(s3State.lastPresignExpiresIn).toBe(60);
  }, 30_000);

  // ── 프록시: private 채널 → 바이트 스트리밍 ───────────────────────────────
  it('FR-AM-17: private-channel download streams bytes (no redirect)', async () => {
    const { userId, channelId } = await seed({ isPrivate: true });
    s3State.streamBody = Buffer.from('secret-image-bytes');
    const att = await prisma.attachment.create({
      data: {
        id: randomUUID(),
        channelId,
        uploaderId: userId,
        kind: 'IMAGE',
        mime: 'image/png',
        sizeBytes: BigInt(18),
        storageKey: 'k/priv/1',
        originalName: 'secret.png',
        finalizedAt: now(),
        linkedAt: now(),
        processingStatus: 'READY',
      },
    });
    const res = fakeRes();
    await proxy.download(att.id, { id: userId } as never, res.res);
    await res.finished;
    expect(res.redirectUrl).toBeUndefined();
    expect(res.headers['Content-Type']).toBe('image/png');
    expect(res.headers['Content-Disposition']).toContain('inline');
    expect(Buffer.concat(res.chunks).toString()).toBe('secret-image-bytes');
  }, 30_000);

  // ── 프록시: 비멤버 → 403 ─────────────────────────────────────────────────
  it('FR-AM-17: a non-member is forbidden (private channel re-check)', async () => {
    const { userId, channelId } = await seed({ isPrivate: true });
    const att = await prisma.attachment.create({
      data: {
        id: randomUUID(),
        channelId,
        uploaderId: userId,
        kind: 'IMAGE',
        mime: 'image/png',
        sizeBytes: BigInt(8),
        storageKey: 'k/priv/2',
        originalName: 'x.png',
        finalizedAt: now(),
        linkedAt: now(),
        processingStatus: 'READY',
      },
    });
    const outsider = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `out-${Date.now()}@t.local`,
        username: `out${Date.now().toString(36)}`,
        passwordHash: 'x',
      },
    });
    const res = fakeRes();
    await expect(
      proxy.download(att.id, { id: outsider.id } as never, res.res),
    ).rejects.toMatchObject({ code: ErrorCode.WORKSPACE_NOT_MEMBER });
  }, 30_000);

  // ── 프록시: SVG → attachment disposition + nosniff(public redirect) ───────
  it('FR-AM-17: SVG forces attachment disposition + nosniff (public)', async () => {
    const { userId, channelId } = await seed({ isPrivate: false });
    const att = await prisma.attachment.create({
      data: {
        id: randomUUID(),
        channelId,
        uploaderId: userId,
        kind: 'FILE',
        mime: 'image/svg+xml',
        sizeBytes: BigInt(8),
        storageKey: 'k/svg/1',
        originalName: 'v.svg',
        finalizedAt: now(),
        linkedAt: now(),
        processingStatus: 'READY',
      },
    });
    const res = fakeRes();
    await proxy.download(att.id, { id: userId } as never, res.res);
    expect(res.statusCode).toBe(302);
    expect(s3State.lastPresignAttachment).toBe(true);
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
  }, 30_000);

  // ── 프록시 thumbnail: processingStatus≠READY → 202 ───────────────────────
  it('FR-AM-17: thumbnail returns 202 when processing is not READY', async () => {
    const { userId, channelId } = await seed({ isPrivate: false });
    const att = await prisma.attachment.create({
      data: {
        id: randomUUID(),
        channelId,
        uploaderId: userId,
        kind: 'IMAGE',
        mime: 'image/png',
        sizeBytes: BigInt(8),
        storageKey: 'k/thumb/1',
        originalName: 't.png',
        finalizedAt: now(),
        linkedAt: now(),
        processingStatus: 'PENDING',
      },
    });
    const res = fakeRes();
    await proxy.thumbnail(att.id, { id: userId } as never, res.res);
    expect(res.statusCode).toBe(202);
    expect(res.json?.status).toBe('PENDING');
  }, 30_000);
});

/**
 * 최소 Express Response 더블 — 프록시 컨트롤러의 redirect / setHeader / status /
 * json / pipe(stream) 경로를 관찰한다. base 가 실제 Writable 이라 Readable.pipe(res)
 * (dest.once/write/end 호출)가 그대로 동작한다.
 */
function fakeRes(): {
  res: import('express').Response;
  headers: Record<string, string>;
  statusCode?: number;
  redirectUrl?: string;
  json?: Record<string, unknown>;
  chunks: Buffer[];
  finished: Promise<void>;
  headersSent: boolean;
} {
  const state: {
    headers: Record<string, string>;
    statusCode?: number;
    redirectUrl?: string;
    json?: Record<string, unknown>;
    chunks: Buffer[];
    headersSent: boolean;
  } = { headers: {}, chunks: [], headersSent: false };
  let resolveFinished!: () => void;
  const finished = new Promise<void>((r) => {
    resolveFinished = r;
  });

  const base = new Writable({
    write(chunk, _enc, cb) {
      state.chunks.push(Buffer.from(chunk));
      state.headersSent = true;
      cb();
    },
  });
  base.on('finish', () => resolveFinished());

  // Express-스러운 메서드 + headersSent override 를 base Writable 위에 얹는다.
  const res = base as unknown as import('express').Response & {
    setHeader(k: string, v: string): unknown;
  };
  res.setHeader = (k: string, v: string) => {
    state.headers[k] = v;
    return res;
  };
  (res as unknown as { status: (c: number) => unknown }).status = (code: number) => {
    state.statusCode = code;
    return res;
  };
  (res as unknown as { redirect: (c: number, u: string) => unknown }).redirect = (
    code: number,
    url: string,
  ) => {
    state.statusCode = code;
    state.redirectUrl = url;
    state.headersSent = true;
    resolveFinished();
    return res;
  };
  (res as unknown as { json: (b: Record<string, unknown>) => unknown }).json = (
    body: Record<string, unknown>,
  ) => {
    state.json = body;
    state.headersSent = true;
    resolveFinished();
    return res;
  };
  Object.defineProperty(res, 'headersSent', {
    get: () => state.headersSent,
    configurable: true,
  });

  return {
    res,
    get headers() {
      return state.headers;
    },
    get statusCode() {
      return state.statusCode;
    },
    get redirectUrl() {
      return state.redirectUrl;
    },
    get json() {
      return state.json;
    },
    get chunks() {
      return state.chunks;
    },
    get finished() {
      return finished;
    },
    get headersSent() {
      return state.headersSent;
    },
  };
}
