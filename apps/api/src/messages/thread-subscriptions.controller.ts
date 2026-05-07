import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { ThreadSubscriptionsService } from './thread-subscriptions.service';

/**
 * task-046 iter6 (N1):
 *   POST   /messages/:messageId/subscribe   — follow toggle on
 *   DELETE /messages/:messageId/subscribe   — follow toggle off
 *   GET    /messages/:messageId/subscribe   — { subscribed: bool }
 *
 * messageId 는 thread root (parentMessageId === null) 여야 함. reply 에
 * 호출 시 VALIDATION_FAILED.
 *
 * 채널 access guard 는 별도 — thread 가 속한 채널을 읽을 수 있는
 * 사용자만 follow 가능. 본 controller 는 JwtAuthGuard 만 (권한 체크는
 * service 가 root 존재로 enforce, 다중 layer 는 follow-up).
 */
@UseGuards(JwtAuthGuard)
@Controller('messages/:messageId/subscribe')
export class ThreadSubscriptionsController {
  constructor(private readonly svc: ThreadSubscriptionsService) {}

  @Get()
  async get(
    @CurrentUser() user: CurrentUserPayload,
    @Param('messageId', new ParseUUIDPipe()) messageId: string,
  ): Promise<{ subscribed: boolean }> {
    const subscribed = await this.svc.isSubscribed(user.id, messageId);
    return { subscribed };
  }

  @Post()
  @HttpCode(200)
  async subscribe(
    @CurrentUser() user: CurrentUserPayload,
    @Param('messageId', new ParseUUIDPipe()) messageId: string,
  ): Promise<{ subscribed: true; createdAt: string }> {
    const r = await this.svc.subscribe({ userId: user.id, threadParentId: messageId });
    return { subscribed: true, createdAt: r.createdAt.toISOString() };
  }

  @Delete()
  @HttpCode(204)
  async unsubscribe(
    @CurrentUser() user: CurrentUserPayload,
    @Param('messageId', new ParseUUIDPipe()) messageId: string,
  ): Promise<void> {
    await this.svc.unsubscribe({ userId: user.id, threadParentId: messageId });
  }
}
