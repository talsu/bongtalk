import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.module';
import { S3Service, sanitizeFilename } from '../storage/s3.service';
import { matchesMagic, type MagicSupportedMime } from '../storage/validate-magic-bytes';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { OutboxService } from '../common/outbox/outbox.service';
import {
  EMOJI_CREATED,
  EMOJI_DELETED,
  type EmojiCreatedPayload,
  type EmojiDeletedPayload,
} from './events/emoji-events';

/**
 * task-037-D / S41 (D05): workspace-scoped custom emoji pack.
 *
 * Storage layout: `<wsId>/emojis/<emojiId>-<safeFilename>` inside the
 * shared `qufox-attachments` bucket — keeps the emoji blobs alongside
 * the other workspace-scoped objects so one lifecycle policy covers
 * both (전용 qufox-emoji 버킷은 S41 carryover — init-minio 수정 금지).
 * Metadata (name, mime, size, uploader) lives in `CustomEmoji`.
 *
 * S41: 서버 리사이즈 없음. finalize 는 HEAD size ≤256KB 검증만 하고 원본 키를
 * 그대로 확정한다(sharp/libvips/gifsicle 미도입 — GIF 애니메이션 원본 보존).
 * 표시 크기는 CSS 고정(picker/reaction chip)으로 처리한다. PRD 의 'sharp
 * 128×128' AC 는 S41 범위 밖(인프라 carryover)이다.
 */
