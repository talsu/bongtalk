import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.module';
import { S3Service, sanitizeFilename } from '../storage/s3.service';
import { matchesMagic, type MagicSupportedMime } from '../storage/validate-magic-bytes';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

/**
 * task-037-D: workspace-scoped custom emoji pack.
 *
 * Storage layout: `<wsId>/emojis/<emojiId>-<safeFilename>` inside the
 * shared `qufox-attachments` bucket — keeps the emoji blobs alongside
 * the other workspace-scoped objects so one lifecycle policy covers
 * both. Metadata (name, mime, size, uploader) lives in `CustomEmoji`.
 */
export const CUSTOM_EMOJI_NAME_RE = /^[a-z0-9_]{2,32}$/;
export const CUSTOM_EMOJI_MAX_BYTES = 256 * 1024;
export const CUSTOM_EMOJI_CAP = 100;
const ALLOWED_EMOJI_MIME = new Set(['image/png', 'image/gif']);

export interface PresignEmojiUploadInput {
  workspaceId: string;
  uploaderId: string;
  name: string;
  mime: string;
  sizeBytes: number;
  filename: string;
}

export interface PresignEmojiUploadResult {
  emojiId: string;
  storageKey: string;
  putUrl: string;
  expiresAt: string;
}

export interface CustomEmojiListItem {
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
  url: string;
  urlExpiresAt: string;
  sizeBytes: number;
  mime: string;
}

