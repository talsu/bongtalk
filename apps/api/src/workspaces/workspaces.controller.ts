import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  CreateWorkspaceRequest,
  CreateWorkspaceRequestSchema,
  DeleteWorkspaceRequestSchema,
  TransferOwnershipRequest,
  TransferOwnershipRequestSchema,
  UpdateDefaultChannelRequestSchema,
  UpdateWorkspaceRequest,
  UpdateWorkspaceRequestSchema,
  UpdateWorkspaceSettingRequestSchema,
} from '@qufox/shared-types';
import { WorkspacesService } from './workspaces.service';
import { RateLimitService } from '../auth/services/rate-limit.service';
import { Roles } from './decorators/roles.decorator';
import { AllowSoftDeleted } from './decorators/allow-soft-deleted.decorator';
import { CurrentMember, CurrentMemberPayload } from './decorators/current-member.decorator';
import { WorkspaceMemberGuard } from './guards/workspace-member.guard';
import { WorkspaceRoleGuard } from './guards/workspace-role.guard';
import { CurrentUser, CurrentUserPayload } from '../auth/decorators/current-user.decorator';
import { DomainError } from '../common/errors/domain-error';
import { ErrorCode } from '../common/errors/error-code.enum';

@Controller('workspaces')
export class WorkspacesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Post()
  async create(@CurrentUser() user: CurrentUserPayload, @Body() body: unknown) {
    const parsed = CreateWorkspaceRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    // S66 fix-forward (review HIGH-3): 미인증 사용자의 워크스페이스 생성을 서버에서도
    // 차단한다(FE VerificationGate 와 대칭). emailVerified 는 JWT 검증 시 로드돼 있다.
    return this.workspaces.create(user.id, parsed.data as CreateWorkspaceRequest, {
      emailVerified: user.emailVerified,
    });
  }

  @Get()
  async listMine(@CurrentUser() user: CurrentUserPayload) {
    const workspaces = await this.workspaces.listMine(user.id);
    return { workspaces };
  }

  @Get('discover')
  async discover(
    @Query('category') category: string | undefined,
    @Query('q') q: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @Query('limit', new DefaultValuePipe(20)) limitRaw: string | number,
    @Res({ passthrough: true }) res: Response,
  ) {
    const limit = typeof limitRaw === 'string' ? Number(limitRaw) : limitRaw;
    // S72 (D13 / FR-W16): 검색 결과를 Redis 캐시로 감싼다. 서비스가 HIT/MISS 를 돌려주면
    // X-Cache 헤더로 echo 한다.
    // S72 W16 fix-forward (security MEDIUM): 이 라우트는 인증 필수다 — 글로벌
    // JwtAuthGuard(APP_GUARD)가 걸려 있고 @Public 데코레이터가 없으므로 유효 JWT 없이는
    // 401 이다. @Public 을 추가하면 비인증 DoS 표면(Redis 키 폭발 + ILIKE)이 커지므로
    // 의도적으로 인증을 유지한다(비공개 정보는 없으나 비용 보호용 게이트).
    const { payload, cacheStatus } = await this.workspaces.discover({
      category,
      q,
      cursor: cursor ?? null,
      limit: limit || 20,
    });
    res.setHeader('X-Cache', cacheStatus);
    return payload;
  }

  @Post(':id/join')
  async joinPublic(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    // task-031-B: 5/min/user on PUBLIC join (abuse mitigation — a single
    // account sweeping hundreds of public workspaces).
    await this.rateLimit.enforce([{ key: `ws:join:${user.id}`, windowSec: 60, max: 5 }]);
    // S66 (D13 / FR-W05a): PUBLIC 즉시 가입(도메인 가입)에도 emailVerified + emailDomains
    // 게이트를 적용한다(user 는 JWT 에서 로드된 emailVerified/email 보유 — 재조회 불요).
    return this.workspaces.joinPublic(id, user.id, {
      emailVerified: user.emailVerified,
      userEmail: user.email,
    });
  }

  @UseGuards(WorkspaceMemberGuard)
  @Get(':id')
  async get(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: CurrentUserPayload) {
    return this.workspaces.getWithMyRole(id, user.id);
  }

  @UseGuards(WorkspaceMemberGuard, WorkspaceRoleGuard)
  @Roles('ADMIN')
  @Patch(':id')
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentMember() member: CurrentMemberPayload,
    @Body() body: unknown,
  ) {
    const parsed = UpdateWorkspaceRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    // task-031-B: 10/hour/workspace on visibility changes only. Keep the
    // name/description PATCH path unthrottled since it's an everyday op.
    if (parsed.data.visibility !== undefined) {
      await this.rateLimit.enforce([{ key: `ws:visibility:${id}`, windowSec: 3600, max: 10 }]);
    }
    // task-030 reviewer B1: pass actor role so service can block ADMIN
    // attempts to flip visibility/category — OWNER-only.
    return this.workspaces.update(id, parsed.data as UpdateWorkspaceRequest, member.role);
  }

  /**
   * S55 (FR-AM-20): 워크스페이스 첨부 정책 조회. 멤버 누구나 읽을 수 있다(첨부 UI 가
   * 업로드 상한/차단 확장자를 표시).
   */
  @UseGuards(WorkspaceMemberGuard)
  @Get(':id/settings')
  async getSettings(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.workspaces.getSetting(id);
  }

  /**
   * S55 (FR-AM-20): 워크스페이스 첨부 정책 변경. ADMIN(+OWNER) 전용. maxFileSizeBytes
   * 와 blockedExtensions 를 upsert 한다.
   */
  @UseGuards(WorkspaceMemberGuard, WorkspaceRoleGuard)
  @Roles('ADMIN')
  @Patch(':id/settings')
  async updateSettings(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    const parsed = UpdateWorkspaceSettingRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    return this.workspaces.updateSetting(id, parsed.data);
  }

  @UseGuards(WorkspaceMemberGuard, WorkspaceRoleGuard)
  @Roles('OWNER')
  @Delete(':id')
  @HttpCode(202)
  async softDelete(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ) {
    // S72 (D13 / FR-W15): 파괴적 액션이라 body.confirmation(= slug) 타이핑 확인을 강제한다.
    // 형태는 Zod 로(confirmation: string), 실제 slug 대조는 서비스가 한다(불일치 → 422
    // WORKSPACE_CONFIRMATION_MISMATCH). 형태 오류(누락/비문자열)는 400 VALIDATION_FAILED.
    const parsed = DeleteWorkspaceRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    const result = await this.workspaces.softDelete(id, user.id, parsed.data.confirmation);
    return { deleteAt: result.deleteAt };
  }

  @UseGuards(WorkspaceMemberGuard, WorkspaceRoleGuard)
  @Roles('OWNER')
  @AllowSoftDeleted()
  @Post(':id/restore')
  async restore(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.workspaces.restore(id, user.id);
  }

  @UseGuards(WorkspaceMemberGuard, WorkspaceRoleGuard)
  @Roles('OWNER')
  @Post(':id/transfer-ownership')
  @HttpCode(200)
  async transfer(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentMember() member: CurrentMemberPayload,
    @Body() body: unknown,
  ) {
    const parsed = TransferOwnershipRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    const input = parsed.data as TransferOwnershipRequest;
    // S65 fix-forward (security A-1 = HIGH/BLOCKER): 양도는 OWNER 비밀번호 재확인을
    // 강제하므로(FR-W13) 이 엔드포인트는 비밀번호 brute-force 표면이다 — 게다가 양도는
    // 비가역적 권한 이전이라 단 한 번의 추측 성공도 치명적이다. ws:join(5/min/user)
    // 패턴을 재사용하되 더 좁은 5회/5분/OWNER 윈도우로 무차별 대입 시도를 제한한다.
    await this.rateLimit.enforce([{ key: `ws:transfer:${member.userId}`, windowSec: 300, max: 5 }]);
    // S65 (D13 / FR-W13): password 재확인을 서비스로 전달한다(argon2 verify).
    return this.workspaces.transferOwnership(id, member.userId, input.toUserId, input.password);
  }

  /**
   * S65 (D13 / FR-W19): 워크스페이스 기본 채널 변경. OWNER 전용. 대상은 같은
   * 워크스페이스의 살아있는 공개 채널이어야 하며(서비스 검증), 이전 기본 채널의
   * isDefault 해제 + 신규 채널 isDefault 설정 + Workspace.defaultChannelId 갱신을
   * 단일 트랜잭션으로 처리한다.
   */
  @UseGuards(WorkspaceMemberGuard, WorkspaceRoleGuard)
  @Roles('OWNER')
  @Patch(':id/default-channel')
  async updateDefaultChannel(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown) {
    const parsed = UpdateDefaultChannelRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    return this.workspaces.updateDefaultChannel(id, parsed.data.defaultChannelId);
  }
}
