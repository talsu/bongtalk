// task-078 P2-acl: SSO RP 접근 승인 관리 API(관리자 전용). qufox 관리 UI 가 호출한다.
// 전역 JwtAuthGuard(인증) + SsoAdminGuard(관리자) 이중 게이트. nginx /api strip → 외부 경로는
// /api/admin/sso/...
import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsEmail } from 'class-validator';
import { PrismaService } from '../prisma/prisma.module';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ssoAdminEmails } from './oidc-config';
import { SsoAdminGuard } from './sso-admin.guard';

class GrantAccessDto {
  @IsEmail()
  email!: string;
}

@UseGuards(SsoAdminGuard)
@Controller('admin/sso')
export class OidcAdminController {
  constructor(private readonly prisma: PrismaService) {}

  // RP(client) 목록 + 각 승인자 수. (admin 은 별도 표식 없이 항상 허용임을 UI 가 안내.)
  @Get('clients')
  async clients(): Promise<unknown> {
    const rows = await this.prisma.oAuthClient.findMany({
      orderBy: { clientId: 'asc' },
      select: { clientId: true, name: true, enabled: true },
    });
    const counts = await this.prisma.oAuthClientAccess.groupBy({
      by: ['clientId'],
      _count: { _all: true },
    });
    const countMap = new Map(counts.map((c) => [c.clientId, c._count._all]));
    return {
      adminEmails: ssoAdminEmails(),
      clients: rows.map((r) => ({ ...r, accessCount: countMap.get(r.clientId) ?? 0 })),
    };
  }

  // 특정 RP 의 승인된 사용자 목록(이메일/유저네임 join).
  @Get('clients/:clientId/access')
  async listAccess(@Param('clientId') clientId: string): Promise<unknown> {
    const rows = await this.prisma.oAuthClientAccess.findMany({
      where: { clientId },
      orderBy: { createdAt: 'asc' },
    });
    const users = await this.prisma.user.findMany({
      where: { id: { in: rows.map((r) => r.userId) } },
      select: { id: true, email: true, username: true },
    });
    const userMap = new Map(users.map((u) => [u.id, u]));
    return {
      access: rows.map((r) => ({
        userId: r.userId,
        email: userMap.get(r.userId)?.email ?? null,
        username: userMap.get(r.userId)?.username ?? null,
        createdAt: r.createdAt,
      })),
    };
  }

  // 이메일로 RP 접근 승인(이메일→userId 해석 후 행 추가, 멱등).
  @Post('clients/:clientId/access')
  async grant(
    @Param('clientId') clientId: string,
    @Body() body: GrantAccessDto,
    @CurrentUser() admin: { id: string },
  ): Promise<unknown> {
    const client = await this.prisma.oAuthClient.findUnique({ where: { clientId } });
    if (!client) {
      throw new NotFoundException('unknown client');
    }
    const user = await this.prisma.user.findFirst({
      where: { email: { equals: body.email.trim(), mode: 'insensitive' } },
      select: { id: true, email: true, username: true },
    });
    if (!user) {
      throw new NotFoundException('no qufox account with that email');
    }
    await this.prisma.oAuthClientAccess.upsert({
      where: { clientId_userId: { clientId, userId: user.id } },
      create: { clientId, userId: user.id, createdBy: admin.id },
      update: {},
    });
    return { ok: true, userId: user.id, email: user.email, username: user.username };
  }

  // RP 접근 승인 해제.
  @Delete('clients/:clientId/access/:userId')
  async revoke(
    @Param('clientId') clientId: string,
    @Param('userId') userId: string,
  ): Promise<unknown> {
    await this.prisma.oAuthClientAccess.deleteMany({ where: { clientId, userId } });
    return { ok: true };
  }
}
