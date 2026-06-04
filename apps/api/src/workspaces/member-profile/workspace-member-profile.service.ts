import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  WS_NICKNAME_MAX,
  WS_BIO_MAX,
  WS_AVATAR_MAX_BYTES,
  WS_AVATAR_ALLOWED_MIME,
  type WsAvatarMime,
  type WorkspaceMemberProfileView,
} from '@qufox/shared-types';
import { PrismaService } from '../../prisma/prisma.module';
import { S3Service, sanitizeFilename } from '../../storage/s3.service';
import { matchesMagic, type MagicSupportedMime } from '../../storage/validate-magic-bytes';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';

/**
 * S74 (D14 / FR-PS-06 · Fork2 Option B): 워크스페이스별 프로필 오버라이드 서비스.
 *
 * 멤버가 한 워크스페이스에서만 쓰는 닉네임(≤32)·아바타·About Me(≤190)를 별도로 보관·갱신한다.
 * 전역 프로필을 덮어쓰지 않고 오버라이드만 둔다(표시 우선순위는 members.service / FE 헬퍼가
 * 해석). 길이/MIME/크기/magic/traversal 검증은 ProfileService(아바타) 패턴을 그대로 따른다.
 *
 * Fork1(no server resize): 서버 이미지 디코드 없음([[feedback_no_server_media_resize]]).
 * presigned POST 로 MinIO 가 업로드 시점에 크기/MIME 강제 + finalize magic 사후검증.
 */

// ws아바타 MinIO 키 prefix: ws-avatars/<wsId>/<userId>/<file>.
const WS_AVATAR_KEY_PREFIX = 'ws-avatars';
const WS_AVATAR_MAGIC_HEAD = 15;
const WS_AVATAR_PRESIGN_TTL_SEC = Number(process.env.S3_PRESIGN_PUT_TTL_SEC ?? 900);
// S74 (security MEDIUM fix-forward): ws아바타 presigned GET URL TTL(초). 종전 기본(1800s)
// 대신 짧은 600s 로 서명해 token-leak 표면을 줄인다(프로필 이미지 — 전역 avatar/banner 와 동일).
const WS_AVATAR_GET_TTL_SEC = 600;

export interface UpdateWorkspaceMemberProfileInput {
  nickname?: string | null;
  workspaceBio?: string | null;
}

@Injectable()
export class WorkspaceMemberProfileService {
  private readonly logger = new Logger(WorkspaceMemberProfileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
  ) {}

  private async bestEffortDelete(key: string): Promise<void> {
    try {
      await this.s3.deleteObject(key);
    } catch (err) {
      this.logger.warn(
        `[ws-avatar] best-effort deleteObject failed key=${key} err=${String(err).slice(0, 160)}`,
      );
    }
  }

