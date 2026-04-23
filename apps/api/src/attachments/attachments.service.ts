import { Injectable } from '@nestjs/common';
import { AttachmentKind, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.module';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { S3Service } from '../storage/s3.service';

/**
 * Mime allowlist. Deliberately narrow at beta:
 *  - common web image types (no HEIC — transcoding is a future task)
 *  - common video (progressive download; no HLS server-side yet)
 *  - generic application/octet-stream for "FILE" kind
 * Anything else is rejected at presign time.
 */
const ALLOWED_MIME: Record<string, AttachmentKind> = {
  'image/png': AttachmentKind.IMAGE,
  'image/jpeg': AttachmentKind.IMAGE,
  'image/webp': AttachmentKind.IMAGE,
  'image/gif': AttachmentKind.IMAGE,
  'video/mp4': AttachmentKind.VIDEO,
  'video/webm': AttachmentKind.VIDEO,
  'video/quicktime': AttachmentKind.VIDEO,
  'application/pdf': AttachmentKind.FILE,
  'application/zip': AttachmentKind.FILE,
  'application/octet-stream': AttachmentKind.FILE,
  'text/plain': AttachmentKind.FILE,
};

export interface PresignUploadInput {
  clientAttachmentId: string;
  channelId: string;
  workspaceId: string | null;
  uploaderId: string;
  mime: string;
  sizeBytes: number;
  originalName: string;
}

export interface PresignUploadResult {
  attachmentId: string;
  key: string;
  putUrl: string;
  expiresAt: string;
}

@Injectable()
export class AttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
  ) {}

  private kindFor(mime: string): AttachmentKind {
    const kind = ALLOWED_MIME[mime.toLowerCase()];
    if (!kind) {
      throw new DomainError(ErrorCode.ATTACHMENT_MIME_REJECTED, `mime type not allowed: ${mime}`);
    }
    return kind;
  }

  /**
   * Step 1. Idempotent per (channelId, clientAttachmentId). Repeated
   * calls with the same client uuid and consistent params return the
   * same row. Inconsistent params (different size/mime) with the same
   * id → 409 IDEMPOTENCY_KEY_REUSE_CONFLICT, mirroring the message
   * idempotency contract.
   */
  async presignUpload(input: PresignUploadInput): Promise<PresignUploadResult> {
    if (input.sizeBytes <= 0 || input.sizeBytes > this.s3.maxBytes) {
      throw new DomainError(
        ErrorCode.ATTACHMENT_TOO_LARGE,
        `sizeBytes out of bounds (max ${this.s3.maxBytes})`,
      );
    }
    const kind = this.kindFor(input.mime);

    const existing = await this.prisma.attachment.findFirst({
      where: {
        channelId: input.channelId,
        clientAttachmentId: input.clientAttachmentId,
      },
    });

    let row;
    if (existing) {
      if (
        existing.mime !== input.mime ||
        Number(existing.sizeBytes) !== input.sizeBytes ||
        existing.uploaderId !== input.uploaderId
      ) {
        throw new DomainError(
          ErrorCode.IDEMPOTENCY_KEY_REUSE_CONFLICT,
          'clientAttachmentId already used with different params',
        );
      }
      row = existing;
    } else {
      const attachmentId = randomUUID();
      const key = this.s3.buildKey(
        input.workspaceId,
        input.channelId,
        attachmentId,
        input.originalName,
      );
      try {
        row = await this.prisma.attachment.create({
          data: {
            id: attachmentId,
            channelId: input.channelId,
            uploaderId: input.uploaderId,
            clientAttachmentId: input.clientAttachmentId,
            kind,
            mime: input.mime,
            sizeBytes: BigInt(input.sizeBytes),
            storageKey: key,
            originalName: input.originalName.slice(0, 255),
          },
        });
      } catch (err) {
        // Unique-index race: another parallel request won. Refetch.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          const raced = await this.prisma.attachment.findFirst({
            where: {
              channelId: input.channelId,
              clientAttachmentId: input.clientAttachmentId,
            },
          });
          if (!raced) throw err;
          row = raced;
        } else {
          throw err;
        }
      }
    }

    const putUrl = await this.s3.presignPut(row.storageKey, input.mime, input.sizeBytes);
    const expiresAt = new Date(Date.now() + this.s3.presignPutTtl * 1000).toISOString();
    return { attachmentId: row.id, key: row.storageKey, putUrl, expiresAt };
  }

  /**
   * Step 2. HeadObject the landed upload. Fails if the object is
   * missing (client never PUT) or the declared size doesn't match
   * what actually uploaded (truncation / tampering).
   */
  async finalize(attachmentId: string, callerId: string): Promise<void> {
    const att = await this.prisma.attachment.findUnique({ where: { id: attachmentId } });
    if (!att) throw new DomainError(ErrorCode.ATTACHMENT_NOT_FOUND, 'attachment not found');
    if (att.uploaderId !== callerId) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'only the uploader may finalize');
    }
    if (att.finalizedAt) return; // idempotent

    const head = await this.s3.headObject(att.storageKey);
    if (!head) {
      throw new DomainError(
        ErrorCode.ATTACHMENT_NOT_UPLOADED,
        'no object at storageKey — PUT must have failed',
      );
    }
    if (head.contentLength !== Number(att.sizeBytes)) {
      throw new DomainError(
        ErrorCode.ATTACHMENT_SIZE_MISMATCH,
        `declared ${att.sizeBytes} bytes, actual ${head.contentLength}`,
      );
    }
    await this.prisma.attachment.update({
      where: { id: att.id },
      data: { finalizedAt: new Date() },
    });
  }

  /**
   * Step 3. Caller-facing presigned GET URL. The calling controller
   * is responsible for the ACL check (READ bit on effective mask)
   * BEFORE invoking this method.
   */
  async presignDownload(attachmentId: string): Promise<{
    downloadUrl: string;
    expiresAt: string;
    mime: string;
    originalName: string;
    sizeBytes: number;
  }> {
    const att = await this.prisma.attachment.findUnique({ where: { id: attachmentId } });
    if (!att || !att.finalizedAt) {
      throw new DomainError(ErrorCode.ATTACHMENT_NOT_FOUND, 'attachment not ready');
    }
    const downloadUrl = await this.s3.presignGet(att.storageKey);
    const expiresAt = new Date(Date.now() + this.s3.presignGetTtl * 1000).toISOString();
    return {
      downloadUrl,
      expiresAt,
      mime: att.mime,
      originalName: att.originalName,
      sizeBytes: Number(att.sizeBytes),
    };
  }

  async findById(id: string) {
    return this.prisma.attachment.findUnique({ where: { id } });
  }
}
