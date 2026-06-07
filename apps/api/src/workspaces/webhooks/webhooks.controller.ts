import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CreateWebhookRequestSchema } from '@qufox/shared-types';
import { WebhooksService } from './webhooks.service';
import { Roles } from '../decorators/roles.decorator';
import { WorkspaceMemberGuard } from '../guards/workspace-member.guard';
import { WorkspaceRoleGuard } from '../guards/workspace-role.guard';
import { CurrentMember, CurrentMemberPayload } from '../decorators/current-member.decorator';
import { CurrentUser, CurrentUserPayload } from '../../auth/decorators/current-user.decorator';
import { RateLimitService } from '../../auth/services/rate-limit.service';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';

/**
 * S84a (D16 / FR-RC11) — 인커밍 웹훅 관리 REST.
 *
 * 생성/목록/회전/삭제는 MANAGE_WEBHOOKS 권한 보유자(= 현재 ADMIN 이상)만 가능하다.
 * 워크스페이스 커스텀 롤의 MANAGE_WEBHOOKS(0x0200) 비트 집행은 S62 권한 배선
 * 과제의 일부라 본 슬라이스는 @Roles('ADMIN') 게이트로 보호한다(roles.controller
 * 선례 — 커스텀 롤 권한 fold 도입 시 이 게이트만 교체).
 *
 * 토큰 평문은 create/rotate 응답에서만 1회 노출되고 list 는 메타만 반환한다.
 */
@UseGuards(WorkspaceMemberGuard, WorkspaceRoleGuard)
@Controller('workspaces/:id/webhooks')
export class WebhooksController {
  constructor(
    private readonly webhooks: WebhooksService,
    private readonly rateLimit: RateLimitService,
  ) {}

  // 웹훅 생성/회전/삭제(쓰기)에 per-workspace rate-limit(60초당 20회). 토큰 발급
  // 폭주를 막는다(roles.controller 선례). 읽기(GET)는 제외.
  private async enforceMutateLimit(workspaceId: string): Promise<void> {
    await this.rateLimit.enforce([
      { key: `webhook:mutate:ws:${workspaceId}`, windowSec: 60, max: 20 },
    ]);
  }

  @Get()
  async list(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @CurrentMember() member: CurrentMemberPayload,
  ) {
    return this.webhooks.list(member.workspaceId);
  }

  @Roles('ADMIN')
  @Post()
  async create(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @CurrentMember() member: CurrentMemberPayload,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ) {
    await this.enforceMutateLimit(member.workspaceId);
    const parsed = CreateWebhookRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    return this.webhooks.create(member.workspaceId, user.id, parsed.data);
  }

  @Roles('ADMIN')
  @Post(':webhookId/rotate')
  async rotate(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Param('webhookId', new ParseUUIDPipe()) webhookId: string,
    @CurrentMember() member: CurrentMemberPayload,
  ) {
    await this.enforceMutateLimit(member.workspaceId);
    return this.webhooks.rotate(member.workspaceId, webhookId);
  }

  @Roles('ADMIN')
  @Delete(':webhookId')
  @HttpCode(204)
  async revoke(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Param('webhookId', new ParseUUIDPipe()) webhookId: string,
    @CurrentMember() member: CurrentMemberPayload,
  ) {
    await this.enforceMutateLimit(member.workspaceId);
    await this.webhooks.revoke(member.workspaceId, webhookId);
  }
}
