import { Body, Controller, Delete, HttpCode, Post, Put } from '@nestjs/common';
import {
  BannerPresignInputSchema,
  BannerFinalizeInputSchema,
  type BannerPresignResult,
  type BannerFinalizeResult,
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
 * S74 (D14 / FR-PS-04): 전역 프로필 배너 업로드/제거.
 *
 *   POST   /me/banner/presign  body: { contentType, sizeBytes } → { key, url, fields, expiresAt }
 *   PUT    /me/banner          body: { key }                    → { bannerUrl }
 *   DELETE /me/banner          → 204
 *
 * 아바타(MeAvatarController)와 동일 패턴: presigned POST(MinIO 가 크기/MIME 강제) +
 * finalize 의 magic-byte 사후검증 + key traversal 거부 + best-effort orphan 정리.
 * presign 은 별도 rate-limit(5/min), finalize/delete 는 me-profile rate-limit(10/min) 공유.
 */
@Controller('me/banner')
export class MeBannerController {
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
  ): Promise<BannerPresignResult> {
    await this.rate.enforce([{ key: `me-banner-presign:u:${user.id}`, windowSec: 60, max: 5 }]);
    const parsed = BannerPresignInputSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'invalid banner presign body (contentType/sizeBytes)',
      );
    }
    return this.profile.presignBanner(user.id, parsed.data.contentType, parsed.data.sizeBytes);
  }

  @Put()
  async finalize(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<BannerFinalizeResult> {
    await this.rate.enforce([{ key: `me-profile:u:${user.id}`, windowSec: 60, max: 10 }]);
    const parsed = BannerFinalizeInputSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'invalid banner finalize body (key)');
    }
    const result = await this.profile.finalizeBanner(user.id, parsed.data.key);
    await this.broadcast(user.id);
    return result;
  }

  @Delete()
  @HttpCode(204)
  async remove(@CurrentUser() user: CurrentUserPayload): Promise<void> {
    await this.rate.enforce([{ key: `me-profile:u:${user.id}`, windowSec: 60, max: 10 }]);
    await this.profile.deleteBanner(user.id);
    await this.broadcast(user.id);
  }

  /**
   * 배너 변경은 멤버목록 표시(아바타/이름)와 무관하지만, 전역 프로필 변경 fanout 의
   * 일관성을 위해 customStatus + displayName + avatarUrl 을 함께 방송한다(profile.updated).
   * 배너 자체는 프로필 패널(S75)에서 다시 fetch 하므로 별도 payload 불요.
   */
  private async broadcast(userId: string): Promise<void> {
    const [memberships, row] = await Promise.all([
      this.prisma.workspaceMember.findMany({
        where: { userId, workspace: { deletedAt: null } },
        select: { workspaceId: true },
      }),
      this.prisma.user.findUnique({
        where: { id: userId },
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
