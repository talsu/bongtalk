import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  HANDLE_RE,
  HANDLE_COOLDOWN_DAYS,
  DISPLAY_NAME_MAX,
  FULL_NAME_MAX,
  PRONOUNS_MAX,
  TITLE_MAX,
  TIMEZONE_MAX,
  BIO_MAX,
  AVATAR_MAX_BYTES,
  AVATAR_ALLOWED_MIME,
  type AvatarMime,
} from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';
import { S3Service, sanitizeFilename } from '../storage/s3.service';
import { matchesMagic, type MagicSupportedMime } from '../storage/validate-magic-bytes';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

/**
 * S73 (D14 / FR-PS-01·02·03): 전역 프로필 + 아바타 서비스.
 *
 * 컨트롤러(MeProfileController / MeAvatarController)는 인증·rate-limit·실시간 방송만
 * 담당하고, 도메인 규칙(handle 형식·30일 쿨다운·필드 길이·아바타 MIME/크기/magic-byte)은
 * 모두 이 서비스가 단일 출처로 보유한다(unit 테스트가 vi.fn() 스텁으로 직접 검증).
 *
 * Fork2(Option B): User.handle 컬럼을 추가하고 username 은 하위호환으로 유지한다.
 * API 는 `handle ?? username` 으로 폴백한다(백필 실패/형식위반 row 대응).
 * Fork1(Option C): 서버 리사이즈 없음([[feedback_no_server_media_resize]]). 단일
 * avatarKey 1개 + 렌더는 CSS object-fit 다운스케일. finalize 즉시 READY.
 */

// 아바타 MinIO 키 prefix. emoji(`<wsId>/emojis/...`) 와 동일 버킷(qufox-attachments)을
// 쓰되 사용자별 avatars/ 네임스페이스로 분리한다(orphan-gc 스윕 대상 식별 용이).
const AVATAR_KEY_PREFIX = 'avatars';
// finalize 시 magic-byte 교차검증을 위해 읽는 선두 바이트 수(WEBP RIFF...WEBP 가 12B).
const AVATAR_MAGIC_HEAD = 15;

export interface ProfileLink {
  url: string;
  label?: string;
}

export interface ProfileView {
  id: string;
  email: string;
  username: string;
  handle: string | null;
  displayName: string | null;
  fullName: string | null;
  pronouns: string | null;
  title: string | null;
  timezone: string | null;
  bio: string | null;
  handleChangedAt: string | null;
  avatarUrl: string | null;
  customStatus: string | null;
  // task-047 M2 carryover(무회귀): 기존 프로필 링크.
  links: ProfileLink[] | null;
}

/** PATCH 입력(컨트롤러가 Zod 로 parse 한 뒤 그대로 전달). 모든 필드 optional. */
export interface UpdateProfileInput {
  handle?: string;
  displayName?: string | null;
  fullName?: string | null;
  pronouns?: string | null;
  title?: string | null;
  timezone?: string | null;
  bio?: string | null;
  links?: ProfileLink[] | null;
}

export interface UpdateProfileResult {
  /** handle 이 실제로 변경됐는지(쿨다운/실시간 방송 분기용). */
  handleChanged: boolean;
  view: ProfileView;
}

