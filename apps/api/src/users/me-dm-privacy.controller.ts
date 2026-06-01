import { Body, Controller, Patch, UseGuards } from '@nestjs/common';
import { DmPrivacy } from '@prisma/client';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.module';
import { SetDmPrivacyDto } from './dto/set-dm-privacy.dto';

/**
 * S19 (FR-DM-12): DM 수신권한 토글.
 *
 *   PATCH /users/me/dm-privacy { allowDmFrom: "EVERYONE" | "WORKSPACE_MEMBER" }
 *
 * - User.allowDmFrom 을 갱신한다(me-presence PATCH 패턴 답습, JwtAuthGuard).
 * - DM 개시(createOrGetGlobal / createGroupDm) + 그룹 DM 멤버 추가(FR-DM-07)에서
 *   DirectMessagesService.assertDmPrivacyAllows 게이트가 이 값을 참조한다.
 * - FRIENDS_ONLY 는 Phase2 carryover — SetDmPrivacyDto @IsIn 화이트리스트에 없어
 *   ValidationPipe 가 400 으로 거부한다. enum 값으로도 선반영하지 않으므로 Prisma
 *   DmPrivacy 에 존재하지 않는다.
 * - HIGH fix-forward: 입력 검증은 SetDmPrivacyDto + 글로벌 ValidationPipe
 *   (whitelist / forbidNonWhitelisted)에 위임한다 — 잘못된 값/추가 필드는 400.
 */
@UseGuards(JwtAuthGuard)
@Controller('users/me')
export class MeDmPrivacyController {
  constructor(private readonly prisma: PrismaService) {}

  @Patch('dm-privacy')
  async setDmPrivacy(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: SetDmPrivacyDto,
  ): Promise<{ allowDmFrom: DmPrivacy }> {
    const allowDmFrom: DmPrivacy = body.allowDmFrom;
    await this.prisma.user.update({
      where: { id: user.id },
      data: { allowDmFrom },
    });
    return { allowDmFrom };
  }
}
