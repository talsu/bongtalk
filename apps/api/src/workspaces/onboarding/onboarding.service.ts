import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ONBOARDING_QUESTIONS_MAX,
  WORKSPACE_RULES_MAX,
  QuestionOptionSchema,
  type CompleteOnboardingRequest,
  type CompleteOnboardingResponse,
  type OnboardingQuestion,
  type OnboardingStateResponse,
  type QuestionOption,
  type QuestionType,
  type UpsertQuestionRequest,
  type UpsertWelcomeRequest,
  type UpsertWorkspaceRuleRequest,
  type WorkspaceRule,
  type WorkspaceWelcome,
} from '@qufox/shared-types';
import { PrismaService } from '../../prisma/prisma.module';
import { DomainError } from '../../common/errors/domain-error';
import { ErrorCode } from '../../common/errors/error-code.enum';
import { OnboardingWelcomeQueueService } from '../../queue/onboarding-welcome-queue.service';

/**
 * S71 (D13 / FR-W07·W08·W09): 워크스페이스 온보딩 도메인 서비스.
 *
 *   - getState:      멤버 진행 상태 + 규칙/질문/웰컴 카탈로그 조회(오버레이 마운트·resume 판정).
 *   - acceptRules:   규칙 동의(rulesAcceptedAt 세팅). 규칙 0개여도 멱등 통과.
 *   - complete:      관심사(Step2) 완료 — 단일 $transaction(채널 구독 ON CONFLICT DO NOTHING +
 *                    역할 부여 ON CONFLICT DO NOTHING + onboardingCompletedAt). 멱등. 커밋 후
 *                    BullMQ 로 웰컴 발송을 enqueue(시스템 DM·입장 메시지는 tx 분리 — 결정사항).
 *   - 관리자 CRUD:    규칙(list/create/update/delete/reorder)·질문(list/upsert/delete)·웰컴(get/upsert).
 *
 * 채널 구독은 ChannelPermissionOverride(principalType='USER', allowMask=0n opt-in 표식)로
 * 표현한다(channels.service.joinChannel 의 자유가입 표식과 동일 — 공개 채널 baseline 위 opt-in).
 * 역할 부여는 MemberRole 조인 INSERT 다. 둘 다 ON CONFLICT DO NOTHING 으로 멱등하다.
 */
