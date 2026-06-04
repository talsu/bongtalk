import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  ProcessApplicationRequestSchema,
  SubmitApplicationRequestSchema,
  ApplicationStatusSchema,
  type ListApplicationsResponse,
  type MyApplicationResponse,
  type WorkspaceMemberApplication,
} from '@qufox/shared-types';
import { ApplicationStatus } from '@prisma/client';
import { ApplicationsService } from './applications.service';
import { CurrentUser, CurrentUserPayload } from '../../auth/decorators/current-user.decorator';
import { RateLimitService } from '../../auth/services/rate-limit.service';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { PrismaService } from '../../prisma/prisma.module';
import { ROLE_RANK, type WorkspaceRole as SharedWorkspaceRole } from '@qufox/shared-types';

/**
 * S70 (D13 / FR-W06·W06a): 가입 신청(APPLY 모드) REST. 경로는 PRD 정본대로 :slug 를 쓴다.
 *
 * 신청 제출(POST)·본인 상태(GET me)·취소(DELETE)는 **비멤버 신청자**가 호출하므로
 * WorkspaceMemberGuard 를 걸 수 없다(EmailInviteAcceptController 선례 — 워크스페이스는
 * slug 로 서비스가 해석). 목록(GET)·처리(PATCH)는 ADMIN+(reject 만 MODERATOR+) 권한이
 * 필요하므로 컨트롤러가 slug→멤버십·역할을 직접 조회해 게이트한다(가드 대신). 전역
 * JwtAuthGuard 가 인증은 보장한다.
 */