  /**
   * GET — 본인 또는 같은 워크스페이스 멤버의 ws 프로필. 행 부재(오버라이드 없음)면 모든
   * 오버라이드 필드가 null 인 뷰를 반환한다(폼 초기화 안전). avatarKey → presigned GET URL.
   */
  async getProfile(workspaceId: string, userId: string): Promise<WorkspaceMemberProfileView> {
    const row = await this.prisma.workspaceMemberProfile.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { nickname: true, avatarKey: true, workspaceBio: true },
    });
    return {
      workspaceId,
      userId,
      nickname: row?.nickname ?? null,
      avatarUrl: row?.avatarKey
        ? await this.s3.presignGet(row.avatarKey, { expiresIn: WS_AVATAR_GET_TTL_SEC })
        : null,
      workspaceBio: row?.workspaceBio ?? null,
    };
  }

  /**
   * PATCH — 본인 ws 프로필 부분 갱신(upsert). 명시된 필드만 반영하고, null 은 명시적 비우기
   * (전역값 폴백으로 되돌림). 아바타는 별도 presign/finalize 경로라 여기선 다루지 않는다.
   */
  async updateProfile(
    workspaceId: string,
    userId: string,
    input: UpdateWorkspaceMemberProfileInput,
  ): Promise<WorkspaceMemberProfileView> {
    const data: { nickname?: string | null; workspaceBio?: string | null } = {};
    if (input.nickname !== undefined) {
      data.nickname = this.normString(input.nickname, WS_NICKNAME_MAX, 'nickname', 1);
    }
    if (input.workspaceBio !== undefined) {
      data.workspaceBio = this.normString(input.workspaceBio, WS_BIO_MAX, 'workspaceBio');
    }
    await this.prisma.workspaceMemberProfile.upsert({
      where: { workspaceId_userId: { workspaceId, userId } },
      create: { id: randomUUID(), workspaceId, userId, ...data },
      update: data,
    });
    return this.getProfile(workspaceId, userId);
  }

  /** POST /workspaces/:wsId/me/profile/avatar/presign. */
  async presignAvatar(
    workspaceId: string,
    userId: string,
    contentType: string,
    sizeBytes: number,
  ): Promise<{ key: string; url: string; fields: Record<string, string>; expiresAt: string }> {
    if (!(WS_AVATAR_ALLOWED_MIME as readonly string[]).includes(contentType)) {
      throw new DomainError(
        ErrorCode.INVALID_MIME,
        `mime not allowed: ${contentType} (png/jpeg/webp only)`,
      );
    }
    if (sizeBytes <= 0) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'sizeBytes must be positive');
    }
    if (sizeBytes > WS_AVATAR_MAX_BYTES) {
      throw new DomainError(
        ErrorCode.FILE_TOO_LARGE,
        `ws avatar too large (${sizeBytes} > ${WS_AVATAR_MAX_BYTES})`,
      );
    }
    const ext = this.extForMime(contentType as WsAvatarMime);
    const key = `${WS_AVATAR_KEY_PREFIX}/${workspaceId}/${userId}/${randomUUID()}${sanitizeFilename(ext)}`;
    const { url, fields } = await this.s3.presignPost(
      key,
      contentType,
      WS_AVATAR_MAX_BYTES,
      WS_AVATAR_PRESIGN_TTL_SEC,
    );
    const expiresAt = new Date(Date.now() + WS_AVATAR_PRESIGN_TTL_SEC * 1000).toISOString();
    return { key, url, fields, expiresAt };
  }

  /**
   * PUT /workspaces/:wsId/me/profile/avatar. presign 키가 본인 ws prefix 인지 + 업로드
   * landed/크기/선언MIME/magic 검증 후 upsert. 이전 ws아바타 키는 best-effort 삭제.
   */
  async finalizeAvatar(
    workspaceId: string,
    userId: string,
    key: string,
  ): Promise<{ avatarUrl: string }> {
    const expectedPrefix = `${WS_AVATAR_KEY_PREFIX}/${workspaceId}/${userId}/`;
    if (key.includes('..')) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'key contains a path traversal segment');
    }
    if (!key.startsWith(expectedPrefix)) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'key does not belong to this member/workspace');
    }
    const head = await this.s3.headObject(key);
    if (!head) {
      throw new DomainError(ErrorCode.INVALID_FILE, 'ws avatar upload never landed');
    }
    if (head.contentLength > WS_AVATAR_MAX_BYTES) {
      await this.bestEffortDelete(key);
      throw new DomainError(
        ErrorCode.FILE_TOO_LARGE,
        `ws avatar too large (${head.contentLength} > ${WS_AVATAR_MAX_BYTES})`,
      );
    }
    const declaredMime = head.contentType;
    if (!declaredMime || !(WS_AVATAR_ALLOWED_MIME as readonly string[]).includes(declaredMime)) {
      await this.bestEffortDelete(key);
      throw new DomainError(ErrorCode.INVALID_MIME, `ws avatar mime not allowed: ${declaredMime}`);
    }
    const headBytes = await this.s3.getObjectRange(key, WS_AVATAR_MAGIC_HEAD);
    if (!headBytes || !matchesMagic(headBytes, declaredMime as MagicSupportedMime)) {
      await this.bestEffortDelete(key);
      throw new DomainError(
        ErrorCode.INVALID_MAGIC_BYTES,
        `declared ${declaredMime} but file magic does not match`,
      );
    }

    const prev = await this.prisma.workspaceMemberProfile.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { avatarKey: true },
    });
    await this.prisma.workspaceMemberProfile.upsert({
      where: { workspaceId_userId: { workspaceId, userId } },
      create: { id: randomUUID(), workspaceId, userId, avatarKey: key },
      update: { avatarKey: key },
    });
    if (prev?.avatarKey && prev.avatarKey !== key) {
      void this.bestEffortDelete(prev.avatarKey);
    }
    const avatarUrl = await this.s3.presignGet(key, { expiresIn: WS_AVATAR_GET_TTL_SEC });
    return { avatarUrl };
  }

  /** DELETE /workspaces/:wsId/me/profile/avatar. avatarKey 를 null 로 리셋 + 객체 삭제(멱등). */
  async deleteAvatar(workspaceId: string, userId: string): Promise<void> {
    const row = await this.prisma.workspaceMemberProfile.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { avatarKey: true },
    });
    if (!row?.avatarKey) return;
    await this.prisma.workspaceMemberProfile.update({
      where: { workspaceId_userId: { workspaceId, userId } },
      data: { avatarKey: null },
    });
    await this.bestEffortDelete(row.avatarKey);
  }

  private normString(raw: string | null, max: number, field: string, min = 0): string | null {
    if (raw === null) return null;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    if (trimmed.length > max) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, `${field} too long (max ${max})`);
    }
    if (min > 0 && trimmed.length < min) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, `${field} too short (min ${min})`);
    }
    return trimmed;
  }

  private extForMime(mime: WsAvatarMime): string {
    switch (mime) {
      case 'image/png':
        return '.png';
      case 'image/jpeg':
        return '.jpg';
      case 'image/webp':
        return '.webp';
    }
  }
}
