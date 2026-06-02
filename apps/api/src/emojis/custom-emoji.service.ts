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
  EMOJI_ALIAS_UPDATED,
  type EmojiCreatedPayload,
  type EmojiDeletedPayload,
  type EmojiAliasUpdatedPayload,
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
// S42 (FR-EM05): 별칭 slug 규칙(name 과 동일 charset) + 이모지당 별칭 한도.
export const CUSTOM_EMOJI_ALIAS_RE = /^[a-z0-9_]{2,32}$/;
export const CUSTOM_EMOJI_ALIAS_CAP = 10;
// S41 (FR-EM01 / FR-RC20): MIME 화이트리스트에 image/webp 추가(투명도 지원).
// JPEG 불허는 유지한다(투명도 미지원). 매직바이트(validate-magic-bytes)는 이미
// image/webp 를 지원하므로 finalize 의 RIFF...WEBP 검증이 그대로 동작한다.
const ALLOWED_EMOJI_MIME = new Set(['image/png', 'image/gif', 'image/webp']);

export interface PresignEmojiUploadInput {
  workspaceId: string;
  uploaderId: string;
  // S42 (FR-PK04): 업로드 권한 게이트(OWNER/ADMIN OR canMemberUpload)에 쓰는 caller
  // role. 컨트롤러가 @Roles 게이트를 떼고 멤버까지 통과시킨 뒤, 서비스가 이 role 과
  // WorkspaceEmojiConfig.canMemberUpload 로 분기한다.
  uploaderRole: 'OWNER' | 'ADMIN' | 'MEMBER';
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
  /**
   * S42 (FR-PK04): 업로드 권한 게이트. OWNER/ADMIN 은 항상 허용. MEMBER 는
   * WorkspaceEmojiConfig.canMemberUpload === true 일 때만 허용한다. 설정 행이
   * 없으면(또는 false) MEMBER 는 거부 — S41 의 ADMIN-only 게이트를 보존한다
   * (★메인루프 결정: canMemberUpload 기본값 false). 거부는 403(FORBIDDEN).
   */
  private async assertCanUpload(
    workspaceId: string,
    role: 'OWNER' | 'ADMIN' | 'MEMBER',
  ): Promise<void> {
    if (role === 'OWNER' || role === 'ADMIN') return;
    const config = await this.prisma.workspaceEmojiConfig.findUnique({
      where: { workspaceId },
      select: { canMemberUpload: true },
    });
    if (!config?.canMemberUpload) {
      throw new DomainError(
        ErrorCode.FORBIDDEN,
        'members may not upload emoji in this workspace (canMemberUpload is off)',
      );
    }
  }