@Injectable()
export class ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
  ) {}

  /** GET /me/profile — handle ?? username 폴백 + avatarKey → presigned GET URL. */
  async getProfile(userId: string): Promise<ProfileView> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        username: true,
        handle: true,
        displayName: true,
        fullName: true,
        pronouns: true,
        title: true,
        timezone: true,
        bio: true,
        handleChangedAt: true,
        avatarKey: true,
        customStatus: true,
        links: true,
      },
    });
    if (!row) {
      throw new DomainError(ErrorCode.AUTH_INVALID_TOKEN, 'profile not found');
    }
    return this.toView(row);
  }

  /**
   * PATCH /me/profile. 명시된 필드만 부분 갱신한다.
   *
   * handle 분기(FR-PS-02/03):
   *   - 형식 검증([a-z0-9_.]{3,32}) 실패 → VALIDATION_FAILED(400).
   *   - 현재 handle 과 동일하면 no-op(쿨다운 검증 스킵).
   *   - 변경이면 마지막 handleChangedAt + 30일 > now → HANDLE_COOLDOWN_ACTIVE(400) +
   *     details.nextAllowedAt(ISO).
   *   - 점유 충돌은 DB unique(P2002)를 흡수해 HANDLE_TAKEN(409)로 변환(동시 PATCH race).
   *   - 변경 성공 시 handleChangedAt = now 기록.
   */
  async updateProfile(userId: string, input: UpdateProfileInput): Promise<UpdateProfileResult> {
    const current = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { handle: true, username: true, handleChangedAt: true },
    });
    if (!current) {
      throw new DomainError(ErrorCode.AUTH_INVALID_TOKEN, 'profile not found');
    }

    const data: Prisma.UserUpdateInput = {};
    let handleChanged = false;

    if (input.handle !== undefined) {
      const next = input.handle;
      if (!HANDLE_RE.test(next)) {
        throw new DomainError(
          ErrorCode.VALIDATION_FAILED,
          'handle must match [a-z0-9_.]{3,32} (lowercase)',
        );
      }
      // 폴백 기준(effective handle)과 비교 — handle 이 비어 있으면 username 폴백값과 동일
      // 입력은 변경으로 보지 않는다(백필 실패 row 가 같은 값을 보내도 쿨다운을 안 켜게).
      const effective = current.handle ?? current.username;
      if (next !== effective) {
        this.assertCooldown(current.handleChangedAt);
        data.handle = next;
        data.handleChangedAt = new Date();
        handleChanged = true;
      }
    }

    if (input.displayName !== undefined) {
      data.displayName = this.normString(input.displayName, DISPLAY_NAME_MAX, 'displayName', 1);
    }
    if (input.fullName !== undefined) {
      data.fullName = this.normString(input.fullName, FULL_NAME_MAX, 'fullName');
    }
    if (input.pronouns !== undefined) {
      data.pronouns = this.normString(input.pronouns, PRONOUNS_MAX, 'pronouns');
    }
    if (input.title !== undefined) {
      data.title = this.normString(input.title, TITLE_MAX, 'title');
    }
    if (input.timezone !== undefined) {
      data.timezone = this.normString(input.timezone, TIMEZONE_MAX, 'timezone');
    }
    if (input.bio !== undefined) {
      // FR-PS-02: bio 는 앱 레이어 190자 검증만(DB VarChar 제약은 변경하지 않음).
      data.bio = this.normString(input.bio, BIO_MAX, 'bio');
    }
    if (input.links !== undefined) {
      // task-047 M2 carryover(무회귀): 빈 배열/null → JsonNull, 아니면 배열 그대로.
      const links = input.links;
      data.links =
        links === null || links.length === 0
          ? Prisma.JsonNull
          : (links as unknown as Prisma.InputJsonValue);
    }

    try {
      await this.prisma.user.update({ where: { id: userId }, data });
    } catch (err) {
      // 동시 PATCH race: 다른 사용자가 같은 handle 을 선점 → unique 위반(P2002).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new DomainError(ErrorCode.HANDLE_TAKEN, 'handle already taken');
      }
      throw err;
    }

    const view = await this.getProfile(userId);
    return { handleChanged, view };
  }

  /**
   * FR-PS-03: 쿨다운 검증. 마지막 변경이 없으면(최초 설정) 통과. 마지막 변경 + 30일이
   * 아직 미경과면 HANDLE_COOLDOWN_ACTIVE(400) + nextAllowedAt(ISO).
   */
  private assertCooldown(handleChangedAt: Date | null): void {
    if (!handleChangedAt) return;
    const nextAllowed = new Date(
      handleChangedAt.getTime() + HANDLE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000,
    );
    if (nextAllowed.getTime() > Date.now()) {
      throw new DomainError(
        ErrorCode.HANDLE_COOLDOWN_ACTIVE,
        `handle change is on cooldown until ${nextAllowed.toISOString()}`,
        { nextAllowedAt: nextAllowed.toISOString() },
      );
    }
  }

  /**
   * 가변 길이 텍스트 필드 정규화: null/빈 문자열 → null, trim 후 길이 초과 → 400.
   * minLength(예: displayName 1) 위반은 trim 결과가 0 이 아닌데 min 미만일 때만 거부한다.
   */
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

  // ── FR-PS-01: 아바타 ──────────────────────────────────────────────────────

  /**
   * POST /me/avatar/presign. MIME/크기 검증 후 단일 키 presigned PUT 반환.
   * 키는 매 업로드마다 새 uuid 세그먼트를 써서 finalize 전까지 기존 아바타에 영향을 주지
   * 않는다(이전 키는 finalize 성공 후 best-effort deleteObject).
   */
  async presignAvatar(
    userId: string,
    contentType: string,
    sizeBytes: number,
  ): Promise<{ key: string; putUrl: string; expiresAt: string }> {
    if (!(AVATAR_ALLOWED_MIME as readonly string[]).includes(contentType)) {
      throw new DomainError(
        ErrorCode.INVALID_MIME,
        `mime not allowed: ${contentType} (png/jpeg/webp only)`,
      );
    }
    if (sizeBytes <= 0) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'sizeBytes must be positive');
    }
    if (sizeBytes > AVATAR_MAX_BYTES) {
      throw new DomainError(
        ErrorCode.FILE_TOO_LARGE,
        `avatar too large (${sizeBytes} > ${AVATAR_MAX_BYTES})`,
      );
    }
    const ext = this.extForMime(contentType as AvatarMime);
    const key = `${AVATAR_KEY_PREFIX}/${userId}/${randomUUID()}${sanitizeFilename(ext)}`;
    const putUrl = await this.s3.presignPut(key, contentType, sizeBytes);
    const expiresAt = new Date(Date.now() + this.s3.presignPutTtl * 1000).toISOString();
    return { key, putUrl, expiresAt };
  }

  /**
   * PUT /me/avatar. presign 으로 받은 키가 (1) 본인 prefix 인지, (2) 실제로 업로드됐고
   * 8MB 이하인지(HEAD), (3) 선언 MIME 와 실 바이트 magic 이 일치하는지 검증한 뒤 확정한다.
   * 확정 성공 시 이전 avatarKey 는 best-effort deleteObject(orphan 정리).
   */
  async finalizeAvatar(userId: string, key: string): Promise<{ avatarUrl: string }> {
    const expectedPrefix = `${AVATAR_KEY_PREFIX}/${userId}/`;
    if (!key.startsWith(expectedPrefix)) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'key does not belong to this user');
    }
    const head = await this.s3.headObject(key);
    if (!head) {
      throw new DomainError(ErrorCode.INVALID_FILE, 'avatar upload never landed');
    }
    if (head.contentLength > AVATAR_MAX_BYTES) {
      await this.s3.deleteObject(key);
      throw new DomainError(
        ErrorCode.FILE_TOO_LARGE,
        `avatar too large (${head.contentLength} > ${AVATAR_MAX_BYTES})`,
      );
    }
    const declaredMime = head.contentType;
    if (!declaredMime || !(AVATAR_ALLOWED_MIME as readonly string[]).includes(declaredMime)) {
      await this.s3.deleteObject(key);
      throw new DomainError(ErrorCode.INVALID_MIME, `avatar mime not allowed: ${declaredMime}`);
    }
    const headBytes = await this.s3.getObjectRange(key, AVATAR_MAGIC_HEAD);
    if (!headBytes || !matchesMagic(headBytes, declaredMime as MagicSupportedMime)) {
      await this.s3.deleteObject(key);
      throw new DomainError(
        ErrorCode.INVALID_MAGIC_BYTES,
        `declared ${declaredMime} but file magic does not match`,
      );
    }

    const prev = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { avatarKey: true },
    });
    await this.prisma.user.update({ where: { id: userId }, data: { avatarKey: key } });
    // 이전 키 best-effort 정리(idempotent S3 delete — 동일 키면 스킵).
    if (prev?.avatarKey && prev.avatarKey !== key) {
      await this.s3.deleteObject(prev.avatarKey);
    }
    const avatarUrl = await this.s3.presignGet(key);
    return { avatarUrl };
  }

  /** DELETE /me/avatar. avatarKey 를 null 로 리셋하고 객체를 best-effort 삭제한다. */
  async deleteAvatar(userId: string): Promise<void> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { avatarKey: true },
    });
    if (!row?.avatarKey) return; // 이미 없음 — 멱등.
    await this.prisma.user.update({ where: { id: userId }, data: { avatarKey: null } });
    await this.s3.deleteObject(row.avatarKey);
  }

  private extForMime(mime: AvatarMime): string {
    switch (mime) {
      case 'image/png':
        return '.png';
      case 'image/jpeg':
        return '.jpg';
      case 'image/webp':
        return '.webp';
    }
  }

  private async toView(row: {
    id: string;
    email: string;
    username: string;
    handle: string | null;
    displayName: string | null;
    fullName: string | null;
    pronouns: string | null;
    title: string | null;
    timezone: string | null;
    bio: string | null;
    handleChangedAt: Date | null;
    avatarKey: string | null;
    customStatus: string | null;
    links: Prisma.JsonValue;
  }): Promise<ProfileView> {
    return {
      id: row.id,
      email: row.email,
      username: row.username,
      // Fork2(Option B): handle ?? username 폴백.
      handle: row.handle ?? row.username,
      displayName: row.displayName,
      fullName: row.fullName,
      pronouns: row.pronouns,
      title: row.title,
      timezone: row.timezone,
      bio: row.bio,
      handleChangedAt: row.handleChangedAt ? row.handleChangedAt.toISOString() : null,
      avatarUrl: row.avatarKey ? await this.s3.presignGet(row.avatarKey) : null,
      customStatus: row.customStatus,
      links: (row.links as ProfileLink[] | null) ?? null,
    };
  }
}
