import { Body, Controller, Delete, HttpCode, Post, Put } from '@nestjs/common';
import {
  AvatarPresignInputSchema,
  AvatarFinalizeInputSchema,
  type AvatarPresignResult,
  type AvatarFinalizeResult,
} from '@qufox/shared-types';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { PrismaService } from '../prisma/prisma.module';
import { S3Service } from '../storage/s3.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ProfileService, PROFILE_IMAGE_GET_TTL_SEC } from './profile.service';

/**
 * S73 (D14 / FR-PS-01): 전역 아바타 업로드/리셋.
 *
 *   POST   /me/avatar/presign  body: { contentType, sizeBytes } → { key, putUrl, expiresAt }
 *   PUT    /me/avatar          body: { key }                    → { avatarUrl }
 *   DELETE /me/avatar          → 204
 *
 * Fork1(Option C): 서버 리사이즈 없음([[feedback_no_server_media_resize]]). 단일 키
 * 1개를 확정하고 렌더 크기는 CSS object-fit 다운스케일로 처리한다. presign 은 별도
 * rate-limit(5/min)을 둔다(파일 업로드 토큰 남용 방지). finalize/delete 는 프로필
 * 갱신과 동일하게 me-profile rate-limit(10/min)을 공유한다.
 */
@Controller('me/avatar')
export class MeAvatarController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rate: RateLimitService,
    private readonly profile: ProfileService,
    private readonly s3: S3Service,
    private readonly gateway: RealtimeGateway,
  ) {}

  @Post('presign')
  async presign(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<AvatarPresignResult> {
    await this.rate.enforce([{ key: `me-avatar-presign:u:${user.id}`, windowSec: 60, max: 5 }]);
    const parsed = AvatarPresignInputSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'invalid avatar presign body (contentType/sizeBytes)',
      );
    }
    return this.profile.presignAvatar(user.id, parsed.data.contentType, parsed.data.sizeBytes);
  }

  @Put()
  async finalize(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<AvatarFinalizeResult> {
    await this.rate.enforce([{ key: `me-profile:u:${user.id}`, windowSec: 60, max: 10 }]);
    const parsed = AvatarFinalizeInputSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'invalid avatar finalize body (key)');
    }
    const result = await this.profile.finalizeAvatar(user.id, parsed.data.key);
    await this.broadcast(user.id);
    return result;
  }

  @Delete()
  @HttpCode(204)
  async remove(@CurrentUser() user: CurrentUserPayload): Promise<void> {
    await this.rate.enforce([{ key: `me-profile:u:${user.id}`, windowSec: 60, max: 10 }]);
    await this.profile.deleteAvatar(user.id);
    await this.broadcast(user.id);
  }

  private async broadcast(userId: string): Promise<void> {
    const [memberships, row] = await Promise.all([
      this.prisma.workspaceMember.findMany({
        where: { userId, workspace: { deletedAt: null } },
        select: { workspaceId: true },
      }),
      this.prisma.user.findUnique({
        where: { id: userId },
        // S74 (S73 carryover): displayName/avatarKey 도 함께 읽어 멤버목록 표시(아바타/
        // 이름)를 즉시 전파한다(아바타 변경 → 멤버목록 아바타 갱신).
        select: { customStatus: true, displayName: true, avatarKey: true },
      }),
    ]);
    this.gateway.broadcastUserProfileUpdate({
      userId,
      workspaceIds: memberships.map((m) => m.workspaceId),
      customStatus: row?.customStatus ?? null,
      displayName: row?.displayName ?? null,
      avatarUrl: row?.avatarKey
        ? await this.s3.presignGet(row.avatarKey, { expiresIn: PROFILE_IMAGE_GET_TTL_SEC })
        : null,
    });
  }
}
