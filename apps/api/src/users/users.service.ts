import { Injectable } from '@nestjs/common';
import type { MarkAsReadMode } from '@prisma/client';
import type { UserSettingsResponse } from '@qufox/shared-types';
import { PrismaService } from '../prisma/prisma.module';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * S54 (D11 / FR-RS-13): 본인 메시지 읽음 처리 모드 조회. UserSettings 행이 없으면
   * 기본 AUTO_FROM_POSITION 폴백(backfill 불요).
   */
  async getSettings(userId: string): Promise<UserSettingsResponse> {
    const row = await this.prisma.userSettings.findUnique({
      where: { userId },
      select: { markAsReadMode: true },
    });
    return { markAsReadMode: row?.markAsReadMode ?? 'AUTO_FROM_POSITION' };
  }

  /**
   * S54 (D11 / FR-RS-13): 본인 읽음 처리 모드 upsert. 다른 UserSettings 필드(알림 등)는
   * 보존한다(upsert 의 update 가 markAsReadMode 만 건드림). 행이 없으면 생성.
   */
  async updateSettings(
    userId: string,
    markAsReadMode: MarkAsReadMode,
  ): Promise<UserSettingsResponse> {
    await this.prisma.userSettings.upsert({
      where: { userId },
      update: { markAsReadMode },
      create: { userId, markAsReadMode },
    });
    return this.getSettings(userId);
  }

  findById(id: string) {
    return this.prisma.user.findUnique({ where: { id } });
  }

  findByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email } });
  }

  findByUsername(username: string) {
    return this.prisma.user.findUnique({ where: { username } });
  }

  create(input: { id: string; email: string; username: string; passwordHash: string }) {
    return this.prisma.user.create({ data: input });
  }

  updateLoginSuccess(id: string) {
    return this.prisma.user.update({
      where: { id },
      data: { lastLoginAt: new Date(), failedLoginAttempts: 0, lockedUntil: null },
    });
  }

  async registerFailedLogin(id: string, lockAfter: number, lockForMs: number) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) return null;
    const attempts = user.failedLoginAttempts + 1;
    const lockedUntil = attempts >= lockAfter ? new Date(Date.now() + lockForMs) : null;
    return this.prisma.user.update({
      where: { id },
      data: { failedLoginAttempts: attempts, lockedUntil },
    });
  }
}
