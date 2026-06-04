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
  Put,
} from '@nestjs/common';
import {
  CompleteOnboardingRequestSchema,
  ReorderRulesRequestSchema,
  UpsertQuestionRequestSchema,
  UpsertWelcomeRequestSchema,
  UpsertWorkspaceRuleRequestSchema,
  ROLE_RANK,
  type AcceptRulesResponse,
  type AdminQuestionsResponse,
  type AdminRulesResponse,
  type AdminWelcomeResponse,
  type CompleteOnboardingResponse,
  type OnboardingQuestion,
  type OnboardingStateResponse,
  type WorkspaceRule,
  type WorkspaceRole as SharedWorkspaceRole,
} from '@qufox/shared-types';
import { OnboardingService } from './onboarding.service';
import { CurrentUser, CurrentUserPayload } from '../../auth/decorators/current-user.decorator';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { PrismaService } from '../../prisma/prisma.module';

/**
 * S71 (D13 / FR-W07·W08·W09): 워크스페이스 온보딩 REST. 경로는 PRD 정본대로 :slug 를 쓴다
 * (ApplicationsController 선례). 멤버 상태(GET)·동의(accept-rules)·완료(complete)는 본인
 * 멤버이면 누구나, 관리자 CRUD(규칙/질문/웰컴)는 ADMIN+ 만 호출한다. 전역 JwtAuthGuard 가
 * 인증을 보장하고, :slug 가 WorkspaceMemberGuard 의 :id/:wsId 와 어긋나므로 멤버십/역할은
 * 컨트롤러가 직접 조회해 게이트한다(가드 대신 — applications 선례).
 */
@Controller('workspaces/:slug/onboarding')
export class OnboardingController {
  constructor(
    private readonly onboarding: OnboardingService,
    private readonly prisma: PrismaService,
  ) {}

  // ── 멤버 상태/진행 ────────────────────────────────────────────────────────

