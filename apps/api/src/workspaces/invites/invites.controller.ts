import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { CreateInviteRequest, CreateInviteRequestSchema } from '@qufox/shared-types';
import { InvitesService } from './invites.service';
import { Roles } from '../decorators/roles.decorator';
import { WorkspaceMemberGuard } from '../guards/workspace-member.guard';
import { WorkspaceRoleGuard } from '../guards/workspace-role.guard';
import { CurrentMember, CurrentMemberPayload } from '../decorators/current-member.decorator';
import { Public } from '../../auth/decorators/public.decorator';
import { CurrentUser, CurrentUserPayload } from '../../auth/decorators/current-user.decorator';
import { RateLimitService } from '../../auth/services/rate-limit.service';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';

function inviteUrl(code: string): string {
  const base = process.env.WEB_URL ?? 'http://localhost:45173';
  return `${base}/invite/${code}`;
}

@UseGuards(WorkspaceMemberGuard, WorkspaceRoleGuard)
@Controller('workspaces/:id/invites')
export class WorkspaceInvitesController {
  constructor(
    private readonly invites: InvitesService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Roles('ADMIN')
  @Post()
  async create(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @CurrentMember() member: CurrentMemberPayload,
    @Body() body: unknown,
  ) {
    await this.rateLimit.enforce([
      { key: `invite:create:ws:${member.workspaceId}`, windowSec: 60, max: 10 },
    ]);
    const parsed = CreateInviteRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    const invite = await this.invites.create(
      member.workspaceId,
      member.userId,
      parsed.data as CreateInviteRequest,
    );
    return { invite: { ...invite, url: inviteUrl(invite.code) }, url: inviteUrl(invite.code) };
  }

  @Roles('ADMIN')
  @Get()
  async list(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @CurrentMember() member: CurrentMemberPayload,
  ) {
    const rows = await this.invites.list(member.workspaceId);
    return { invites: rows.map((r) => ({ ...r, url: inviteUrl(r.code) })) };
  }

  @Roles('ADMIN')
  @Delete(':inviteId')
  @HttpCode(204)
  async revoke(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Param('inviteId', new ParseUUIDPipe()) inviteId: string,
    @CurrentMember() member: CurrentMemberPayload,
  ) {
    await this.invites.revoke(member.workspaceId, inviteId, member.userId);
  }
}

@Controller('invites')
export class PublicInvitesController {
  constructor(
    private readonly invites: InvitesService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Public()
  @Get(':code')
  async preview(@Param('code') code: string, @Req() req: Request) {
    await this.rateLimit.enforce([
      { key: `invite:preview:ip:${req.ip ?? 'unknown'}`, windowSec: 60, max: 60 },
    ]);
    return this.invites.preview(code);
  }

  @Post(':code/accept')
  async accept(@Param('code') code: string, @CurrentUser() user: CurrentUserPayload) {
    // TODO(task-011): add a second rate-limit bucket keyed on the invite
    // `code` itself (not just the user) so a botnet of fresh accounts
    // can't brute-force a single invite by rotating user ids.
    await this.rateLimit.enforce([
      { key: `invite:accept:user:${user.id}`, windowSec: 60, max: 30 },
    ]);
    const workspace = await this.invites.accept(code, user.id);
    return { workspace };
  }
}