export const CUSTOM_EMOJI_NAME_RE = /^[a-z0-9_]{2,32}$/;
export const CUSTOM_EMOJI_MAX_BYTES = 256 * 1024;
export const CUSTOM_EMOJI_CAP = 100;
// S41 (FR-EM01 / FR-RC20): MIME 화이트리스트에 image/webp 추가(투명도 지원).
// JPEG 불허는 유지한다(투명도 미지원). 매직바이트(validate-magic-bytes)는 이미
// image/webp 를 지원하므로 finalize 의 RIFF...WEBP 검증이 그대로 동작한다.
const ALLOWED_EMOJI_MIME = new Set(['image/png', 'image/gif', 'image/webp']);

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
  // S41 (FR-EM03): PRD list 응답은 `aliases` 를 포함한다. CustomEmojiAlias 모델/
  // 별칭 CRUD(FR-EM05)는 S41 범위 밖(carryover)이라 항상 빈 배열을 채워 응답
  // shape 만 충족한다 — 향후 별칭 모델 도입 시 이 필드에 실제 별칭을 싣는다.
  aliases: string[];
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
    private readonly outbox: OutboxService,
  ) {}

  private buildKey(workspaceId: string, emojiId: string, filename: string): string {
    return `${workspaceId}/emojis/${emojiId}-${sanitizeFilename(filename)}`;
  }

  /**
   * Step 1. Validate name/mime/size + cap, reserve the row, hand back a
   * presigned PUT.
   *
   * S41 (FR-EM02): cap 동시성은 PRD 정본 패턴(D12 FR-RM16 동일)으로 처리한다 —
   * 단일 tx 안에서 (1) 부모 Workspace 행을 FOR NO KEY UPDATE 로 잠가 이 워크스페이스
   * 의 모든 동시 업로드를 직렬화하고, (2) raw `INSERT … ON CONFLICT DO NOTHING` 으로
   * 행을 삽입한 뒤, (3) `SELECT COUNT(*)` 로 워크스페이스 전체 행을 세고, (4) 100 을
   * 초과하면 방금 삽입한 행만 DELETE 하고 EMOJI_WORKSPACE_LIMIT(409)으로 거부한다.
   * advisory lock 미사용.
   *
   * ⚠️ 직렬화 앵커가 COUNT 의 FOR UPDATE 가 아니라 부모 Workspace 행 잠금인 이유:
   * Postgres 는 집계함수(COUNT)와 FOR UPDATE 를 함께 쓸 수 없다(SQLSTATE 0A000).
   * 또 reactions 의 distinct-emoji 한도처럼, INSERT 시점에 존재하지 않는 행을 잠글
   * 수도 없다. 그래서 두 동시 업로드(99→100, 100→101)가 같은 워크스페이스 행을
   * 먼저 잠그려 직렬화되게 부모 Workspace 행을 FOR NO KEY UPDATE 로 잠근다(FK 참조를
   * 막지 않는 NO KEY 잠금 — reaction add 의 Message FOR NO KEY UPDATE 선례 동일).
   * 잠금을 쥔 tx 만 INSERT+COUNT 를 수행하므로 phantom over-cap 이 막힌다.
   *
   * ⚠️ tx-poisoning 회피(S34 교훈): 동시 동일 이름 INSERT 가 23505(P2002)를
   * 던지면 Postgres 가 tx 전체를 abort 시킨다. 그래서 이름 충돌은 raw INSERT 의
   * `ON CONFLICT (workspaceId, name) DO NOTHING` 으로 흡수하고(예외 미발생),
   * 삽입 후 RETURNING 행 유무로 "내가 삽입했는지"를 판정한다 — 행이 없으면
   * 이름이 이미 존재하므로 CUSTOM_EMOJI_NAME_TAKEN(409).
   */
  async presignUpload(input: PresignEmojiUploadInput): Promise<PresignEmojiUploadResult> {
    if (!CUSTOM_EMOJI_NAME_RE.test(input.name)) {
      throw new DomainError(ErrorCode.CUSTOM_EMOJI_NAME_INVALID, 'name must match [a-z0-9_]{2,32}');
    }
    if (!ALLOWED_EMOJI_MIME.has(input.mime.toLowerCase())) {
      throw new DomainError(
        ErrorCode.INVALID_FILE,
        `mime not allowed: ${input.mime} (png/gif/webp only)`,
      );
    }
    if (input.sizeBytes <= 0 || input.sizeBytes > CUSTOM_EMOJI_MAX_BYTES) {
      throw new DomainError(
        ErrorCode.INVALID_FILE,
        `sizeBytes out of bounds (max ${CUSTOM_EMOJI_MAX_BYTES})`,
      );
    }

    const emojiId = randomUUID();
    const storageKey = this.buildKey(input.workspaceId, emojiId, input.filename);

    await this.prisma.$transaction(async (tx) => {
      // (1) 부모 Workspace 행을 FOR NO KEY UPDATE 로 잠가 동시 업로드를 직렬화한다.
      await tx.$executeRaw(Prisma.sql`
        SELECT id FROM "Workspace" WHERE id = ${input.workspaceId}::uuid FOR NO KEY UPDATE
      `);
      // (2) ON CONFLICT DO NOTHING — 동일 (workspaceId, name) 동시 삽입을 흡수
      // 하므로 23505 가 tx 를 오염시키지 않는다. RETURNING id 행 유무로 내가
      // 실제로 삽입했는지(=이름이 비어 있었는지) 판정한다.
      const inserted = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        INSERT INTO "CustomEmoji"
          ("id", "workspaceId", "name", "createdBy", "storageKey", "mime", "sizeBytes", "createdAt")
        VALUES (
          ${emojiId}::uuid, ${input.workspaceId}::uuid, ${input.name}, ${input.uploaderId}::uuid,
          ${storageKey}, ${input.mime}, ${input.sizeBytes}::bigint, NOW()
        )
        ON CONFLICT ("workspaceId", "name") DO NOTHING
        RETURNING "id"
      `);
      if (inserted.length === 0) {
        throw new DomainError(
          ErrorCode.CUSTOM_EMOJI_NAME_TAKEN,
          `:${input.name}: already exists in this workspace`,
        );
      }
      // (3) 워크스페이스 전체 이모지 행을 센다(방금 삽입한 행 포함). 직렬화는 (1)의
      // 워크스페이스 행 잠금이 보장하므로 여기는 평범한 COUNT 다.
      const countRows = await tx.$queryRaw<{ cnt: bigint }[]>(Prisma.sql`
        SELECT COUNT(*)::bigint AS cnt
          FROM "CustomEmoji"
         WHERE "workspaceId" = ${input.workspaceId}::uuid
      `);
      const total = Number(countRows[0]?.cnt ?? 0n);
      if (total > CUSTOM_EMOJI_CAP) {
        // (4) 한도 초과를 만든 방금 삽입한 행만 되돌린다.
        await tx.customEmoji.delete({ where: { id: emojiId } });
        throw new DomainError(
          ErrorCode.EMOJI_WORKSPACE_LIMIT,
          `workspace already at ${CUSTOM_EMOJI_CAP} emoji cap`,
        );
      }
    });

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
    // S41 (FR-EM01 / FR-RC20): 서버 리사이즈 없음 — finalize 는 HEAD size 검증만
    // 하고 원본 키를 그대로 확정한다. 선언 size 와 실제 HEAD size 가 어긋나면(또는
    // 256KB 초과면) INVALID_FILE(422)로 거부한다(PRD 정본 — 종전 413 정합). DTO
    // 가 이미 ≤256KB 를 강제하므로 여기서는 HEAD 의 실측치가 그 한도를 넘는지를
    // 추가로 방어한다(클라가 작은 size 를 선언하고 큰 파일을 올리는 우회 차단).
    if (
      head.contentLength !== Number(row.sizeBytes) ||
      head.contentLength > CUSTOM_EMOJI_MAX_BYTES
    ) {
      await this.s3.deleteObject(row.storageKey);
      await this.prisma.customEmoji.delete({ where: { id: emojiId } });
      throw new DomainError(
        ErrorCode.INVALID_FILE,
        `declared ${row.sizeBytes} bytes, actual ${head.contentLength} (max ${CUSTOM_EMOJI_MAX_BYTES})`,
      );
    }

    // task-038-B: magic-byte validation. Presign trusted the client's
    // declared mime; finalize is the first server-side chance to see
    // the actual bytes. Range GET for the first 16 bytes is cheap and
    // catches "PNG header uploaded with GIF mime", or worse — arbitrary
    // HTML declared as image/png. Mismatch → delete object + row +
    // 422 INVALID_MAGIC_BYTES so the blob never serves at any URL
    // (task-039-D tightened this from 400 — the request envelope is
    // valid, the body just doesn't match the declared mime). S41: WEBP
    // (RIFF...WEBP) 매직바이트도 이미 지원하므로 webp 업로드가 그대로 검증된다.
    const head16 = await this.s3.getObjectRange(row.storageKey, 15);
    if (!head16 || !matchesMagic(head16, row.mime as MagicSupportedMime)) {
      await this.s3.deleteObject(row.storageKey);
      await this.prisma.customEmoji.delete({ where: { id: emojiId } });
      throw new DomainError(
        ErrorCode.INVALID_MAGIC_BYTES,
        `declared ${row.mime} but file magic does not match`,
      );
    }

    // S41 (FR-RC20): finalize 성공 = 이모지가 확정됐다. 워크스페이스 룸으로
    // emoji:created 를 fanout 하도록 outbox 이벤트를 기록한다(subscriber 가 콜론
    // wire 로 변환). CustomEmoji 에는 finalizedAt 컬럼이 없으므로 행 존재 +
    // storageKey HEAD 가능 = 확정 상태이며, 이벤트는 그 확정의 알림이다.
    const createdPayload: EmojiCreatedPayload = {
      workspaceId,
      emojiId,
      name: row.name,
    };
    await this.outbox.record(null, {
      aggregateType: 'CustomEmoji',
      aggregateId: emojiId,
      eventType: EMOJI_CREATED,
      payload: createdPayload,
    });
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
        // FR-EM03 (별칭 CRUD 는 S41 carryover): 빈 배열로 shape 충족.
        aliases: [] as string[],
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
   * S41 (FR-EM04): 커스텀 이모지 삭제. 권한은 **업로드 본인(createdBy) 또는
   * 워크스페이스 OWNER/ADMIN** 이다(종전 ADMIN 하드게이트 완화 — MEMBER 도
   * 자기가 올린 이모지는 지울 수 있다). 컨트롤러 guard 가 멤버까지 통과시키고,
   * 여기서 caller 의 (id, role) 로 분기한다 — 둘 다 아니면 403(FORBIDDEN).
   *
   * MinIO hard delete(deleteObject) + DB 행 삭제. S3 delete 는 래퍼가 멱등이라
   * missing-key 응답이 DB 쪽을 실패시키지 않는다. 삭제 성공 시 워크스페이스
   * 룸으로 emoji:deleted 를 fanout 하도록 outbox 이벤트를 기록한다.
   *
   * ⚠️ FR-EM06: MessageReaction.customEmojiId 는 onDelete: SetNull 이라, 이
   * 이모지를 참조하던 반응 행은 보존되되 customEmojiId 가 NULL 로 풀린다(UI 가
   * [삭제된 이모지] placeholder 로 표시). CustomEmoji 행 삭제가 그 SetNull 을
   * DB 가 자동 수행한다.
   */
  async delete(
    workspaceId: string,
    emojiId: string,
    callerId: string,
    callerRole: 'OWNER' | 'ADMIN' | 'MEMBER',
  ): Promise<void> {
    const row = await this.prisma.customEmoji.findUnique({ where: { id: emojiId } });
    if (!row || row.workspaceId !== workspaceId) {
      throw new DomainError(ErrorCode.CUSTOM_EMOJI_NOT_FOUND, 'emoji not found');
    }
    const isUploader = row.createdBy === callerId;
    const isAdmin = callerRole === 'OWNER' || callerRole === 'ADMIN';
    if (!isUploader && !isAdmin) {
      throw new DomainError(
        ErrorCode.FORBIDDEN,
        'only the uploader or a workspace owner/admin may delete this emoji',
      );
    }
    await this.prisma.customEmoji.delete({ where: { id: emojiId } });
    await this.s3.deleteObject(row.storageKey);

    const deletedPayload: EmojiDeletedPayload = {
      workspaceId,
      emojiId,
      name: row.name,
    };
    await this.outbox.record(null, {
      aggregateType: 'CustomEmoji',
      aggregateId: emojiId,
      eventType: EMOJI_DELETED,
      payload: deletedPayload,
    });
  }
}
