import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  WS_NICKNAME_MAX,
  WS_BIO_MAX,
  WS_AVATAR_MAX_BYTES,
  WS_AVATAR_ALLOWED_MIME,
  computeEffectiveProfile,
  type WsAvatarMime,
  type WorkspaceMemberProfileView,
  type MemberFullProfileView,
  type FullProfilePresenceStatus,
  type WorkspaceRole as SharedRole,
} from '@qufox/shared-types';
import { PrismaService } from '../../prisma/prisma.module';
import { S3Service, sanitizeFilename } from '../../storage/s3.service';
import { matchesMagic, type MagicSupportedMime } from '../../storage/validate-magic-bytes';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { PresenceService } from '../../realtime/presence/presence.service';
import { maskExpiredStatus } from '../../me/custom-status.service';
// S75 (FR-PS-07/08): 전역 아바타/배너 presigned GET URL TTL(600s) 단일 출처.
import { PROFILE_IMAGE_GET_TTL_SEC } from '../../me/profile.service';

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
    // S75 (FR-PS-07/08): full-profile 의 프레즌스(INVISIBLE→타인 offline 마스킹)를 위해
    // PresenceService.bulkFor 를 단일 지점으로 재사용한다(멤버목록 listGrouped 와 동일 규칙).
    private readonly presence: PresenceService,
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
   * S75 (D14 / FR-PS-07·08 · Fork A-1): 타 멤버 전체 프로필 합성 조회.
   *
   * 전역 신원(User) + 워크스페이스 오버라이드(WorkspaceMemberProfile) + 프레즌스 +
   * 시스템 역할(WorkspaceMember.role) + 커스텀 역할(MemberRole→Role) + (만료 마스킹된)
   * 커스텀 상태를 한 합성 뷰로 내려보낸다. 신규 컬럼/마이그레이션 없음 — 전부 기존 컬럼.
   *
   * 권한/존재 검증은 컨트롤러가 (1) 요청자 멤버십(WorkspaceMemberGuard) + (2) 대상 userId 의
   * 동일 wsId 멤버십(비멤버 → 404)을 강제한 뒤 호출한다. 여기서는 합성만 한다.
   *
   * 프레즌스는 PresenceService.bulkFor(viewer, [target]) 단일 지점으로 viewer 기준 마스킹
   * (INVISIBLE→offline)을 적용한다(멤버목록 listGrouped 와 동일 규칙). 커스텀 상태는
   * maskExpiredStatus 로 만료분을 가린다(멤버목록/DM 노출 규칙과 일관).
   *
   * presignGet 은 순수 서명(네트워크 없음)이라 아바타/배너/ws아바타 3개를 Promise.all 로
   * 병렬 파생해도 N+1 네트워크 비용이 없다(SELECT 는 위에서 끝났다 — performance-profiler 검사).
   */
  async getFullProfile(
    workspaceId: string,
    viewerUserId: string,
    targetUserId: string,
  ): Promise<MemberFullProfileView> {
    const now = new Date();
    const [member, wsProfile, presences] = await Promise.all([
      this.prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
        select: {
          role: true,
          user: {
            select: {
              id: true,
              username: true,
              handle: true,
              displayName: true,
              fullName: true,
              pronouns: true,
              title: true,
              timezone: true,
              bio: true,
              avatarKey: true,
              bannerKey: true,
              customStatus: true,
              customStatusEmoji: true,
              customStatusExpiresAt: true,
            },
          },
          // S75 (FR-PS-07): 커스텀 역할(시스템 backfill 역할 제외)을 한 번에 join 해 N+1 회피.
          memberRoles: {
            select: { role: { select: { id: true, name: true, colorHex: true, isSystem: true } } },
          },
        },
      }),
      this.prisma.workspaceMemberProfile.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
        select: { nickname: true, avatarKey: true, workspaceBio: true },
      }),
      this.presence.bulkFor(viewerUserId, [targetUserId]),
    ]);

    // 컨트롤러가 멤버십을 보장하지만 동시 탈퇴 race 방어로 한 번 더 가드한다(enumeration 차단).
    if (!member) {
      throw new DomainError(ErrorCode.WORKSPACE_NOT_MEMBER, 'member not found in this workspace');
    }
    const u = member.user;

    const wsAvatarKey = wsProfile?.avatarKey ?? null;
    const [avatarUrl, bannerUrl, wsAvatarUrl] = await Promise.all([
      u.avatarKey
        ? this.s3.presignGet(u.avatarKey, { expiresIn: PROFILE_IMAGE_GET_TTL_SEC })
        : Promise.resolve(null),
      u.bannerKey
        ? this.s3.presignGet(u.bannerKey, { expiresIn: PROFILE_IMAGE_GET_TTL_SEC })
        : Promise.resolve(null),
      wsAvatarKey
        ? this.s3.presignGet(wsAvatarKey, { expiresIn: WS_AVATAR_GET_TTL_SEC })
        : Promise.resolve(null),
    ]);

    // 만료 커스텀 상태 마스킹(maskExpiredStatus 단일 규칙 — 만료분 text/emoji 모두 null).
    const masked = maskExpiredStatus({
      text: u.customStatus ?? null,
      emoji: u.customStatusEmoji ?? null,
      expiresAt: u.customStatusExpiresAt ?? null,
      now,
    });

    const wsNickname = wsProfile?.nickname ?? null;
    const workspaceBio = wsProfile?.workspaceBio ?? null;
    const eff = computeEffectiveProfile({
      username: u.username,
      displayName: u.displayName,
      wsNickname,
      avatarUrl,
      wsAvatarUrl,
      bio: u.bio,
      workspaceBio,
    });

    return {
      userId: u.id,
      username: u.username,
      // Fork2(Option B): handle ?? username 폴백(전역 프로필 규칙 일관).
      handle: u.handle ?? u.username,
      displayName: u.displayName,
      fullName: u.fullName,
      pronouns: u.pronouns,
      title: u.title,
      timezone: u.timezone,
      bio: u.bio,
      avatarUrl,
      bannerUrl,
      wsNickname,
      wsAvatarUrl,
      workspaceBio,
      presenceStatus: toFullProfilePresence(presences[0]?.status),
      customStatus: masked.text,
      customStatusEmoji: masked.emoji,
      systemRole: member.role as SharedRole,
      // 커스텀 역할만(시스템 backfill 역할 isSystem=true 제외). 색은 colorHex(#RRGGBB|null).
      customRoles: member.memberRoles
        .filter((mr) => !mr.role.isSystem)
        .map((mr) => ({ id: mr.role.id, name: mr.role.name, color: mr.role.colorHex })),
      effectiveDisplayName: eff.effectiveDisplayName,
      effectiveAvatarUrl: eff.effectiveAvatarUrl,
      effectiveBio: eff.effectiveBio,
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

/**
 * S75 (FR-PS-07/08): bulkFor 가 돌려준 viewer-마스킹 PresenceStatus 를 full-profile 의
 * 4-state(online/idle/dnd/offline)로 축약한다. 'invisible' 은 bulkFor 가 이미 타인에게
 * offline 으로 마스킹하지만 self/누락 대비 방어적으로 offline 에 매핑한다(멤버목록 toStatusGroup
 * 와 동일 규칙).
 */
function toFullProfilePresence(status: string | undefined): FullProfilePresenceStatus {
  switch (status) {
    case 'online':
      return 'online';
    case 'idle':
      return 'idle';
    case 'dnd':
      return 'dnd';
    default:
      return 'offline';
  }
}
