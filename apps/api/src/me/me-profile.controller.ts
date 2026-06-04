import { Body, Controller, Get, Patch } from '@nestjs/common';
import {
  UpdateProfileInputSchema,
  type ProfileView as ProfileViewContract,
} from '@qufox/shared-types';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { PrismaService } from '../prisma/prisma.module';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ProfileService } from './profile.service';

/**
 * S73 (D14 / FR-PS-01·02·03): 전역 프로필 read/edit.
 *
 *   GET   /me/profile  → ProfileView (id/email/username/handle/displayName/fullName/
 *                        pronouns/title/timezone/bio/handleChangedAt/avatarUrl/customStatus)
 *   PATCH /me/profile  body: UpdateProfileInput (handle/displayName/fullName/pronouns/
 *                        title/timezone/bio — 부분 갱신)
 *
 * 도메인 규칙(handle 형식·30일 쿨다운·필드 길이)은 ProfileService 가 단일 출처로 보유한다.
 * 컨트롤러는 인증(JwtAuthGuard, AppModule 전역) + rate-limit + 실시간 방송만 담당한다.
 *
 * Rate limit: 10/min/user (기존 me-profile:u:{id} 키 재사용).
 */
@Controller('me/profile')
export class MeProfileController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rate: RateLimitService,
    private readonly profile: ProfileService,
    private readonly gateway: RealtimeGateway,
  ) {}

  @Get()
  async get(@CurrentUser() user: CurrentUserPayload): Promise<ProfileViewContract> {
    return this.profile.getProfile(user.id);
  }

  @Patch()
  async patch(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<ProfileViewContract> {
    await this.rate.enforce([{ key: `me-profile:u:${user.id}`, windowSec: 60, max: 10 }]);
    // 공유 Zod 스키마로 strict parse(비-화이트리스트 필드 거부). 통과한 입력만 서비스로.
    const parsed = UpdateProfileInputSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(
        ErrorCode.VALIDATION_FAILED,
        'invalid profile body (handle/displayName/fullName/pronouns/title/timezone/bio)',
      );
    }
    const { view } = await this.profile.updateProfile(user.id, parsed.data);
    // S74 (S73 carryover): displayName/avatarUrl 도 함께 방송해 멤버목록·작성자 표시명이
    // 새로고침 없이 갱신되게 한다(view 가 이미 두 값을 보유 — 재조회 불요).
    await this.broadcast(user.id, view.customStatus, view.displayName, view.avatarUrl);
    return view;
  }

  /**
   * 프로필/아바타 변경 시 사용자의 모든 워크스페이스 룸으로 user.profile.updated 를
   * 방송한다(기존 broadcastUserProfileUpdate 재사용 — FE dispatcher 가 멤버목록 캐시의
   * displayName/avatar/상태를 패치). 빈도가 낮아 throttle 없이 raw emit.
   */
  private async broadcast(
    userId: string,
    customStatus: string | null,
    displayName: string | null,
    avatarUrl: string | null,
  ): Promise<void> {
    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId, workspace: { deletedAt: null } },
      select: { workspaceId: true },
    });
    this.gateway.broadcastUserProfileUpdate({
      userId,
      workspaceIds: memberships.map((m) => m.workspaceId),
      customStatus,
      displayName,
      avatarUrl,
    });
  }
}
