import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  AcceptEmailInviteRequestSchema,
  ExchangeEmailInviteRequestSchema,
  InviteByEmailRequestSchema,
  UpdatePendingInviteRequestSchema,
} from '@qufox/shared-types';
import { PendingInvitesService } from './pending-invites.service';
import { Roles } from '../decorators/roles.decorator';
import { WorkspaceMemberGuard } from '../guards/workspace-member.guard';
import { WorkspaceRoleGuard } from '../guards/workspace-role.guard';
import { CurrentMember, CurrentMemberPayload } from '../decorators/current-member.decorator';
import { CurrentUser, CurrentUserPayload } from '../../auth/decorators/current-user.decorator';
import { Public } from '../../auth/decorators/public.decorator';
import { RateLimitService } from '../../auth/services/rate-limit.service';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { UseGuards } from '@nestjs/common';

/**
 * S68 (D13 / FR-W04·W18): 워크스페이스 관리자용 이메일 초대/보류 관리. ADMIN 이상 게이트
 * (@Roles('ADMIN') — WorkspaceRoleGuard 최소등급 비교). 경로는 기존 invites 컨트롤러와
 * 동일하게 :id(UUID) 를 쓴다.
 */
@UseGuards(WorkspaceMemberGuard, WorkspaceRoleGuard)
@Controller('workspaces/:id')
export class WorkspacePendingInvitesController {
  constructor(
    private readonly pending: PendingInvitesService,
    private readonly rateLimit: RateLimitService,
  ) {}

  // FR-W04: 이메일 직접 초대(최대 50). ADMIN 이상.
  @Roles('ADMIN')
  @Post('invite-by-email')
  @HttpCode(200)
  async inviteByEmail(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @CurrentMember() member: CurrentMemberPayload,
    @Body() body: unknown,
  ) {
    // 대량 발송 abuse 완화 — 워크스페이스당 분당 5배치(배치 1건 = 최대 50 이메일).
    // S68 fix-forward (security MEDIUM-4): 워크스페이스 한도에 더해 초대자(user)별 시간당
    // 한도(10배치/시간)도 건다. 한 사용자가 여러 워크스페이스를 만들어 ws 한도를 우회하며
    // 메일을 다발 발송하는 abuse 를 막는다. per-target(`email-invite:target:{email}`) 한도는
    // SMTP 실발송 도입 슬라이스로 carryover(Console stub 단계에선 실 메일이 안 나가므로 보류).
    await this.rateLimit.enforce([
      { key: `email-invite:ws:${member.workspaceId}`, windowSec: 60, max: 5 },
      { key: `email-invite:user:${member.userId}`, windowSec: 3600, max: 10 },
    ]);
    const parsed = InviteByEmailRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    return this.pending.inviteByEmail(
      member.workspaceId,
      member.userId,
      parsed.data.emails,
      parsed.data.role,
    );
  }

  // FR-W18: 보류 초대 목록(ADMIN+).
  @Roles('ADMIN')
  @Get('pending-invites')
  async listPending(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @CurrentMember() member: CurrentMemberPayload,
  ) {
    const pending = await this.pending.listPending(member.workspaceId);
    return { pending };
  }

  // FR-W18: 개별 보류 초대 연장(+30일)/재발송.
  @Roles('ADMIN')
  @Patch('pending-invites/:pendingId')
  @HttpCode(204)
  async updatePending(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Param('pendingId', new ParseUUIDPipe()) pendingId: string,
    @CurrentMember() member: CurrentMemberPayload,
    @Body() body: unknown,
  ) {
    const parsed = UpdatePendingInviteRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    if (parsed.data.action === 'EXTEND') {
      await this.pending.extendPending(member.workspaceId, pendingId);
    } else {
      // RESEND 는 메일을 다시 보내므로 워크스페이스당 분당 한도를 건다.
      await this.rateLimit.enforce([
        { key: `email-invite-resend:ws:${member.workspaceId}`, windowSec: 60, max: 10 },
      ]);
      await this.pending.resendPending(member.workspaceId, pendingId);
    }
  }

  // FR-W18: 보류 초대 취소(soft).
  @Roles('ADMIN')
  @Delete('pending-invites/:pendingId')
  @HttpCode(204)
  async cancelPending(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Param('pendingId', new ParseUUIDPipe()) pendingId: string,
    @CurrentMember() member: CurrentMemberPayload,
  ) {
    await this.pending.cancelPending(member.workspaceId, pendingId);
  }
}

