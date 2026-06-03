import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { UpdateUserSettingsRequestSchema } from '@qufox/shared-types';
import { UsersService } from './users.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

/**
 * S54 (D11 / FR-RS-13) — 사용자 메시지 읽음 처리 모드(markAsReadMode) 설정.
 *
 *   GET   /users/me/settings      → 현재 모드(행 없으면 AUTO_FROM_POSITION).
 *   PATCH /users/me/settings      → 모드 upsert(본인).
 *   PATCH /users/me/preferences   → 동일 동작(하위호환 deprecated alias).
 *
 * 두 PATCH 는 동일 핸들러로 처리한다. `/preferences` 는 구 클라이언트 하위호환용이며
 * 신규 클라이언트는 `/settings` 를 사용한다.
 */
@UseGuards(JwtAuthGuard)
@Controller('users/me')
export class MeSettingsController {
  constructor(private readonly users: UsersService) {}

  @Get('settings')
  async get(@CurrentUser() user: CurrentUserPayload) {
    return this.users.getSettings(user.id);
  }

  @Patch('settings')
  async update(@CurrentUser() user: CurrentUserPayload, @Body() body: unknown) {
    return this.applyUpdate(user.id, body);
  }

  /** @deprecated S54 — `/users/me/preferences` 는 `/users/me/settings` 의 하위호환 alias. */
  @Patch('preferences')
  async updateAlias(@CurrentUser() user: CurrentUserPayload, @Body() body: unknown) {
    return this.applyUpdate(user.id, body);
  }

  private async applyUpdate(userId: string, body: unknown) {
    const parsed = UpdateUserSettingsRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    return this.users.updateSettings(userId, parsed.data.markAsReadMode);
  }
}
