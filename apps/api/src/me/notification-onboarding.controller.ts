import { Controller, Get, Patch } from '@nestjs/common';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.module';

/**
 * task-046 iter4 (K4): 첫 알림 onboarding 노출 여부.
 *
 *   GET   /me/notification-onboarding  → { shown: boolean }
 *   PATCH /me/notification-onboarding         → { shown: true } (idempotent)
 *
 * UI 가 첫 알림 발생 시점에 GET 으로 상태 확인 → false 면 onboarding
 * modal 노출 → 사용자가 dismiss 시 PATCH 로 true 로 set → 다시는
 * 노출되지 않음.
 */
@Controller('me/notification-onboarding')
export class NotificationOnboardingController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async get(@CurrentUser() user: CurrentUserPayload): Promise<{ shown: boolean }> {
    const row = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { notificationOnboardingShown: true },
    });
    return { shown: row?.notificationOnboardingShown ?? false };
  }

  @Patch()
  async markShown(@CurrentUser() user: CurrentUserPayload): Promise<{ shown: true }> {
    await this.prisma.user.update({
      where: { id: user.id },
      data: { notificationOnboardingShown: true },
    });
    return { shown: true };
  }
}
