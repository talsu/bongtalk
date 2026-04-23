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
  /** HeadObject / DeleteObject — server-side calls within the NAS. */
  private readonly internalClient: S3Client;
  /** Presigned URLs — signs against the host the browser reaches. */
  private readonly publicClient: S3Client;
  private readonly bucket: string;
  private readonly putTtl: number;
  private readonly getTtl: number;
  private readonly maxUploadBytes: number;

  constructor() {
    // Lazy-init: we DON'T throw on missing S3_ENDPOINT at construction
    // time because Nest modules instantiate providers eagerly and the
    // attachments test suite boots AppModule without minio env. Any
    // actual S3 call (presignPut/Get, headObject, deleteObject) checks
    // readiness via _requireClient() and throws a clean error there.
    const endpoint = process.env.S3_ENDPOINT;
    const publicEndpoint = process.env.S3_PUBLIC_ENDPOINT ?? endpoint;
    this.bucket = process.env.S3_BUCKET ?? 'qufox-attachments';
    this.putTtl = Number(process.env.S3_PRESIGN_PUT_TTL_SEC ?? 900);
    this.getTtl = Number(process.env.S3_PRESIGN_GET_TTL_SEC ?? 1800);
    this.maxUploadBytes = Number(process.env.S3_MAX_UPLOAD_BYTES ?? 100 * 1024 * 1024);

    const commonCfg = {
      region: process.env.S3_REGION ?? 'us-east-1',
      // MinIO requires path-style: `http://host/bucket/key` not
      // `http://bucket.host/key`. Virtual-hosted style needs wildcard
      // DNS which we don't run on the NAS.
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
      },
    };
    // When endpoint is missing, create clients with a harmless
    // placeholder so method calls fail cleanly via _requireClient()
    // below rather than via an opaque SDK "cannot sign" error.
    this.ready = Boolean(endpoint);
    this.internalClient = new S3Client({
      ...commonCfg,
      endpoint: endpoint ?? 'http://s3-endpoint-not-configured',
    });
    this.publicClient = new S3Client({
      ...commonCfg,
      endpoint: publicEndpoint ?? 'http://s3-endpoint-not-configured',
    });
  }

  private readonly ready: boolean;

  private requireReady(): void {
    if (!this.ready) {
      throw new Error('S3_ENDPOINT missing (set in .env.prod; see task-012-F)');
    }
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
    workspaceId: string | null,
    channelId: string,
    attachmentId: string,
    originalName: string,
  ): string {
    // task-034-A: DIRECT channels have no parent workspace; route them
    // under a __dm__ prefix so the S3 key space stays collision-free.
    const prefix = workspaceId ?? '__dm__';
    return `${prefix}/${channelId}/${attachmentId}/${sanitizeFilename(originalName)}`;
  }

  async presignPut(key: string, contentType: string, contentLength: number): Promise<string> {
    this.requireReady();
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: contentLength,
    });
    return getSignedUrl(this.publicClient, cmd, { expiresIn: this.putTtl });
  }

  async presignGet(key: string): Promise<string> {
    this.requireReady();
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.publicClient, cmd, { expiresIn: this.getTtl });
  }

  /**
   * Verify an upload landed + size matches what the client declared at
   * presign time. Throws with a distinct reason per failure so the
   * controller can map to the right ErrorCode.
   */
  async headObject(
    key: string,
  ): Promise<{ contentLength: number; contentType: string | undefined } | null> {
    this.requireReady();
    try {
      const result = await this.internalClient.send(
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
    this.requireReady();
    try {
      await this.internalClient.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
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