@Controller('workspaces/:slug/applications')
export class ApplicationsController {
  constructor(
    private readonly applications: ApplicationsService,
    private readonly prisma: PrismaService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** FR-W06: 가입 신청 제출. 이미 신청 중이면 409. abuse 완화 per-user rate-limit. */
  @Post()
  @HttpCode(201)
  async submit(
    @Param('slug') slug: string,
    @CurrentUser() user: CurrentUserPayload,
    @Req() req: Request,
    @Body() body: unknown,
  ): Promise<WorkspaceMemberApplication> {
    // N4: 형식 검증을 rate-limit 보다 먼저 한다 — 불량 페이로드가 abuse 한도를 소진하지 않게.
    const parsed = SubmitApplicationRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    await this.rateLimit.enforce([{ key: `ws:apply:${user.id}`, windowSec: 60, max: 5 }]);
    // S72 (D13 / FR-W22): trust proxy=1 덕분에 req.ip 는 실 클라이언트 IP — APPLY IP
    // soft-block 대조(차단 IP → 403)에 그대로 넘긴다.
    return this.applications.submit({
      slug,
      applicant: {
        userId: user.id,
        emailVerified: user.emailVerified,
        userEmail: user.email,
        clientIp: req.ip,
      },
      answers: parsed.data.answers,
    });
  }

  /** FR-W06: 신청 목록(ADMIN+). status 필터 선택. */
  @Get()
  async list(
    @Param('slug') slug: string,
    @CurrentUser() user: CurrentUserPayload,
    @Query('status') statusRaw: string | undefined,
  ): Promise<ListApplicationsResponse> {
    const { workspaceId } = await this.assertAdmin(slug, user.id);
    let status: ApplicationStatus | undefined;
    if (statusRaw !== undefined) {
      const parsed = ApplicationStatusSchema.safeParse(statusRaw);
      if (!parsed.success) {
        throw new DomainError(ErrorCode.VALIDATION_FAILED, 'invalid status filter');
      }
      status = parsed.data as ApplicationStatus;
    }
    const applications = await this.applications.list({ workspaceId, status });
    return { applications };
  }

  /** FR-W06a: 본인 신청 상태 조회(polling fallback). 멤버 여부 무관(비멤버 신청자도 호출). */
  @Get('me')
  async me(
    @Param('slug') slug: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<MyApplicationResponse> {
    const workspaceId = await this.resolveWorkspaceId(slug);
    const application = await this.applications.myApplication(workspaceId, user.id);
    return { application };
  }

  /** FR-W06: 신청 처리. {action: approve|reject|interview}. approve/interview 는 ADMIN+. */
  @Patch(':id')
  async process(
    @Param('slug') slug: string,
    @Param('id', new ParseUUIDPipe()) applicationId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<WorkspaceMemberApplication> {
    const parsed = ProcessApplicationRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    // reject 는 MODERATOR+, approve/interview 는 서비스가 ADMIN+ 를 재검증한다. 컨트롤러는
    // 최소 MODERATOR 멤버임을 보장하고 actorRole 을 서비스로 넘긴다.
    const { workspaceId, role } = await this.assertModerator(slug, user.id);
    // security L-3/N3: per-actor 한도 — 종전 `ws:apply:process:${workspaceId}` 는 여러 ADMIN
    // 이 한 워크스페이스 한도를 공유해, 한 명이 한도를 소진하면 다른 ADMIN 도 막혔다. actorId 를
    // 키에 더해 행위자별 한도로 분리한다.
    await this.rateLimit.enforce([
      { key: `ws:apply:process:${workspaceId}:${user.id}`, windowSec: 60, max: 60 },
    ]);
    return this.applications.process({
      workspaceId,
      applicationId,
      actorId: user.id,
      actorRole: role,
      action: parsed.data.action,
      reviewNote: parsed.data.reviewNote,
    });
  }

  /** FR-W06: 신청 취소(본인, PENDING 만 → WITHDRAWN). */
  @Delete(':id')
  async withdraw(
    @Param('slug') slug: string,
    @Param('id', new ParseUUIDPipe()) applicationId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<WorkspaceMemberApplication> {
    const workspaceId = await this.resolveWorkspaceId(slug);
    return this.applications.withdraw({ workspaceId, applicationId, userId: user.id });
  }

  // ── 내부 헬퍼 ───────────────────────────────────────────────────────────────

  /** slug → workspaceId(미존재/soft-delete 는 중립 404). */
  private async resolveWorkspaceId(slug: string): Promise<string> {
    const ws = await this.prisma.workspace.findUnique({
      where: { slug },
      select: { id: true, deletedAt: true },
    });
    if (!ws || ws.deletedAt) {
      throw new DomainError(ErrorCode.WORKSPACE_NOT_FOUND, 'workspace not found');
    }
    return ws.id;
  }

  /** ADMIN+ 게이트(목록 조회). 비멤버/하위 역할은 거부. */
  private async assertAdmin(slug: string, userId: string): Promise<{ workspaceId: string }> {
    const { workspaceId, role } = await this.loadMember(slug, userId);
    if (ROLE_RANK[role] < ROLE_RANK.ADMIN) {
      throw new DomainError(ErrorCode.APPLICATION_FORBIDDEN, 'ADMIN role required');
    }
    return { workspaceId };
  }

  /** MODERATOR+ 게이트(처리 진입). approve/interview 의 ADMIN+ 재검증은 서비스가 한다. */
  private async assertModerator(
    slug: string,
    userId: string,
  ): Promise<{ workspaceId: string; role: SharedWorkspaceRole }> {
    const { workspaceId, role } = await this.loadMember(slug, userId);
    if (ROLE_RANK[role] < ROLE_RANK.MODERATOR) {
      throw new DomainError(ErrorCode.APPLICATION_FORBIDDEN, 'MODERATOR role or higher required');
    }
    return { workspaceId, role };
  }

  /** slug + 본인 멤버십 조회. 비멤버는 중립 404(IDOR 방어 — WorkspaceMemberGuard 정합). */
  private async loadMember(
    slug: string,
    userId: string,
  ): Promise<{ workspaceId: string; role: SharedWorkspaceRole }> {
    const workspaceId = await this.resolveWorkspaceId(slug);
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    if (!member) {
      throw new DomainError(ErrorCode.WORKSPACE_NOT_MEMBER, 'workspace not found');
    }
    return { workspaceId, role: member.role as SharedWorkspaceRole };
  }
}