@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly welcomeQueue: OnboardingWelcomeQueueService,
  ) {}

  // ── 멤버 상태 조회 ────────────────────────────────────────────────────────

  async getState(workspaceId: string, userId: string): Promise<OnboardingStateResponse> {
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { rulesAcceptedAt: true, onboardingCompletedAt: true },
    });
    if (!member) {
      throw new DomainError(ErrorCode.WORKSPACE_NOT_MEMBER, 'workspace not found');
    }
    const [rules, questions, welcome] = await Promise.all([
      this.listRules(workspaceId),
      this.listQuestions(workspaceId),
      this.getWelcome(workspaceId),
    ]);
    return {
      rulesAcceptedAt: member.rulesAcceptedAt?.toISOString() ?? null,
      onboardingCompletedAt: member.onboardingCompletedAt?.toISOString() ?? null,
      rules,
      questions,
      welcome,
    };
  }

  // ── 규칙 동의(Step1) ──────────────────────────────────────────────────────

  /**
   * FR-W07: 규칙 동의. rulesAcceptedAt 을 현재 시각으로 세팅한다(멱등 — 이미 동의했어도 갱신).
   * 규칙이 0개여도 통과하지만, FE 는 규칙 0개면 Step1 자체를 skip 한다.
   */
  async acceptRules(workspaceId: string, userId: string): Promise<Date> {
    const now = new Date();
    try {
      await this.prisma.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId, userId } },
        data: { rulesAcceptedAt: now },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new DomainError(ErrorCode.WORKSPACE_NOT_MEMBER, 'workspace not found');
      }
      throw err;
    }
    return now;
  }

  // ── 관심사 완료(Step2) — 단일 원자 트랜잭션 ───────────────────────────────

  /**
   * FR-W08: 관심사 완료. 선택지의 channelIds 채널 구독 + roleId 역할 부여 + onboardingCompletedAt
   * 을 **단일 $transaction** 으로 처리한다(원자성). 모두 ON CONFLICT DO NOTHING 이라 멱등하다.
   * '건너뛰기'(빈 answers)는 채널/역할을 실행하지 않고 onboardingCompletedAt 만 세팅한다.
   *
   * SHORT_TEXT 응답은 WorkspaceMember.onboardingAnswers([{questionId,text}])에 저장한다.
   * 시스템 DM·웰컴 입장 메시지는 tx 커밋 후 BullMQ 로 분리 enqueue 한다(결정사항).
   */
  async complete(
    workspaceId: string,
    userId: string,
    req: CompleteOnboardingRequest,
  ): Promise<CompleteOnboardingResponse> {
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { userId: true },
    });
    if (!member) {
      throw new DomainError(ErrorCode.WORKSPACE_NOT_MEMBER, 'workspace not found');
    }

    // 질문 카탈로그를 로드해 선택지 id → (channelIds, roleId) 를 해석한다(신뢰 경계: 클라가 보낸
    // optionIds 는 카탈로그에 실재하는 선택지여야 한다 — 없으면 ONBOARDING_INVALID_OPTION 400).
    const questions = await this.listQuestions(workspaceId);
    const questionMap = new Map(questions.map((q) => [q.id, q]));

    const channelIdSet = new Set<string>();
    const roleIdSet = new Set<string>();
    const shortTextAnswers: { questionId: string; text: string }[] = [];

    for (const answer of req.answers) {
      const question = questionMap.get(answer.questionId);
      if (!question) {
        // 알 수 없는 질문 id 는 무시(질문이 삭제됐을 수 있음 — 멱등/forward-compat).
        continue;
      }
      if (question.type === 'SHORT_TEXT') {
        if (answer.text != null && answer.text.length > 0) {
          shortTextAnswers.push({ questionId: question.id, text: answer.text });
        }
        continue;
      }
      // SINGLE/MULTI: optionIds 를 카탈로그 선택지로 해석.
      const optionMap = new Map(question.options.map((o) => [o.id, o]));
      for (const optionId of answer.optionIds) {
        const option = optionMap.get(optionId);
        if (!option) {
          throw new DomainError(
            ErrorCode.ONBOARDING_INVALID_OPTION,
            `unknown option ${optionId} for question ${question.id}`,
          );
        }
        for (const ch of option.channelIds) channelIdSet.add(ch);
        if (option.roleId) roleIdSet.add(option.roleId);
      }
    }

    // 채널/역할 실재성 검증(tx 밖 — 워크스페이스 소속 공개 채널 · 워크스페이스 소속 역할만).
    const validChannelIds =
      channelIdSet.size > 0
        ? (
            await this.prisma.channel.findMany({
              where: {
                id: { in: [...channelIdSet] },
                workspaceId,
                deletedAt: null,
                // private 채널은 자유 구독 대상이 아니다(관리자 override 필요 — joinChannel 선례).
                isPrivate: false,
              },
              select: { id: true },
            })
          ).map((c) => c.id)
        : [];
    const validRoleIds =
      roleIdSet.size > 0
        ? (
            await this.prisma.role.findMany({
              where: { id: { in: [...roleIdSet] }, workspaceId },
              select: { id: true },
            })
          ).map((r) => r.id)
        : [];

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      // 채널 구독 — opt-in 표식(allowMask=0n) ON CONFLICT DO NOTHING(멱등 · joinChannel 선례).
      for (const channelId of validChannelIds) {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "ChannelPermissionOverride"
            ("id", "channelId", "principalType", "principalId", "allowMask", "denyMask", "createdAt", "updatedAt")
          VALUES (gen_random_uuid(), ${channelId}::uuid, 'USER', ${userId}, 0, 0, NOW(), NOW())
          ON CONFLICT ("channelId", "principalType", "principalId") DO NOTHING
        `);
      }
      // 역할 부여 — MemberRole INSERT ON CONFLICT DO NOTHING(멱등 · FR-RM01 선례).
      for (const roleId of validRoleIds) {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "MemberRole" ("workspaceId", "userId", "roleId", "assignedAt", "assignedBy")
          VALUES (${workspaceId}::uuid, ${userId}::uuid, ${roleId}::uuid, NOW(), NULL)
          ON CONFLICT ("workspaceId", "userId", "roleId") DO NOTHING
        `);
      }
      // onboardingCompletedAt + SHORT_TEXT 답변 저장(같은 tx).
      await tx.workspaceMember.update({
        where: { workspaceId_userId: { workspaceId, userId } },
        data: {
          onboardingCompletedAt: now,
          onboardingAnswers:
            shortTextAnswers.length > 0
              ? (shortTextAnswers as unknown as Prisma.InputJsonValue)
              : undefined,
        },
      });
    });

    // tx 커밋 후 BullMQ 로 웰컴 발송을 분리 enqueue(시스템 DM + 입장 메시지 — best-effort).
    await this.welcomeQueue.enqueue(workspaceId, userId);

    return {
      onboardingCompletedAt: now.toISOString(),
      joinedChannelCount: validChannelIds.length,
      assignedRoleCount: validRoleIds.length,
    };
  }

  // ── 규칙 CRUD(ADMIN+) ─────────────────────────────────────────────────────

  async listRules(workspaceId: string): Promise<WorkspaceRule[]> {
    const rows = await this.prisma.workspaceRule.findMany({
      where: { workspaceId },
      orderBy: { position: 'asc' },
      select: { id: true, position: true, title: true, description: true },
    });
    return rows.map((r) => ({
      id: r.id,
      position: r.position,
      title: r.title,
      description: r.description,
    }));
  }

  async createRule(workspaceId: string, req: UpsertWorkspaceRuleRequest): Promise<WorkspaceRule> {
    const count = await this.prisma.workspaceRule.count({ where: { workspaceId } });
    if (count >= WORKSPACE_RULES_MAX) {
      throw new DomainError(
        ErrorCode.ONBOARDING_RULES_LIMIT,
        `최대 ${WORKSPACE_RULES_MAX}개의 규칙만 등록할 수 있습니다`,
      );
    }
    const created = await this.prisma.workspaceRule.create({
      data: {
        workspaceId,
        position: count,
        title: req.title,
        description: req.description ?? null,
      },
      select: { id: true, position: true, title: true, description: true },
    });
    return {
      id: created.id,
      position: created.position,
      title: created.title,
      description: created.description,
    };
  }

  async updateRule(
    workspaceId: string,
    ruleId: string,
    req: UpsertWorkspaceRuleRequest,
  ): Promise<WorkspaceRule> {
    await this.assertRuleExists(workspaceId, ruleId);
    const updated = await this.prisma.workspaceRule.update({
      where: { id: ruleId },
      data: { title: req.title, description: req.description ?? null },
      select: { id: true, position: true, title: true, description: true },
    });
    return {
      id: updated.id,
      position: updated.position,
      title: updated.title,
      description: updated.description,
    };
  }

  async deleteRule(workspaceId: string, ruleId: string): Promise<void> {
    await this.assertRuleExists(workspaceId, ruleId);
    await this.prisma.workspaceRule.delete({ where: { id: ruleId } });
  }

  /**
   * 규칙 순서를 ruleIds 순서대로 0..n-1 로 재배치한다. (workspaceId, position) 유니크 충돌을
   * 피하려고 2단계로 처리한다: 먼저 임시 큰 오프셋으로 옮긴 뒤 최종 position 으로 세팅한다.
   */
  async reorderRules(workspaceId: string, ruleIds: string[]): Promise<WorkspaceRule[]> {
    const existing = await this.prisma.workspaceRule.findMany({
      where: { workspaceId },
      select: { id: true },
    });
    const existingIds = new Set(existing.map((r) => r.id));
    if (ruleIds.length !== existingIds.size || ruleIds.some((id) => !existingIds.has(id))) {
      throw new DomainError(
        ErrorCode.ONBOARDING_RULE_NOT_FOUND,
        'reorder list must contain exactly the workspace rules',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      // 1단계: 유니크 충돌 회피용 임시 오프셋(+1000).
      for (let i = 0; i < ruleIds.length; i++) {
        await tx.workspaceRule.update({
          where: { id: ruleIds[i] },
          data: { position: 1000 + i },
        });
      }
      // 2단계: 최종 position.
      for (let i = 0; i < ruleIds.length; i++) {
        await tx.workspaceRule.update({ where: { id: ruleIds[i] }, data: { position: i } });
      }
    });
    return this.listRules(workspaceId);
  }

  private async assertRuleExists(workspaceId: string, ruleId: string): Promise<void> {
    const rule = await this.prisma.workspaceRule.findFirst({
      where: { id: ruleId, workspaceId },
      select: { id: true },
    });
    if (!rule) {
      throw new DomainError(ErrorCode.ONBOARDING_RULE_NOT_FOUND, 'rule not found');
    }
  }

  // ── 질문 CRUD(ADMIN+) ─────────────────────────────────────────────────────

  async listQuestions(workspaceId: string): Promise<OnboardingQuestion[]> {
    const rows = await this.prisma.onboardingQuestion.findMany({
      where: { workspaceId },
      orderBy: { position: 'asc' },
      select: {
        id: true,
        position: true,
        type: true,
        isRequired: true,
        label: true,
        options: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      position: r.position,
      type: r.type as QuestionType,
      isRequired: r.isRequired,
      label: r.label,
      options: this.parseOptions(r.options),
    }));
  }

  async createQuestion(
    workspaceId: string,
    req: UpsertQuestionRequest,
  ): Promise<OnboardingQuestion> {
    const count = await this.prisma.onboardingQuestion.count({ where: { workspaceId } });
    if (count >= ONBOARDING_QUESTIONS_MAX) {
      throw new DomainError(
        ErrorCode.ONBOARDING_QUESTIONS_LIMIT,
        `최대 ${ONBOARDING_QUESTIONS_MAX}개의 질문만 등록할 수 있습니다`,
      );
    }
    const created = await this.prisma.onboardingQuestion.create({
      data: {
        workspaceId,
        position: count,
        type: req.type as QuestionType,
        isRequired: req.isRequired,
        label: req.label,
        options: req.options as unknown as Prisma.InputJsonValue,
      },
      select: {
        id: true,
        position: true,
        type: true,
        isRequired: true,
        label: true,
        options: true,
      },
    });
    return {
      id: created.id,
      position: created.position,
      type: created.type as QuestionType,
      isRequired: created.isRequired,
      label: created.label,
      options: this.parseOptions(created.options),
    };
  }

  async updateQuestion(
    workspaceId: string,
    questionId: string,
    req: UpsertQuestionRequest,
  ): Promise<OnboardingQuestion> {
    const existing = await this.prisma.onboardingQuestion.findFirst({
      where: { id: questionId, workspaceId },
      select: { id: true },
    });
    if (!existing) {
      throw new DomainError(ErrorCode.ONBOARDING_QUESTION_NOT_FOUND, 'question not found');
    }
    const updated = await this.prisma.onboardingQuestion.update({
      where: { id: questionId },
      data: {
        type: req.type as QuestionType,
        isRequired: req.isRequired,
        label: req.label,
        options: req.options as unknown as Prisma.InputJsonValue,
      },
      select: {
        id: true,
        position: true,
        type: true,
        isRequired: true,
        label: true,
        options: true,
      },
    });
    return {
      id: updated.id,
      position: updated.position,
      type: updated.type as QuestionType,
      isRequired: updated.isRequired,
      label: updated.label,
      options: this.parseOptions(updated.options),
    };
  }

  async deleteQuestion(workspaceId: string, questionId: string): Promise<void> {
    const existing = await this.prisma.onboardingQuestion.findFirst({
      where: { id: questionId, workspaceId },
      select: { id: true },
    });
    if (!existing) {
      throw new DomainError(ErrorCode.ONBOARDING_QUESTION_NOT_FOUND, 'question not found');
    }
    await this.prisma.onboardingQuestion.delete({ where: { id: questionId } });
  }

  /** options Json 을 신뢰 경계에서 Zod 로 좁혀 파싱한다(불량 행은 빈 배열로 폴백). */
  private parseOptions(raw: Prisma.JsonValue): QuestionOption[] {
    if (!Array.isArray(raw)) return [];
    const out: QuestionOption[] = [];
    for (const item of raw) {
      const parsed = QuestionOptionSchema.safeParse(item);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }

  // ── 웰컴 CRUD(ADMIN+) ─────────────────────────────────────────────────────

  async getWelcome(workspaceId: string): Promise<WorkspaceWelcome | null> {
    const row = await this.prisma.workspaceWelcome.findUnique({
      where: { workspaceId },
      select: { welcomeChannelId: true, message: true, todos: true },
    });
    if (!row) return null;
    return {
      welcomeChannelId: row.welcomeChannelId,
      message: row.message,
      todos: Array.isArray(row.todos) ? (row.todos as unknown[]).map((t) => String(t)) : [],
    };
  }

  async upsertWelcome(workspaceId: string, req: UpsertWelcomeRequest): Promise<WorkspaceWelcome> {
    // welcomeChannelId 가 주어지면 워크스페이스 소속 채널인지 검증한다(타 워크스페이스 차단).
    if (req.welcomeChannelId) {
      const channel = await this.prisma.channel.findFirst({
        where: { id: req.welcomeChannelId, workspaceId, deletedAt: null },
        select: { id: true },
      });
      if (!channel) {
        throw new DomainError(
          ErrorCode.CHANNEL_NOT_FOUND,
          'welcome channel not found in workspace',
        );
      }
    }
    const row = await this.prisma.workspaceWelcome.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        welcomeChannelId: req.welcomeChannelId ?? null,
        message: req.message ?? null,
        todos: req.todos as unknown as Prisma.InputJsonValue,
      },
      update: {
        welcomeChannelId: req.welcomeChannelId ?? null,
        message: req.message ?? null,
        todos: req.todos as unknown as Prisma.InputJsonValue,
      },
      select: { welcomeChannelId: true, message: true, todos: true },
    });
    return {
      welcomeChannelId: row.welcomeChannelId,
      message: row.message,
      todos: Array.isArray(row.todos) ? (row.todos as unknown[]).map((t) => String(t)) : [],
    };
  }
}
