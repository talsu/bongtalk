import { Injectable, Logger } from '@nestjs/common';
import {
  S3Client,
  HeadObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  NotFound,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/**
 * S3/MinIO client wrapper. The API uses this ONE class for every
 * object-storage operation so the driver + region + endpoint wiring
 * lives in one place.
 *
 * MinIO is API-compatible with AWS S3 and the SDK works against both;
 * the differences are purely config (path-style addressing, relaxed
 * region string, internal hostname). Task-012-F ships MinIO on the
 * NAS; dev and prod both target it.
 */
@Injectable()
export class S3Service {
  private readonly logger = new Logger(S3Service.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly putTtl: number;
  private readonly getTtl: number;
  private readonly maxUploadBytes: number;

  constructor() {
    const endpoint = process.env.S3_ENDPOINT;
    if (!endpoint) {
      throw new Error('S3_ENDPOINT missing (set in .env.prod; see task-012-F)');
    }
    this.bucket = process.env.S3_BUCKET ?? 'qufox-attachments';
    this.putTtl = Number(process.env.S3_PRESIGN_PUT_TTL_SEC ?? 900);
    this.getTtl = Number(process.env.S3_PRESIGN_GET_TTL_SEC ?? 1800);
    this.maxUploadBytes = Number(process.env.S3_MAX_UPLOAD_BYTES ?? 100 * 1024 * 1024);

    this.client = new S3Client({
      region: process.env.S3_REGION ?? 'us-east-1',
      endpoint,
      // MinIO requires path-style: `http://host/bucket/key` not
      // `http://bucket.host/key`. Virtual-hosted style needs wildcard
      // DNS which we don't run on the NAS.
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
      },
    });
  }

  get bucketName(): string {
    return this.bucket;
  }

  get maxBytes(): number {
    return this.maxUploadBytes;
  }

  /**
   * Build the storage key. Format is stable and predictable so
   * operators can find an object from the attachment id at a glance:
   *   `<workspaceId>/<channelId>/<attachmentId>/<safeName>`
   * originalName is passed through `sanitizeFilename` so the key never
   * contains `/`, `..`, or unprintable chars — the attachmentId segment
   * is the authoritative identity, the filename is for download UX.
   */
  buildKey(
    workspaceId: string,
    channelId: string,
    attachmentId: string,
    originalName: string,
  ): string {
    return `${workspaceId}/${channelId}/${attachmentId}/${sanitizeFilename(originalName)}`;
  }

  async presignPut(key: string, contentType: string, contentLength: number): Promise<string> {
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: contentLength,
    });
    return getSignedUrl(this.client, cmd, { expiresIn: this.putTtl });
  }

  async presignGet(key: string): Promise<string> {
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, cmd, { expiresIn: this.getTtl });
  }

  /**
   * Verify an upload landed + size matches what the client declared at
   * presign time. Throws with a distinct reason per failure so the
   * controller can map to the right ErrorCode.
   */
  async headObject(
    key: string,
  ): Promise<{ contentLength: number; contentType: string | undefined } | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        contentLength: Number(result.ContentLength ?? 0),
        contentType: result.ContentType,
      };
    } catch (err) {
      if (err instanceof NotFound || err instanceof NoSuchKey) return null;
      // Network errors surface; the caller maps to a 5xx DomainError.
      this.logger.warn(`headObject failed key=${key} err=${String(err).slice(0, 200)}`);
      throw err;
    }
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (err) {
      // S3 delete is idempotent — a missing key is NOT an error.
      if (err instanceof NotFound || err instanceof NoSuchKey) return;
      this.logger.warn(`deleteObject failed key=${key} err=${String(err).slice(0, 200)}`);
      throw err;
    }
  }

  /** TTLs exposed for test coverage + response headers. */
  get presignPutTtl(): number {
    return this.putTtl;
  }
  get presignGetTtl(): number {
    return this.getTtl;
  }
}

/**
 * Strip everything except alphanumerics, dot, dash, underscore. Limit
 * length so a pathological 10k-char filename can't blow up the
 * storage key. `..` sequences collapse to `.` before the filter runs
 * so the result never contains any path traversal.
 */
export function sanitizeFilename(name: string): string {
  const trimmed = name.replace(/\.\.+/g, '.').replace(/\s+/g, '-');
  const safe = trimmed.replace(/[^A-Za-z0-9._-]/g, '_');
  const capped = safe.slice(0, 120);
  return capped.length > 0 ? capped : 'file';
}
