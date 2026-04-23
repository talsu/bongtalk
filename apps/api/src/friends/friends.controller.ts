import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';
import { FriendsService, type FriendRow, type FriendsFilter } from './friends.service';

function normalizeFilter(raw: string | undefined): FriendsFilter {
  if (
    raw === 'accepted' ||
    raw === 'pending_incoming' ||
    raw === 'pending_outgoing' ||
    raw === 'blocked'
  ) {
    return raw;
  }
  return 'accepted';
}

@UseGuards(JwtAuthGuard)
@Controller('me/friends')
export class FriendsController {
  constructor(
    private readonly svc: FriendsService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: CurrentUserPayload,
    @Query('status') status: string | undefined,
  ): Promise<{ items: FriendRow[] }> {
    const items = await this.svc.list(user.id, normalizeFilter(status));
    return { items };
  }

  @Post('requests')
  async request(@CurrentUser() user: CurrentUserPayload, @Body() body: { username?: string }) {
    if (!body?.username) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, 'username is required');
    }
    await this.rateLimit.enforce([{ key: `fr:req:${user.id}`, windowSec: 60, max: 10 }]);
    return this.svc.requestByUsername(user.id, body.username);
  }

  @Post(':id/accept')
  async accept(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.svc.accept(user.id, id);
  }

  @Post(':id/reject')
  @HttpCode(204)
  async reject(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.svc.reject(user.id, id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.svc.remove(user.id, id);
  }

  @Post('block/:userId')
  async block(
    @CurrentUser() user: CurrentUserPayload,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ) {
    await this.rateLimit.enforce([{ key: `fr:block:${user.id}`, windowSec: 60, max: 5 }]);
    return this.svc.block(user.id, userId);
  }

  @Delete('block/:userId')
  @HttpCode(204)
  async unblock(
    @CurrentUser() user: CurrentUserPayload,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ): Promise<void> {
    await this.svc.unblock(user.id, userId);
  }
}