  async presignUpload(input: PresignEmojiUploadInput): Promise<PresignEmojiUploadResult> {
    await this.assertCanUpload(input.workspaceId, input.uploaderRole);
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
      // S42 (FR-EM03): 빈 배열 placeholder 를 실제 CustomEmojiAlias 로 교체한다.
      // 별칭은 alias 알파벳 순으로 안정 정렬해 list / picker-data 가 결정적 순서를
      // 반환하게 한다.
      include: { aliases: { orderBy: { alias: 'asc' } } },
    });
    const expiresAt = new Date(Date.now() + this.s3.presignGetTtl * 1000).toISOString();
    return Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        name: r.name,
        // S42 (FR-EM03): 실제 별칭 슬러그 목록.
        aliases: r.aliases.map((a) => a.alias),
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

  /**
   * S42 (FR-EM05): 커스텀 이모지에 별칭을 추가한다. 권한은 컨트롤러 @Roles('ADMIN')
   * 가 OWNER/ADMIN 으로 게이트한다(여기서 재검사하지 않음).
   *
   * 검증 순서:
   *   1. alias 형식 [a-z0-9_]{2,32} (불일치 → CUSTOM_EMOJI_NAME_INVALID 422)
   *   2. 대상 이모지 존재 + 워크스페이스 일치 (없으면 CUSTOM_EMOJI_NOT_FOUND 404)
   *   3. 이모지당 별칭 ≤10 (초과 → ALIAS_LIMIT 409)
   *   4. 워크스페이스 내 충돌 — 다른 CustomEmojiAlias.alias 또는 어떤 CustomEmoji.name
   *      과도 겹치면 ALIAS_CONFLICT 409 (서비스가 양쪽 모두 검사)
   *
   * 동시성(S34 tx-poisoning 회피): (workspaceId, alias) unique 이므로 동시 동일
   * 별칭 INSERT 가 23505(P2002)를 던지면 tx 가 abort 된다. raw `INSERT … ON CONFLICT
   * DO NOTHING RETURNING` 으로 충돌을 흡수하고(예외 미발생), RETURNING 행 유무로
   * 내가 삽입했는지를 판정한다 — 행이 없으면 그 사이 누가 같은 alias 를 선점한
   * 것이므로 ALIAS_CONFLICT. 부모 CustomEmoji 행을 FOR NO KEY UPDATE 로 잠가
   * 별칭 COUNT(≤10)를 직렬화한다(presignUpload 의 워크스페이스 잠금 선례).
   *
   * 성공 시 그 이모지의 전체 별칭 스냅샷을 outbox emoji.alias_updated 로 발행한다.
   */
  async addAlias(
    workspaceId: string,
    emojiId: string,
    alias: string,
    createdBy: string,
  ): Promise<{ aliases: string[] }> {
    if (!CUSTOM_EMOJI_ALIAS_RE.test(alias)) {
      throw new DomainError(
        ErrorCode.CUSTOM_EMOJI_NAME_INVALID,
        'alias must match [a-z0-9_]{2,32}',
      );
    }
    const aliasId = randomUUID();
    const aliases = await this.prisma.$transaction(async (tx) => {
      // 대상 이모지 존재 + 워크스페이스 일치 확인 + 동시 별칭 추가 직렬화 잠금.
      const target = await tx.$queryRaw<{ id: string; name: string }[]>(Prisma.sql`
        SELECT "id", "name" FROM "CustomEmoji"
         WHERE "id" = ${emojiId}::uuid AND "workspaceId" = ${workspaceId}::uuid
         FOR NO KEY UPDATE
      `);
      if (target.length === 0) {
        throw new DomainError(ErrorCode.CUSTOM_EMOJI_NOT_FOUND, 'emoji not found');
      }
      // 이모지당 ≤10 한도.
      const countRows = await tx.$queryRaw<{ cnt: bigint }[]>(Prisma.sql`
        SELECT COUNT(*)::bigint AS cnt FROM "CustomEmojiAlias"
         WHERE "customEmojiId" = ${emojiId}::uuid
      `);
      if (Number(countRows[0]?.cnt ?? 0n) >= CUSTOM_EMOJI_ALIAS_CAP) {
        throw new DomainError(
          ErrorCode.ALIAS_LIMIT,
          `emoji already has ${CUSTOM_EMOJI_ALIAS_CAP} aliases`,
        );
      }
      // 워크스페이스 내 CustomEmoji.name 과의 충돌 사전검사(alias unique 는 DB 가
      // 막지만, name 충돌은 별도 테이블이라 unique 로 못 막아 사전검사한다).
      const nameClash = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id" FROM "CustomEmoji"
         WHERE "workspaceId" = ${workspaceId}::uuid AND "name" = ${alias}
         LIMIT 1
      `);
      if (nameClash.length > 0) {
        throw new DomainError(
          ErrorCode.ALIAS_CONFLICT,
          `:${alias}: collides with an existing emoji name in this workspace`,
        );
      }
      // ON CONFLICT DO NOTHING — 동시 동일 alias 삽입을 흡수(23505 방지).
      const inserted = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        INSERT INTO "CustomEmojiAlias"
          ("id", "customEmojiId", "workspaceId", "alias", "createdBy", "createdAt")
        VALUES (
          ${aliasId}::uuid, ${emojiId}::uuid, ${workspaceId}::uuid, ${alias},
          ${createdBy}::uuid, NOW()
        )
        ON CONFLICT ("workspaceId", "alias") DO NOTHING
        RETURNING "id"
      `);
      if (inserted.length === 0) {
        throw new DomainError(
          ErrorCode.ALIAS_CONFLICT,
          `:${alias}: is already used in this workspace`,
        );
      }
      const rows = await tx.customEmojiAlias.findMany({
        where: { customEmojiId: emojiId },
        orderBy: { alias: 'asc' },
        select: { alias: true },
      });
      return rows.map((r) => r.alias);
    });

    await this.emitAliasUpdated(workspaceId, emojiId, aliases);
    return { aliases };
  }

  /**
   * S42 (FR-EM05): 커스텀 이모지 별칭을 삭제한다. 권한은 **별칭 생성자(createdBy)
   * 또는 워크스페이스 OWNER/ADMIN**(PRD). 컨트롤러가 멤버까지 통과시키고 여기서
   * (callerId, role) 로 분기한다 — 둘 다 아니면 403. 존재하지 않는 별칭은
   * CUSTOM_EMOJI_NOT_FOUND(404). 성공 시 그 이모지의 잔여 별칭 스냅샷을
   * emoji.alias_updated 로 발행한다(204).
   */
  async removeAlias(
    workspaceId: string,
    emojiId: string,
    alias: string,
    callerId: string,
    callerRole: 'OWNER' | 'ADMIN' | 'MEMBER',
  ): Promise<void> {
    const row = await this.prisma.customEmojiAlias.findUnique({
      where: { workspaceId_alias: { workspaceId, alias } },
    });
    if (!row || row.customEmojiId !== emojiId) {
      throw new DomainError(ErrorCode.CUSTOM_EMOJI_NOT_FOUND, 'alias not found');
    }
    const isCreator = row.createdBy === callerId;
    const isAdmin = callerRole === 'OWNER' || callerRole === 'ADMIN';
    if (!isCreator && !isAdmin) {
      throw new DomainError(
        ErrorCode.FORBIDDEN,
        'only the alias creator or a workspace owner/admin may remove this alias',
      );
    }
    await this.prisma.customEmojiAlias.delete({ where: { id: row.id } });
    const rows = await this.prisma.customEmojiAlias.findMany({
      where: { customEmojiId: emojiId },
      orderBy: { alias: 'asc' },
      select: { alias: true },
    });
    await this.emitAliasUpdated(
      workspaceId,
      emojiId,
      rows.map((r) => r.alias),
    );
  }

  private async emitAliasUpdated(
    workspaceId: string,
    emojiId: string,
    aliases: string[],
  ): Promise<void> {
    const payload: EmojiAliasUpdatedPayload = { workspaceId, emojiId, aliases };
    await this.outbox.record(null, {
      aggregateType: 'CustomEmoji',
      aggregateId: emojiId,
      eventType: EMOJI_ALIAS_UPDATED,
      payload,
    });
  }
}
