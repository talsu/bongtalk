import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import Redis from 'ioredis';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ATTACHMENT_MAX_PER_MESSAGE,
  UPLOAD_RL_CONCURRENT_MAX,
  UPLOAD_RL_WINDOW_1M_MAX,
} from '@qufox/shared-types';
import { PrismaService, PrismaModule } from '../../../src/prisma/prisma.module';
import { S3Service } from '../../../src/storage/s3.service';
import { REDIS } from '../../../src/redis/redis.module';
import { AttachmentUploadService } from '../../../src/attachments/attachment-upload.service';
import { UploadRateLimitService } from '../../../src/attachments/upload-rate-limit.service';
import { ChannelAccessByIdGuard } from '../../../src/attachments/guards/channel-access-by-id.guard';
import { ChannelAccessService } from '../../../src/channels/permission/channel-access.service';
// S63 fix-forward (G · S62 fallout): ChannelAccessService 가 non-Optional AuditService 에
// 의존(S62 추가)하므로 standalone test module 에도 AuditService provider 를 제공한다
// (@Global AuditModule 은 AppModule 경유 시에만 자동 주입 — 커스텀 모듈은 직접 등록).
import { AuditService } from '../../../src/common/audit/audit.service';
import { NotifPreferencesService } from '../../../src/notifications/notif-preferences.service';
import { UsersService } from '../../../src/users/users.service';
import { ErrorCode } from '../../../src/common/errors/error-code.enum';

/**
 * S54 (D11) int spec — 첨부 업로드 세션 흐름 + markAsReadMode + DND snooze.
 *
 * Shape: 실 Postgres(testcontainer) + 실 Redis(testcontainer) + S3Service 스텁.
 * 스토리지 SDK 는 이미 S3Service 뒤로 격리되어 있어 스텁이 올바른 integration
 * surface 다(기존 magic-bytes-emoji/attachment int 와 동일 패턴 — MinIO 컨테이너
 * 불요. 편차로 REPORT 에 기록). rate-limit 카운터는 실 Redis 로 검증한다.
 *
 * 전체 test:int 의 invites-rate-limit Redis hang 을 피하려 단독 파일로 둔다.
 */
