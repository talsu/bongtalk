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
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';

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

  /**
   * presigned GET URL. `opts.attachment=true` 면 `Content-Disposition: attachment` 를
   * 강제해 브라우저 인라인 렌더를 막는다(S54 리뷰 H1/M-01/M-02 — 사용자 업로드 첨부의
   * 인라인 stored-XSS/content-sniffing 차단). emoji/avatar 등 인라인이 필요한 경로는
   * opts 없이 호출해 종전대로 inline 유지(공유 메서드 무회귀).
   */
  async presignGet(key: string, opts?: { attachment?: boolean }): Promise<string> {
    this.requireReady();
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(opts?.attachment ? { ResponseContentDisposition: 'attachment' } : {}),
    });
    return getSignedUrl(this.publicClient, cmd, { expiresIn: this.getTtl });
  }

  /**
   * S54 (FR-AM-03 · 옵션 A): presigned POST. Unlike `presignPut` (which only
   * signs the URL — the client can PUT arbitrary bytes / content-type), a
   * presigned POST embeds MinIO Policy Conditions that MinIO enforces
   * server-side at upload time:
   *   - `key` 정확히 일치(prefix 가 아니라 exact key — 키 변조 차단).
   *   - `Content-Type` 정확히 일치(declared mime 강제).
   *   - `content-length-range`(0 ≤ size ≤ maxSize) — 선언 크기 초과 업로드 거부.
   *
   * `presignPut` 은 emoji / group-DM-icon 직접 PUT 경로용으로 보존한다(회귀 금지).
   *
   * @param ttlSec 서명 만료(초) — 크기 분기 TTL.
   */
  async presignPost(
    key: string,
    contentType: string,
    maxBytes: number,
    ttlSec: number,
  ): Promise<{ url: string; fields: Record<string, string> }> {
    this.requireReady();
    const { url, fields } = await createPresignedPost(this.publicClient, {
      Bucket: this.bucket,
      Key: key,
      Conditions: [
        ['eq', '$key', key],
        ['eq', '$Content-Type', contentType],
        ['content-length-range', 0, maxBytes],
      ],
      Fields: { 'Content-Type': contentType },
      Expires: ttlSec,
    });
    return { url, fields };
  }

  /**
   * S20 (FR-DM-06): server-side direct PUT for small in-band uploads (group
   * DM icons). Unlike the presigned-PUT path (attachments / custom emoji),
   * the API receives the multipart bytes itself and writes them straight to
   * MinIO via the internal client — no extra round-trip, and the bytes pass
   * through magic-byte validation BEFORE this call. Used only for ≤4MB blobs
   * so buffering the whole body in memory is acceptable.
   */
  async putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
    this.requireReady();
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.byteLength,
      }),
    );
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

  /**
   * task-038-B: fetch the first N bytes of an object for magic-byte
   * validation on finalize. Costs one range GET (16 bytes in practice);
   * uses the internal client because we pay no egress and want the
   * fastest path. Returns null on NotFound (treat as caller's choice —
   * most paths already HEAD'd before this).
   */
  async getObjectRange(key: string, end: number): Promise<Uint8Array | null> {
    this.requireReady();
    try {
      const result = await this.internalClient.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${end}` }),
      );
      const body = result.Body;
      if (!body) return new Uint8Array(0);
      // AWS SDK v3 Node streams expose transformToByteArray().
      const bytes = await (
        body as { transformToByteArray: () => Promise<Uint8Array> }
      ).transformToByteArray();
      return bytes;
    } catch (err) {
      if (err instanceof NotFound || err instanceof NoSuchKey) return null;
      this.logger.warn(`getObjectRange failed key=${key} err=${String(err).slice(0, 200)}`);
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