/**
 * S68 (D13 / FR-W04a): 수락/교환 경로. 수락자는 아직 멤버가 아니므로 WorkspaceMemberGuard
 * 를 걸 수 없다 — 워크스페이스는 토큰(sha256 단건 조회)이 결정한다. 경로의 :slug 는
 * 안내/표시용이며 권위는 토큰이다.
 *
 * S68 fix-forward (security HIGH-1): exchange 는 익명(미가입) 사용자가 호출하는 경로다
 * (분기① — rawToken 을 opaque 로 교환한 뒤 회원가입으로 보낸다). 전역 JwtAuthGuard 가
 * 걸려 있어 종전엔 익명 호출이 401 로 튕겨 분기①이 100% 동작하지 않았다. rawToken 은
 * 256bit credential 이라 그 자체가 인증 토큰처럼 작동하므로 익명 교환은 안전하다 → @Public.
 * accept/accept-opaque 는 로그인 사용자(가입 후/로그인 후)가 호출하므로 인증을 유지한다.
 */
@Controller('workspaces/:slug')
export class EmailInviteAcceptController {
  constructor(
    private readonly pending: PendingInvitesService,
    private readonly rateLimit: RateLimitService,
  ) {}

  // FR-W04a 분기 ①: rawToken → 단기 opaque 코드 교환(회원가입 리다이렉트용). 익명 호출 경로.
  @Public()
  @Post('exchange-invite-token')
  @HttpCode(200)
  async exchange(@Param('slug') _slug: string, @Req() req: Request, @Body() body: unknown) {
    // S68 fix-forward (security HIGH-1): 익명 경로라 user 키가 없다 → IP 전용 rate-limit.
    await this.rateLimit.enforce([
      { key: `email-invite:exchange:ip:${req.ip ?? 'unknown'}`, windowSec: 60, max: 60 },
    ]);
    const parsed = ExchangeEmailInviteRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    // rawToken 은 바디(쿼리/path 아님)로 들어오므로 URL/리퍼러 누출이 없다. Referrer-Policy
    // 는 helmet 전역 미들웨어가 적용한다(여기서 res.setHeader 로 별도 설정하지 않음 — N2 정정).
    return this.pending.exchangeToken(parsed.data.token);
  }

  // FR-W04a 분기 ②③: rawToken 직접 수락(로그인 사용자).
  @Post('accept-email-invite')
  async accept(
    @Param('slug') _slug: string,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    await this.rateLimit.enforce([
      { key: `email-invite:accept:user:${user.id}`, windowSec: 60, max: 30 },
      { key: `email-invite:accept:ip:${req.ip ?? 'unknown'}`, windowSec: 60, max: 60 },
    ]);
    const parsed = AcceptEmailInviteRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    // S72 (D13 / FR-W22): trust proxy=1 덕분에 req.ip 는 실 클라이언트 IP — IP soft-block
    // 대조 + 가입 ipHash 기록에 그대로 넘긴다(rate-limit 키와 동일 소스).
    const result = await this.pending.acceptByToken(parsed.data.token, {
      userId: user.id,
      userEmail: user.email,
      emailVerified: user.emailVerified,
      clientIp: req.ip,
    });
    res.status(result.alreadyMember ? HttpStatus.OK : HttpStatus.CREATED);
    return result;
  }

  // FR-W04a 분기 ①(가입 후): opaque 코드로 자동 수락.
  @Post('accept-email-invite-opaque')
  async acceptOpaque(
    @Param('slug') _slug: string,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: unknown,
  ) {
    await this.rateLimit.enforce([
      { key: `email-invite:accept:user:${user.id}`, windowSec: 60, max: 30 },
      { key: `email-invite:accept:ip:${req.ip ?? 'unknown'}`, windowSec: 60, max: 60 },
    ]);
    const parsed = ExchangeEmailInviteRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    // S72 (D13 / FR-W22): trust proxy=1 덕분에 req.ip 는 실 클라이언트 IP — IP soft-block.
    const result = await this.pending.acceptByOpaque(parsed.data.token, {
      userId: user.id,
      userEmail: user.email,
      emailVerified: user.emailVerified,
      clientIp: req.ip,
    });
    res.status(result.alreadyMember ? HttpStatus.OK : HttpStatus.CREATED);
    return result;
  }
}