describe('S54 attachment upload session (int)', () => {
  let pg: StartedTestContainer;
  let redisC: StartedTestContainer;
  let redis: Redis;
  let prisma: PrismaService;
  let uploads: AttachmentUploadService;
  let rateLimit: UploadRateLimitService;
  let notif: NotifPreferencesService;
  let users: UsersService;

  // 스텁이 보관하는 객체 바이트/크기(테스트가 케이스별로 교체).
  const s3State = {
    bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    size: 8,
    deleted: [] as string[],
  };
  const s3Stub = {
    maxBytes: 100 * 1024 * 1024,
    presignPutTtl: 900,
    presignGetTtl: 1800,
    buildKey: (ws: string | null, ch: string, id: string, name: string) =>
      `${ws ?? '__dm__'}/${ch}/${id}/${name}`,
    presignPost: async (key: string) => ({ url: 'http://minio.local/bucket', fields: { key } }),
    presignPut: async () => 'http://minio.local/put',
    headObject: async () => ({ contentLength: s3State.size, contentType: undefined }),
    getObjectRange: async () => s3State.bytes,
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
        POSTGRES_DB: 'qufox_s54_int',
      })
      .withExposedPorts(5432)
      .start();
    const url = `postgresql://qufox:qufox@${pg.getHost()}:${pg.getMappedPort(5432)}/qufox_s54_int?schema=public`;
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
        UploadRateLimitService,
        ChannelAccessByIdGuard,
        ChannelAccessService,
        AuditService,
        NotifPreferencesService,
        UsersService,
        { provide: S3Service, useValue: s3Stub },
        { provide: REDIS, useValue: redis },
      ],
    }).compile();
    await mod.init();
    prisma = mod.get(PrismaService);
    uploads = mod.get(AttachmentUploadService);
    rateLimit = mod.get(UploadRateLimitService);
    notif = mod.get(NotifPreferencesService);
    users = mod.get(UsersService);
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
  });

  let seedCounter = 0;
  async function seed(): Promise<{ userId: string; channelId: string; workspaceId: string }> {
    seedCounter += 1;
    const tag = `${Date.now().toString(36)}${seedCounter}`;
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `s54-${tag}@t.local`,
        username: `s54u${tag}`.slice(0, 30),
        passwordHash: 'x',
      },
    });
    const ws = await prisma.workspace.create({
      data: { id: randomUUID(), name: 'S54W', slug: `s54-${tag}`.slice(0, 30), ownerId: user.id },
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
        isPrivate: false,
        position: 0,
      },
    });
    return { userId: user.id, channelId: ch.id, workspaceId: ws.id };
  }

  const now = () => new Date('2025-01-01T00:00:00Z');

  // ── FR-AM-03: upload-url presign 발급 ──────────────────────────────────────
  it('issues a presigned POST session for an allowed image', async () => {
    const { userId, channelId } = await seed();
    await rateLimit.reset(userId);
    const res = await uploads.createUploadUrl(
      userId,
      channelId,
      { filename: 'pic.png', size: 1024, mimeType: 'image/png', count: 1 },
      now(),
    );
    expect(res.sessions).toHaveLength(1);
    expect(res.sessions[0].upload.method).toBe('POST');
    const row = await prisma.attachmentUploadSession.findUnique({
      where: { id: res.sessions[0].sessionId },
    });
    expect(row?.completed).toBe(false);
    expect(row?.extension).toBe('png');
  }, 30_000);

  // ── FR-AM-05: 차단 확장자 ──────────────────────────────────────────────────
  it('rejects a blocked executable extension', async () => {
    const { userId, channelId } = await seed();
    await rateLimit.reset(userId);
    await expect(
      uploads.createUploadUrl(
        userId,
        channelId,
        { filename: 'malware.exe', size: 10, mimeType: 'application/zip', count: 1 },
        now(),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.ATTACHMENT_EXTENSION_BLOCKED });
  }, 30_000);

  // ── FR-AM-05: zip↔jar 교차검증 ─────────────────────────────────────────────
  it('rejects application/zip declared with a .jar (PK-header disguise)', async () => {
    const { userId, channelId } = await seed();
    await rateLimit.reset(userId);
    // .jar is itself blacklisted, so use .apk via zip-disguise path by first
    // confirming the cross-check fires before the blacklist for zip mimes.
    // (.jar/.apk are both blacklisted; the cross-check is exercised when the
    // extension is an executable archive declared as zip.)
    await expect(
      uploads.createUploadUrl(
        userId,
        channelId,
        { filename: 'app.apk', size: 10, mimeType: 'application/zip', count: 1 },
        now(),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.ATTACHMENT_EXTENSION_BLOCKED });
  }, 30_000);

  // ── FR-AM-06: MIME 화이트리스트 거부(SVG) ──────────────────────────────────
  it('rejects a non-whitelisted mime (SVG blocked by default)', async () => {
    const { userId, channelId } = await seed();
    await rateLimit.reset(userId);
    await expect(
      uploads.createUploadUrl(
        userId,
        channelId,
        { filename: 'vector.svg', size: 10, mimeType: 'image/svg+xml', count: 1 },
        now(),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.ATTACHMENT_MIME_REJECTED });
  }, 30_000);

  // ── FR-AM-27: 1분 슬라이딩 윈도우 초과 → 429 ───────────────────────────────
  it('enforces the 1-minute upload-url rate limit (429)', async () => {
    const { userId, channelId } = await seed();
    await rateLimit.reset(userId);
    for (let i = 0; i < UPLOAD_RL_WINDOW_1M_MAX; i++) {
      await uploads.createUploadUrl(
        userId,
        channelId,
        { filename: `f${i}.png`, size: 10, mimeType: 'image/png', count: 1 },
        now(),
      );
    }
    await expect(
      uploads.createUploadUrl(
        userId,
        channelId,
        { filename: 'over.png', size: 10, mimeType: 'image/png', count: 1 },
        now(),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.UPLOAD_RATE_LIMIT });
  }, 30_000);

  // ── FR-AM-27: 동시 미완료 세션 20개 초과 → 429 ─────────────────────────────
  it('enforces the concurrent open-session cap (429)', async () => {
    const { userId, channelId } = await seed();
    await rateLimit.reset(userId);
    // Pre-seed 20 open sessions directly so the sliding window (10/min) is not
    // the gate under test — the concurrent count is.
    for (let i = 0; i < UPLOAD_RL_CONCURRENT_MAX; i++) {
      await prisma.attachmentUploadSession.create({
        data: {
          id: randomUUID(),
          uploaderId: userId,
          channelId,
          filename: `pre${i}.png`,
          extension: 'png',
          sizeBytes: BigInt(10),
          mimeType: 'image/png',
          storageKey: `k/${i}`,
          expiresAt: new Date(now().getTime() + 15 * 60_000),
          completed: false,
        },
      });
    }
    await expect(
      uploads.createUploadUrl(
        userId,
        channelId,
        { filename: 'one-more.png', size: 10, mimeType: 'image/png', count: 1 },
        now(),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.UPLOAD_RATE_LIMIT });
  }, 30_000);

  // ── FR-AM-03 complete: magic bytes 통과 + linkedAt + 세션 close ─────────────
  it('completes a session: magic-bytes pass, attachment linked, session closed', async () => {
    const { userId, channelId } = await seed();
    await rateLimit.reset(userId);
    s3State.bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG
    s3State.size = 8;
    const presign = await uploads.createUploadUrl(
      userId,
      channelId,
      { filename: 'ok.png', size: 8, mimeType: 'image/png', count: 1 },
      now(),
    );
    const sessionId = presign.sessions[0].sessionId;
    const res = await uploads.complete(
      userId,
      channelId,
      { targetChannelId: channelId, sessions: [{ sessionId, altText: 'a cat', isSpoiler: true }] },
      now(),
    );
    expect(res.attachmentIds).toHaveLength(1);
    const att = await prisma.attachment.findUnique({ where: { id: res.attachmentIds[0] } });
    // S63 fix-forward (G · S62 fallout): 이 단언은 S54 작성 당시 의미(targetChannelId
    // complete → 즉시 linkedAt=now)를 따랐으나, S55 의 linkedAt 정합 수정으로 pre-link
    // (messageId 없이 targetChannelId 만)은 linkedAt=null 이 됐다(SendMessage 가 메시지에
    // 연결할 때 linkedAt 을 찍음). 종전엔 S62 의 ChannelAccessService AuditService DI 실패가
    // 이 spec 전체를 module init 단계에서 죽여 단언이 평가되지 않아 드리프트가 가려졌다.
    // DI 복원으로 단언이 살아나며 현 pre-link 의미(linkedAt=null)로 정렬한다.
    expect(att?.linkedAt).toBeNull();
    expect(att?.altText).toBe('a cat');
    expect(att?.isSpoiler).toBe(true);
    expect(att?.processingStatus).toBe('READY');
    const session = await prisma.attachmentUploadSession.findUnique({ where: { id: sessionId } });
    expect(session?.completed).toBe(true);
  }, 30_000);

  // ── FR-AM-06 complete: magic bytes 불일치 → MIME_MISMATCH + 객체 삭제 ───────
  it('rejects complete when bytes do not match the declared mime (MIME_MISMATCH)', async () => {
    const { userId, channelId } = await seed();
    await rateLimit.reset(userId);
    s3State.bytes = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]); // "hello", not a JPEG
    s3State.size = 5;
    const presign = await uploads.createUploadUrl(
      userId,
      channelId,
      { filename: 'liar.jpg', size: 5, mimeType: 'image/jpeg', count: 1 },
      now(),
    );
    const sessionId = presign.sessions[0].sessionId;
    await expect(
      uploads.complete(
        userId,
        channelId,
        { targetChannelId: channelId, sessions: [{ sessionId }] },
        now(),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.MIME_MISMATCH });
    // Object deleted + session removed.
    expect(s3State.deleted).toContain(presign.sessions[0].storageKey);
    const session = await prisma.attachmentUploadSession.findUnique({ where: { id: sessionId } });
    expect(session).toBeNull();
  }, 30_000);

  // ── FR-AM-03 complete: 만료 세션 → 410 ─────────────────────────────────────
  it('rejects complete on an expired session (410)', async () => {
    const { userId, channelId } = await seed();
    await rateLimit.reset(userId);
    const presign = await uploads.createUploadUrl(
      userId,
      channelId,
      { filename: 'late.png', size: 8, mimeType: 'image/png', count: 1 },
      now(),
    );
    const sessionId = presign.sessions[0].sessionId;
    // Complete far in the future — past the 15-minute TTL.
    const future = new Date(now().getTime() + 16 * 60_000);
    await expect(
      uploads.complete(
        userId,
        channelId,
        { targetChannelId: channelId, sessions: [{ sessionId }] },
        future,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.ATTACHMENT_SESSION_EXPIRED });
  }, 30_000);

  // ── FR-AM-04 complete: 메시지당 10개 초과 → 400 ───────────────────────────
  it('rejects complete when it would exceed 10 attachments per message', async () => {
    const { userId, channelId } = await seed();
    await rateLimit.reset(userId);
    s3State.bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    s3State.size = 8;
    // Create a message + 10 pre-existing attachments, then attempt 1 more.
    const msg = await prisma.message.create({
      data: { id: randomUUID(), channelId, authorId: userId, content: 'm', contentPlain: 'm' },
    });
    for (let i = 0; i < ATTACHMENT_MAX_PER_MESSAGE; i++) {
      await prisma.attachment.create({
        data: {
          id: randomUUID(),
          channelId,
          messageId: msg.id,
          uploaderId: userId,
          kind: 'IMAGE',
          mime: 'image/png',
          sizeBytes: BigInt(8),
          storageKey: `k/full/${i}`,
          originalName: `f${i}.png`,
        },
      });
    }
    const presign = await uploads.createUploadUrl(
      userId,
      channelId,
      { filename: 'eleventh.png', size: 8, mimeType: 'image/png', count: 1 },
      now(),
    );
    await expect(
      uploads.complete(
        userId,
        channelId,
        { messageId: msg.id, sessions: [{ sessionId: presign.sessions[0].sessionId }] },
        now(),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.ATTACHMENT_COUNT_EXCEEDED });
  }, 30_000);

  // ── FR-AM-03 complete: ACL 재검증 — 비멤버 거부 ────────────────────────────
  it('re-validates channel ACL at complete (non-member is forbidden)', async () => {
    const { userId, channelId } = await seed();
    await rateLimit.reset(userId);
    const presign = await uploads.createUploadUrl(
      userId,
      channelId,
      { filename: 'acl.png', size: 8, mimeType: 'image/png', count: 1 },
      now(),
    );
    // A different user (not a member of the workspace) tries to complete.
    const outsider = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `out-${Date.now()}@t.local`,
        username: `out${Date.now().toString(36)}`,
        passwordHash: 'x',
      },
    });
    // ACL re-check runs before the per-session lookup, so a non-member of the
    // workspace is rejected at the channel gate (WORKSPACE_NOT_MEMBER).
    await expect(
      uploads.complete(
        outsider.id,
        channelId,
        { targetChannelId: channelId, sessions: [{ sessionId: presign.sessions[0].sessionId }] },
        now(),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.WORKSPACE_NOT_MEMBER });
  }, 30_000);

  // ── FR-AM-03 complete: 타인 소유 세션 → ATTACHMENT_SESSION_NOT_FOUND ────────
  it('rejects completing a session owned by another member (404 neutral)', async () => {
    const { userId, channelId, workspaceId } = await seed();
    await rateLimit.reset(userId);
    const presign = await uploads.createUploadUrl(
      userId,
      channelId,
      { filename: 'mine.png', size: 8, mimeType: 'image/png', count: 1 },
      now(),
    );
    // A second member of the same workspace tries to claim user1's session.
    const other = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `o2-${Date.now()}@t.local`,
        username: `o2${Date.now().toString(36)}`,
        passwordHash: 'x',
      },
    });
    await prisma.workspaceMember.create({
      data: { workspaceId, userId: other.id, role: 'MEMBER' },
    });
    await expect(
      uploads.complete(
        other.id,
        channelId,
        { targetChannelId: channelId, sessions: [{ sessionId: presign.sessions[0].sessionId }] },
        now(),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.ATTACHMENT_SESSION_NOT_FOUND });
  }, 30_000);

  // ── FR-RS-13: markAsReadMode PATCH + 기본값 ────────────────────────────────
  it('upserts markAsReadMode and reads it back (default AUTO_FROM_POSITION)', async () => {
    const { userId } = await seed();
    const initial = await users.getSettings(userId);
    expect(initial.markAsReadMode).toBe('AUTO_FROM_POSITION');
    const updated = await users.updateSettings(userId, 'MANUAL_FROM_LATEST');
    expect(updated.markAsReadMode).toBe('MANUAL_FROM_LATEST');
    const reread = await users.getSettings(userId);
    expect(reread.markAsReadMode).toBe('MANUAL_FROM_LATEST');
  }, 30_000);

  it('markAsReadMode upsert preserves other UserSettings fields (keywords)', async () => {
    const { userId } = await seed();
    // Seed notif keywords first (separate UserSettings field).
    await notif.updateGlobal(userId, { keywords: ['alpha', 'beta'] }, now());
    await users.updateSettings(userId, 'AUTO_FROM_LATEST');
    const global = await notif.getGlobal(userId);
    expect(global.keywords).toEqual(['alpha', 'beta']);
    const settings = await users.getSettings(userId);
    expect(settings.markAsReadMode).toBe('AUTO_FROM_LATEST');
  }, 30_000);

  // ── FR-P13: DND snooze (분 단위 → dndUntil) — S48 dndUntil 게이트 재사용 ────
  it('FR-P13: minute-based snooze sets dndUntil = now + minutes', async () => {
    const { userId } = await seed();
    const t = now();
    const res = await notif.updateGlobal(userId, { dndSnoozeMinutes: 30 }, t);
    expect(res.dndUntil).not.toBeNull();
    const until = new Date(res.dndUntil as string).getTime();
    // now + 30min (+1s epsilon for the strict lower-bound check).
    expect(until).toBe(t.getTime() + 30 * 60_000 + 1_000);
  }, 30_000);

  it('FR-P13: snooze beyond the 7-day cap is rejected (VALIDATION_FAILED)', async () => {
    const { userId } = await seed();
    await expect(
      notif.updateGlobal(userId, { dndSnoozeMinutes: 8 * 24 * 60 }, now()),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  }, 30_000);
});