@Injectable()
export class CustomEmojiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
  ) {}

  private buildKey(workspaceId: string, emojiId: string, filename: string): string {
    return `${workspaceId}/emojis/${emojiId}-${sanitizeFilename(filename)}`;
  }

  /**
   * Step 1. Validate name/mime/size + cap, reserve the row, hand back a
   * presigned PUT. Cap + uniqueness checked inside a Serializable
   * transaction so two concurrent uploads that would together push the
   * workspace past 100 can't both pass the count check. (closes the
   * same TOCTOU pattern we fixed for friend cap in 032-follow.)
   */
  async presignUpload(input: PresignEmojiUploadInput): Promise<PresignEmojiUploadResult> {
    if (!CUSTOM_EMOJI_NAME_RE.test(input.name)) {
      throw new DomainError(ErrorCode.CUSTOM_EMOJI_NAME_INVALID, 'name must match [a-z0-9_]{2,32}');
    }
    if (!ALLOWED_EMOJI_MIME.has(input.mime.toLowerCase())) {
      throw new DomainError(
        ErrorCode.CUSTOM_EMOJI_MIME_REJECTED,
        `mime not allowed: ${input.mime} (png/gif only)`,
      );
    }
    if (input.sizeBytes <= 0 || input.sizeBytes > CUSTOM_EMOJI_MAX_BYTES) {
      throw new DomainError(
        ErrorCode.CUSTOM_EMOJI_TOO_LARGE,
        `sizeBytes out of bounds (max ${CUSTOM_EMOJI_MAX_BYTES})`,
      );
    }

    const emojiId = randomUUID();
    const storageKey = this.buildKey(input.workspaceId, emojiId, input.filename);

    try {
      await this.prisma.$transaction(
        async (tx) => {
          const count = await tx.customEmoji.count({
            where: { workspaceId: input.workspaceId },
          });
          if (count >= CUSTOM_EMOJI_CAP) {
            throw new DomainError(
              ErrorCode.CUSTOM_EMOJI_CAP_REACHED,
              `workspace already at ${CUSTOM_EMOJI_CAP} emoji cap`,
            );
          }
          await tx.customEmoji.create({
            data: {
              id: emojiId,
              workspaceId: input.workspaceId,
              name: input.name,
              createdBy: input.uploaderId,
              storageKey,
              mime: input.mime,
              sizeBytes: BigInt(input.sizeBytes),
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new DomainError(
          ErrorCode.CUSTOM_EMOJI_NAME_TAKEN,
          `:${input.name}: already exists in this workspace`,
        );
      }
      throw err;
    }

    const putUrl = await this.s3.presignPut(storageKey, input.mime, input.sizeBytes);
    const expiresAt = new Date(Date.now() + this.s3.presignPutTtl * 1000).toISOString();
    return { emojiId, storageKey, putUrl, expiresAt };
  }

  /**
   * Step 2. HeadObject the landed blob and check the declared size
   * matches. Idempotent: calling twice after a successful finalize
   * returns the row unchanged.
   *
   * TODO(task-037-follow-emoji-gc): the presigned PUT (15 min TTL) is
   * still valid after we delete the row on HEAD miss, so a slow client
   * can land bytes at a key that has no DB pointer. scripts/backup/
   * attachment-orphan-gc.sh scans the Attachment table only — extend
   * it with a second sweep over `<wsId>/emojis/` that removes any
   * object whose `<emojiId>` segment is not in CustomEmoji.id.
   */
  async finalize(workspaceId: string, emojiId: string, callerId: string): Promise<void> {
    const row = await this.prisma.customEmoji.findUnique({ where: { id: emojiId } });
    if (!row || row.workspaceId !== workspaceId) {
      throw new DomainError(ErrorCode.CUSTOM_EMOJI_NOT_FOUND, 'emoji not found');
    }
    if (row.createdBy !== callerId) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'only the uploader may finalize');
    }
    const head = await this.s3.headObject(row.storageKey);
    if (!head) {
      // No object — roll back the reservation so the slot frees up.
      await this.prisma.customEmoji.delete({ where: { id: emojiId } });
      throw new DomainError(ErrorCode.CUSTOM_EMOJI_NOT_FOUND, 'upload never landed');
    }
    if (head.contentLength !== Number(row.sizeBytes)) {
      await this.s3.deleteObject(row.storageKey);
      await this.prisma.customEmoji.delete({ where: { id: emojiId } });
      throw new DomainError(
        ErrorCode.CUSTOM_EMOJI_TOO_LARGE,
        `declared ${row.sizeBytes} bytes, actual ${head.contentLength}`,
      );
    }

    // task-038-B: magic-byte validation. Presign trusted the client's
    // declared mime; finalize is the first server-side chance to see
    // the actual bytes. Range GET for the first 16 bytes is cheap and
    // catches "PNG header uploaded with GIF mime", or worse — arbitrary
    // HTML declared as image/png. Mismatch → delete object + row +
    // 422 INVALID_MAGIC_BYTES so the blob never serves at any URL
    // (task-039-D tightened this from 400 — the request envelope is
    // valid, the body just doesn't match the declared mime).
    const head16 = await this.s3.getObjectRange(row.storageKey, 15);
    if (!head16 || !matchesMagic(head16, row.mime as MagicSupportedMime)) {
      await this.s3.deleteObject(row.storageKey);
      await this.prisma.customEmoji.delete({ where: { id: emojiId } });
      throw new DomainError(
        ErrorCode.INVALID_MAGIC_BYTES,
        `declared ${row.mime} but file magic does not match`,
      );
    }
    // Nothing else to flip — CustomEmoji has no finalizedAt column;
    // the row existing + storageKey HEAD-able IS the finalized state.
    // Keeping this method as a landing gate gives the client a place
    // to hear "your bytes landed and passed the size check" without us
    // having to probe S3 on every list call.
  }

  async list(workspaceId: string): Promise<CustomEmojiListItem[]> {
    const rows = await this.prisma.customEmoji.findMany({
      where: { workspaceId },
      orderBy: [{ name: 'asc' }],
    });
    const expiresAt = new Date(Date.now() + this.s3.presignGetTtl * 1000).toISOString();
    return Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        name: r.name,
        createdBy: r.createdBy,
        createdAt: r.createdAt.toISOString(),
        url: await this.s3.presignGet(r.storageKey),
        urlExpiresAt: expiresAt,
        sizeBytes: Number(r.sizeBytes),
        mime: r.mime,
      })),
    );
  }

  /**
   * Delete the row + the S3 object. S3 delete is idempotent in our
   * wrapper so a missing-key response doesn't fail the DB side.
   */
  async delete(workspaceId: string, emojiId: string): Promise<void> {
    const row = await this.prisma.customEmoji.findUnique({ where: { id: emojiId } });
    if (!row || row.workspaceId !== workspaceId) {
      throw new DomainError(ErrorCode.CUSTOM_EMOJI_NOT_FOUND, 'emoji not found');
    }
    await this.prisma.customEmoji.delete({ where: { id: emojiId } });
    await this.s3.deleteObject(row.storageKey);
  }
}
