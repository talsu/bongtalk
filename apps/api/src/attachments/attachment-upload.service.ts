import { Injectable } from '@nestjs/common';
import { AttachmentKind, AttachmentStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type {
  CompleteSessionItem,
  UploadSession,
  UploadUrlRequest,
  UploadUrlResponse,
} from '@qufox/shared-types';
import { ATTACHMENT_MAX_PER_MESSAGE, UPLOAD_RL_CONCURRENT_MAX } from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { S3Service } from '../storage/s3.service';
import { ChannelAccessByIdGuard } from './guards/channel-access-by-id.guard';
import { UploadRateLimitService } from './upload-rate-limit.service';
import {
  extractExtension,
  isBlockedExtension,
  isZipExtensionMismatch,
  kindForMime,
  ttlForSize,
} from './attachment-validation';
import {
  matchesMagic,
  isMagicChecked,
  MAGIC_PREFIX_BYTES,
  type MagicSupportedMime,
} from '../storage/validate-magic-bytes';

interface ChannelRow {
  id: string;
  workspaceId: string | null;
  isPrivate: boolean;
  archivedAt: Date | null;
  deletedAt: Date | null;
}

/**
 * S54 (D11 / FR-AM-03/04/05/06/27) — presigned 업로드 세션 흐름.
 *
 *   upload-url : AttachmentUploadSession 생성 + MinIO presigned POST 발급(옵션 A —
 *                Policy Conditions 로 content-type/길이/key 강제). 확장자 블랙리스트
 *                (FR-AM-05) + zip↔jar 교차검증 + MIME 화이트리스트(FR-AM-06) +
 *                rate-limit(FR-AM-27: 15분 60·1분 10·동시 미완료 20) 게이트.
 *   complete   : 채널 ACL 재검증 + magic-byte 8192B 재검증(FR-AM-06) + 메시지당 ≤10개
 *                (FR-AM-04) + Attachment 생성(linkedAt·processingStatus) + 세션 close.
 *                만료/미발견 세션은 거부.
 *
 * `now` 는 주입(테스트 결정성 — 만료/rate-limit 윈도우 제어).
 */
@Injectable()
export class AttachmentUploadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
    private readonly channelAccess: ChannelAccessByIdGuard,
    private readonly rateLimit: UploadRateLimitService,
  ) {}

  private async loadChannel(channelId: string): Promise<ChannelRow> {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: {
        id: true,
        workspaceId: true,
        isPrivate: true,
        archivedAt: true,
        deletedAt: true,
      },
    });
    if (!channel || channel.deletedAt) {
      throw new DomainError(ErrorCode.CHANNEL_NOT_FOUND, 'channel not found');
    }
    if (channel.archivedAt) {
      throw new DomainError(ErrorCode.CHANNEL_ARCHIVED, 'channel is archived');
    }
    return channel;
  }

  /**
   * FR-AM-03: upload-url. 채널 ACL(UPLOAD_ATTACHMENT) + 검증 게이트 통과 후 count 개
   * 세션을 생성하고 각각 presigned POST(폴백 PUT)를 발급한다.
   */
  async createUploadUrl(
    uploaderId: string,
    channelId: string,
    body: UploadUrlRequest,
    now: Date = new Date(),
  ): Promise<UploadUrlResponse> {
    const channel = await this.loadChannel(channelId);
    await this.channelAccess.requireUpload(channel, uploaderId);

    // FR-AM-04: 단일 크기 상한(S3Service.maxBytes — 100MB 재사용).
    if (body.size <= 0 || body.size > this.s3.maxBytes) {
      throw new DomainError(
        ErrorCode.ATTACHMENT_TOO_LARGE,
        `size out of bounds (max ${this.s3.maxBytes})`,
      );
    }

    // FR-AM-05: 확장자 블랙리스트 + zip↔jar/apk 교차검증.
    const ext = extractExtension(body.filename);
    if (isBlockedExtension(ext)) {
      throw new DomainError(ErrorCode.ATTACHMENT_EXTENSION_BLOCKED, `extension blocked: .${ext}`);
    }
    if (isZipExtensionMismatch(body.mimeType, ext)) {
      throw new DomainError(
        ErrorCode.MIME_MISMATCH,
        `application/zip declared but extension .${ext} is an executable archive`,
      );
    }

    // FR-AM-06: MIME 화이트리스트(SVG 등 비허용 거부).
    const kind = kindForMime(body.mimeType);
    if (!kind) {
      throw new DomainError(
        ErrorCode.ATTACHMENT_MIME_REJECTED,
        `mime type not allowed: ${body.mimeType}`,
      );
    }

    // FR-AM-27: 동시 미완료 세션 한도(20). DB COUNT(전용 복합 인덱스 사용).
    const concurrent = await this.prisma.attachmentUploadSession.count({
      where: { uploaderId, completed: false, expiresAt: { gt: now } },
    });
    if (concurrent + body.count > UPLOAD_RL_CONCURRENT_MAX) {
      throw new DomainError(
        ErrorCode.UPLOAD_RATE_LIMIT,
        `too many concurrent upload sessions (max ${UPLOAD_RL_CONCURRENT_MAX})`,
      );
    }
    // FR-AM-27: 15분/1분 슬라이딩 윈도우(Redis). count 회로 친다.
    await this.rateLimit.enforceWindows(uploaderId, body.count, now);

    const ttlSec = ttlForSize(body.size);
    const expiresAt = new Date(now.getTime() + ttlSec * 1000);

    const sessions: UploadSession[] = [];
    for (let i = 0; i < body.count; i++) {
      const sessionId = randomUUID();
      const storageKey = this.s3.buildKey(
        channel.workspaceId,
        channel.id,
        sessionId,
        body.filename,
      );
      await this.prisma.attachmentUploadSession.create({
        data: {
          id: sessionId,
          uploaderId,
          channelId: channel.id,
          filename: body.filename.slice(0, 255),
          extension: ext,
          sizeBytes: BigInt(body.size),
          mimeType: body.mimeType,
          storageKey,
          expiresAt,
          completed: false,
        },
      });

      // 옵션 A: presigned POST(Policy Conditions). createPresignedPost 가 MinIO 와
      // 비호환이면 presignPut 폴백(complete 의 magic-byte/size 재검증이 안전망).
      let upload: UploadSession['upload'];
      try {
        const post = await this.s3.presignPost(storageKey, body.mimeType, body.size, ttlSec);
        upload = { method: 'POST', url: post.url, fields: post.fields };
      } catch {
        const putUrl = await this.s3.presignPut(storageKey, body.mimeType, body.size);
        upload = { method: 'PUT', url: putUrl, fields: {} };
      }

      sessions.push({
        sessionId,
        storageKey,
        expiresAt: expiresAt.toISOString(),
        upload,
      });
    }

    return { sessions };
  }

  /**
   * FR-AM-03: complete. 채널 ACL 재검증 + 각 세션의 magic-byte 8192B 재검증 +
   * 메시지당 ≤10개 검증 후 Attachment 생성 + 세션 close.
   *
   * messageId 면 기존 메시지에 링크(message.channelId 로 채널 결정), targetChannelId 면
   * 곧 보낼 메시지용 pre-link(messageId=null — SendMessage 의 attachmentIds 로 참조).
   */
  async complete(
    uploaderId: string,
    routeChannelId: string,
    body: {
      messageId?: string;
      targetChannelId?: string;
      sessions: CompleteSessionItem[];
    },
    now: Date = new Date(),
  ): Promise<{ attachmentIds: string[] }> {
    // 첨부가 붙을 대상 채널 결정. messageId 면 메시지의 채널, 아니면 targetChannelId.
    // 라우트 채널(:chid)과 대상 채널이 다르면 거부(IDOR 방지).
    let targetChannelId: string;
    let messageId: string | null = null;
    if (body.messageId) {
      const msg = await this.prisma.message.findUnique({
        where: { id: body.messageId },
        select: { id: true, channelId: true, deletedAt: true },
      });
      if (!msg || msg.deletedAt) {
        throw new DomainError(ErrorCode.MESSAGE_NOT_FOUND, 'message not found');
      }
      targetChannelId = msg.channelId;
      messageId = msg.id;
    } else if (body.targetChannelId) {
      targetChannelId = body.targetChannelId;
    } else {
      // 컨트롤러 Zod refine 이 이미 막지만 방어적으로 한 번 더.
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'one of messageId | targetChannelId required',
      );
    }
    if (targetChannelId !== routeChannelId) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'target channel does not match route channel',
      );
    }

    const channel = await this.loadChannel(targetChannelId);
    // FR-AM-03: 멤버십 + ACL 재검증(presign 이후 권한 박탈 시 통과 금지).
    await this.channelAccess.requireUpload(channel, uploaderId);

    // FR-AM-04: 메시지당 ≤10개. 기존 message.attachments + 신규 세션 합산.
    const existingCount = messageId
      ? await this.prisma.attachment.count({ where: { messageId } })
      : 0;
    if (existingCount + body.sessions.length > ATTACHMENT_MAX_PER_MESSAGE) {
      throw new DomainError(
        ErrorCode.ATTACHMENT_COUNT_EXCEEDED,
        `too many attachments (max ${ATTACHMENT_MAX_PER_MESSAGE})`,
      );
    }

    const attachmentIds: string[] = [];
    for (const item of body.sessions) {
      const session = await this.prisma.attachmentUploadSession.findUnique({
        where: { id: item.sessionId },
      });
      // 미발견 / 타인 소유 / 채널 불일치 → 중립 404.
      if (!session || session.uploaderId !== uploaderId || session.channelId !== targetChannelId) {
        throw new DomainError(
          ErrorCode.ATTACHMENT_SESSION_NOT_FOUND,
          `upload session not found: ${item.sessionId}`,
        );
      }
      if (session.completed) {
        throw new DomainError(
          ErrorCode.ATTACHMENT_SESSION_NOT_FOUND,
          'upload session already completed',
        );
      }
      // FR-AM-03: 만료 세션 → 410.
      if (session.expiresAt.getTime() <= now.getTime()) {
        throw new DomainError(
          ErrorCode.ATTACHMENT_SESSION_EXPIRED,
          `upload session expired: ${item.sessionId}`,
        );
      }

      // 업로드 landed + 크기 검증(presigned POST 가 길이를 강제하지만 PUT 폴백 안전망).
      const head = await this.s3.headObject(session.storageKey);
      if (!head) {
        throw new DomainError(
          ErrorCode.ATTACHMENT_NOT_UPLOADED,
          'no object at storageKey — upload must have failed',
        );
      }
      if (head.contentLength !== Number(session.sizeBytes)) {
        throw new DomainError(
          ErrorCode.ATTACHMENT_SIZE_MISMATCH,
          `declared ${session.sizeBytes} bytes, actual ${head.contentLength}`,
        );
      }

      // FR-AM-06: magic-byte 8192B 재검증. 시그니처가 있는 MIME 만 검사한다.
      const mimeLower = session.mimeType.toLowerCase();
      if (isMagicChecked(mimeLower)) {
        const prefix = await this.s3.getObjectRange(session.storageKey, MAGIC_PREFIX_BYTES - 1);
        if (!prefix || !matchesMagic(prefix, mimeLower as MagicSupportedMime)) {
          // 거짓 선언 → 객체 삭제 + 세션 무효화 후 거부.
          await this.s3.deleteObject(session.storageKey);
          await this.prisma.attachmentUploadSession.delete({ where: { id: session.id } });
          throw new DomainError(
            ErrorCode.MIME_MISMATCH,
            `declared ${session.mimeType} but file magic does not match`,
          );
        }
      }

      const kind = (kindForMime(mimeLower) ?? 'FILE') as AttachmentKind;
      const attachmentId = randomUUID();
      // Attachment 생성 + 세션 close 를 한 tx 로 묶는다(부분 완료 방지).
      await this.prisma.$transaction([
        this.prisma.attachment.create({
          data: {
            id: attachmentId,
            channelId: targetChannelId,
            messageId,
            uploaderId,
            kind,
            mime: session.mimeType,
            storedMimeType: session.mimeType,
            extension: session.extension,
            sizeBytes: session.sizeBytes,
            storageKey: session.storageKey,
            originalName: session.filename,
            width: item.width ?? null,
            height: item.height ?? null,
            duration: item.duration ?? null,
            altText: item.altText ?? null,
            isSpoiler: item.isSpoiler ?? false,
            sortOrder: item.sortOrder ?? 0,
            finalizedAt: now,
            linkedAt: now,
            processingStatus: AttachmentStatus.READY,
          },
        }),
        this.prisma.attachmentUploadSession.update({
          where: { id: session.id },
          data: { completed: true },
        }),
      ]);
      attachmentIds.push(attachmentId);
    }

    return { attachmentIds };
  }

  /** P2002 등 race 처리 보조 — 컨트롤러에서 직접 쓰진 않으나 향후 확장 여지. */
  static isUniqueViolation(err: unknown): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
  }
}