  /** FR-W07·W08·W09: 멤버 온보딩 상태 + 규칙/질문/웰컴 카탈로그. */
  @Get()
  async getState(
    @Param('slug') slug: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<OnboardingStateResponse> {
    const workspaceId = await this.resolveWorkspaceId(slug);
    return this.onboarding.getState(workspaceId, user.id);
  }

  /** FR-W07: 규칙 동의. */
  @Post('accept-rules')
  @HttpCode(200)
  async acceptRules(
    @Param('slug') slug: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<AcceptRulesResponse> {
    const workspaceId = await this.resolveWorkspaceId(slug);
    const at = await this.onboarding.acceptRules(workspaceId, user.id);
    return { rulesAcceptedAt: at.toISOString() };
  }

  /** FR-W08: 관심사 완료(원자 tx + 웰컴 enqueue). '건너뛰기'는 빈 answers. */
  @Post('complete')
  @HttpCode(200)
  async complete(
    @Param('slug') slug: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<CompleteOnboardingResponse> {
    const parsed = CompleteOnboardingRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    }
    const workspaceId = await this.resolveWorkspaceId(slug);
    return this.onboarding.complete(workspaceId, user.id, parsed.data);
  }

  // ── 관리자 CRUD: 규칙 ────────────────────────────────────────────────────

  @Get('admin/rules')
  async listRules(
    @Param('slug') slug: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<AdminRulesResponse> {
    const { workspaceId } = await this.assertAdmin(slug, user.id);
    return { rules: await this.onboarding.listRules(workspaceId) };
  }

  @Post('admin/rules')
  @HttpCode(201)
  async createRule(
    @Param('slug') slug: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<WorkspaceRule> {
    const parsed = UpsertWorkspaceRuleRequestSchema.safeParse(body ?? {});
    if (!parsed.success) throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    const { workspaceId } = await this.assertAdmin(slug, user.id);
    return this.onboarding.createRule(workspaceId, parsed.data);
  }

  @Patch('admin/rules/:id')
  async updateRule(
    @Param('slug') slug: string,
    @Param('id', new ParseUUIDPipe()) ruleId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<WorkspaceRule> {
    const parsed = UpsertWorkspaceRuleRequestSchema.safeParse(body ?? {});
    if (!parsed.success) throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    const { workspaceId } = await this.assertAdmin(slug, user.id);
    return this.onboarding.updateRule(workspaceId, ruleId, parsed.data);
  }

  @Delete('admin/rules/:id')
  @HttpCode(204)
  async deleteRule(
    @Param('slug') slug: string,
    @Param('id', new ParseUUIDPipe()) ruleId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<void> {
    const { workspaceId } = await this.assertAdmin(slug, user.id);
    await this.onboarding.deleteRule(workspaceId, ruleId);
  }

  @Post('admin/rules/reorder')
  @HttpCode(200)
  async reorderRules(
    @Param('slug') slug: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<AdminRulesResponse> {
    const parsed = ReorderRulesRequestSchema.safeParse(body ?? {});
    if (!parsed.success) throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    const { workspaceId } = await this.assertAdmin(slug, user.id);
    return { rules: await this.onboarding.reorderRules(workspaceId, parsed.data.ruleIds) };
  }

  // ── 관리자 CRUD: 질문 ────────────────────────────────────────────────────

  @Get('admin/questions')
  async listQuestions(
    @Param('slug') slug: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<AdminQuestionsResponse> {
    const { workspaceId } = await this.assertAdmin(slug, user.id);
    return { questions: await this.onboarding.listQuestions(workspaceId) };
  }

  @Post('admin/questions')
  @HttpCode(201)
  async createQuestion(
    @Param('slug') slug: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<OnboardingQuestion> {
    const parsed = UpsertQuestionRequestSchema.safeParse(body ?? {});
    if (!parsed.success) throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    const { workspaceId } = await this.assertAdmin(slug, user.id);
    return this.onboarding.createQuestion(workspaceId, user.id, parsed.data);
  }

  @Patch('admin/questions/:id')
  async updateQuestion(
    @Param('slug') slug: string,
    @Param('id', new ParseUUIDPipe()) questionId: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<OnboardingQuestion> {
    const parsed = UpsertQuestionRequestSchema.safeParse(body ?? {});
    if (!parsed.success) throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    const { workspaceId } = await this.assertAdmin(slug, user.id);
    return this.onboarding.updateQuestion(workspaceId, user.id, questionId, parsed.data);
  }

  @Delete('admin/questions/:id')
  @HttpCode(204)
  async deleteQuestion(
    @Param('slug') slug: string,
    @Param('id', new ParseUUIDPipe()) questionId: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<void> {
    const { workspaceId } = await this.assertAdmin(slug, user.id);
    await this.onboarding.deleteQuestion(workspaceId, questionId);
  }

  // ── 관리자 CRUD: 웰컴 ────────────────────────────────────────────────────

  @Get('admin/welcome')
  async getWelcome(
    @Param('slug') slug: string,
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<AdminWelcomeResponse> {
    const { workspaceId } = await this.assertAdmin(slug, user.id);
    return { welcome: await this.onboarding.getWelcome(workspaceId) };
  }

  @Put('admin/welcome')
  async upsertWelcome(
    @Param('slug') slug: string,
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<AdminWelcomeResponse> {
    const parsed = UpsertWelcomeRequestSchema.safeParse(body ?? {});
    if (!parsed.success) throw new DomainError(ErrorCode.VALIDATION_FAILED, parsed.error.message);
    const { workspaceId } = await this.assertAdmin(slug, user.id);
    return { welcome: await this.onboarding.upsertWelcome(workspaceId, parsed.data) };
  }

  // ── 내부 헬퍼 ─────────────────────────────────────────────────────────────

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

  /** ADMIN+ 게이트(관리자 CRUD). 비멤버는 중립 404, 하위 역할은 403. */
  private async assertAdmin(slug: string, userId: string): Promise<{ workspaceId: string }> {
    const workspaceId = await this.resolveWorkspaceId(slug);
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { role: true },
    });
    if (!member) {
      throw new DomainError(ErrorCode.WORKSPACE_NOT_MEMBER, 'workspace not found');
    }
    if (ROLE_RANK[member.role as SharedWorkspaceRole] < ROLE_RANK.ADMIN) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'ADMIN role required');
    }
    return { workspaceId };
  }
}
