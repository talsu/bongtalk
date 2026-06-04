import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
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

  // S67 (D13 / FR-W02·W17): 초대 생성/목록/취소는 ADMIN 이상 또는 MODERATOR 가 수행한다.
  // @Roles(MIN) 는 최소 등급 비교(WorkspaceRoleGuard)이므로 MODERATOR 로 두면 MODERATOR/
  // ADMIN/OWNER 가 통과한다. MODERATOR 의 목록/취소/삭제 범위 제한(본인 생성분)은 서비스
  // 계층에서 actorRole 로 강제한다.
  @Roles('MODERATOR')
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

  @Roles('MODERATOR')
  @Get()
  async list(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @CurrentMember() member: CurrentMemberPayload,
  ) {
    // S67 (D13 / FR-W17): MODERATOR 면 본인 생성분만, ADMIN 이상이면 전체. 서비스가
    // actorRole 로 필터링하고 usesRemaining/active/createdBy 파생값을 계산한다.
    const rows = await this.invites.list(member.workspaceId, member.userId, member.role);
    return { invites: rows.map((r) => ({ ...r, url: inviteUrl(r.code) })) };
  }

  // S67 (D13 / FR-W17): 비활성화(soft revoke) — revokedAt 을 찍는다(행 보존). 영구 삭제는
  // 아래 :inviteId/permanent.
  @Roles('MODERATOR')
  @Delete(':inviteId')
  @HttpCode(204)
  async revoke(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Param('inviteId', new ParseUUIDPipe()) inviteId: string,
    @CurrentMember() member: CurrentMemberPayload,
  ) {
    await this.invites.revoke(member.workspaceId, inviteId, member.userId, member.role);
  }

  // S67 (D13 / FR-W17 · Fork C-2): 영구 삭제(hard delete) — 행 자체를 제거한다(soft
  // revoke 와 구분되는 별도 RESTful 엔드포인트). 권한은 create/revoke 와 동일.
  @Roles('MODERATOR')
  @Delete(':inviteId/permanent')
  @HttpCode(204)
  async hardDelete(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Param('inviteId', new ParseUUIDPipe()) inviteId: string,
    @CurrentMember() member: CurrentMemberPayload,
  ) {
    await this.invites.hardDelete(member.workspaceId, inviteId, member.userId, member.role);
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
    // S67 fix-forward (security MEDIUM): per-IP(60/min) 에 더해 per-code(100/min) 버킷을
    // 추가한다 — 단일 코드를 신선한 IP 풀(봇넷)로 분산 enumeration 하는 공격을 코드 단위로
    // 막는다. main.ts trust proxy=1 덕분에 req.ip 는 실제 클라이언트 IP 다.
    await this.rateLimit.enforce([
      { key: `invite:preview:ip:${req.ip ?? 'unknown'}`, windowSec: 60, max: 60 },
      { key: `invite:preview:code:${code}`, windowSec: 60, max: 100 },
    ]);
    return this.invites.preview(code);
  }

  @Post(':code/accept')
  async accept(
    @Param('code') code: string,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Task-013-A (task-031 closure): per-user bucket protects a
    // single logged-in account from mass-probing codes; per-code
    // bucket protects a single code from being probed by a botnet of
    // fresh accounts.
    // S67 fix-forward (security MEDIUM): per-IP(60/min) 버킷을 추가한다 — 한 IP 에서 여러
    // 계정으로 코드를 난사하는 경우 per-user/per-code 가 비껴가도 IP 단위로 막는다. main.ts
    // trust proxy=1 덕분에 req.ip 는 실제 클라이언트 IP 다(없으면 'unknown' 폴백).
    await this.rateLimit.enforce([
      { key: `invite:accept:user:${user.id}`, windowSec: 60, max: 30 },
      { key: `invite:accept:code:${code}`, windowSec: 60, max: 10 },
      { key: `invite:accept:ip:${req.ip ?? 'unknown'}`, windowSec: 60, max: 60 },
    ]);
    // S66 (D13 / FR-W05a): 초대 수락 시점에 emailVerified + emailDomains 게이트를 적용한다.
    // user(JwtStrategy 가 DB 에서 매 요청 로드)에 emailVerified/email 이 실려 있으므로
    // 서비스에 그대로 넘긴다(재조회 불요).
    const result = await this.invites.accept(code, user.id, {
      emailVerified: user.emailVerified,
      userEmail: user.email,
    });
    // S67 (D13 / FR-W03): 신규 가입은 201(생성), 이미 멤버였던 멱등 수락은 200(OK)으로
    // 구분한다. 응답 바디는 두 경우 모두 { workspace, alreadyMember } — FE 가 안내 문구만
    // 분기한다.
    res.status(result.alreadyMember ? HttpStatus.OK : HttpStatus.CREATED);
    return result;
  }
}
