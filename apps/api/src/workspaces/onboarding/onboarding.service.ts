import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ONBOARDING_QUESTIONS_MAX,
  WORKSPACE_RULES_MAX,
  QuestionOptionSchema,
  PERMISSIONS,
  fromStoragePermissions,
  hasRaw,
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
      // security LOW: 비멤버는 중립 404(WORKSPACE_NOT_FOUND)로 응답해 워크스페이스 존재
      // 여부 추론을 차단한다(미존재 워크스페이스와 동일 코드 — 컨트롤러 주석 일관).
      throw new DomainError(ErrorCode.WORKSPACE_NOT_FOUND, 'workspace not found');
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
      select: { role: true, rulesAcceptedAt: true, onboardingCompletedAt: true },
    });
    if (!member) {
      throw new DomainError(ErrorCode.WORKSPACE_NOT_MEMBER, 'workspace not found');
    }

    // reviewer #2 (멱등): 이미 완료했으면 부수효과 없이 early-return 한다(1회성). 재호출 시
    // 채널 재구독/역할 재부여/answers 덮어쓰기를 모두 막는다(complete 는 멱등이어야 한다).
    if (member.onboardingCompletedAt != null) {
      return {
        onboardingCompletedAt: member.onboardingCompletedAt.toISOString(),
        joinedChannelCount: 0,
        assignedRoleCount: 0,
      };
    }

    // reviewer #3 / security MEDIUM (rules 게이트): 워크스페이스에 규칙이 존재하는데 멤버가
    // 아직 동의하지 않았으면(rulesAcceptedAt NULL) 403 RULES_NOT_ACCEPTED 로 차단한다 —
    // Step1 우회로 complete 직접 호출해 채널/역할을 획득하는 경로를 막는다. OWNER 는 면제
    // 한다(생성자 특례 · send/react 메시지 게이트와 동일 로직).
    if (member.role !== 'OWNER' && member.rulesAcceptedAt == null) {
      const hasRules = (await this.prisma.workspaceRule.count({ where: { workspaceId } })) > 0;
      if (hasRules) {
        throw new DomainError(
          ErrorCode.RULES_NOT_ACCEPTED,
          '규칙에 동의한 후 온보딩을 완료할 수 있습니다',
        );
      }
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
                // reviewer #4: 보관(archived) 채널은 자유 구독 대상이 아니다(reactions 경로와 일관).
                archivedAt: null,
                // private 채널은 자유 구독 대상이 아니다(관리자 override 필요 — joinChannel 선례).
                isPrivate: false,
              },
              select: { id: true },
            })
          ).map((c) => c.id)
        : [];
    // ★ 권한상승 CRITICAL (이중 방어 a): 온보딩 자동 역할 부여는 **비시스템·비ADMINISTRATOR
    // 커스텀 역할만** 허용한다. ADMIN 이 질문 옵션 roleId 에 OWNER/ADMIN 시스템역할(또는
    // ADMINISTRATOR 비트 보유 커스텀역할)을 박아두면, 신규 멤버가 그 옵션을 선택하는 것만으로
    // MemberRoleService.assign 의 FR-RM04 가드(position + ADMINISTRATOR 비트)를 우회해
    // ADMINISTRATOR 를 자기부여하게 된다. 여기서 isSystem 역할을 DB where 로 배제하고,
    // ADMINISTRATOR 비트 보유 역할은 코드 필터로 제외한다(안전하지 않은 roleId 는 조용히 skip).
    const validRoleIds =
      roleIdSet.size > 0
        ? (
            await this.prisma.role.findMany({
              where: { id: { in: [...roleIdSet] }, workspaceId, isSystem: false },
              select: { id: true, permissions: true },
            })
          )
            .filter(
              (r) => !hasRaw(fromStoragePermissions(r.permissions), PERMISSIONS.ADMINISTRATOR),
            )
            .map((r) => r.id)
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
   * 피하려고 2단계로 처리한다: 먼저 임시 오프셋으로 옮긴 뒤 최종 position 으로 세팅한다.
   *
   * security MEDIUM (race): 임시 오프셋을 **음수**(-(i+1))로 둔다. 종전 +1000 오프셋은 규칙이
   * 10개를 넘을 수 없는(WORKSPACE_RULES_MAX=10) 현재는 안전하나, 0..n-1 의 양수 공간과 인접해
   * 동시 reorder/create 가 겹치면 UNIQUE 충돌 여지가 있다. 음수 공간은 정상 position(≥0)과
   * 절대 겹치지 않으므로 임시 단계의 충돌을 원천 차단한다.
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
      // 1단계: 유니크 충돌 회피용 임시 음수 오프셋(-(i+1)) — 정상 position(≥0)과 비겹침.
      for (let i = 0; i < ruleIds.length; i++) {
        await tx.workspaceRule.update({
          where: { id: ruleIds[i] },
          data: { position: -(i + 1) },
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
    actorUserId: string,
    req: UpsertQuestionRequest,
  ): Promise<OnboardingQuestion> {
    const count = await this.prisma.onboardingQuestion.count({ where: { workspaceId } });
    if (count >= ONBOARDING_QUESTIONS_MAX) {
      throw new DomainError(
        ErrorCode.ONBOARDING_QUESTIONS_LIMIT,
        `최대 ${ONBOARDING_QUESTIONS_MAX}개의 질문만 등록할 수 있습니다`,
      );
    }
    await this.assertOptionRolesGrantable(workspaceId, actorUserId, req.options);
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
    actorUserId: string,
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
    await this.assertOptionRolesGrantable(workspaceId, actorUserId, req.options);
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

  /**
   * ★ 권한상승 CRITICAL (이중 방어 b): create/updateQuestion 시 옵션의 roleId 가 온보딩 자동
   * 부여로 안전한지 DB 에서 검증한다. 안전 조건(모두 충족해야 통과):
   *   1) 해당 워크스페이스 소속 역할일 것(없으면 ONBOARDING_INVALID_OPTION 400).
   *   2) isSystem = false (시스템 OWNER/ADMIN/… 자동 부여 금지).
   *   3) ADMINISTRATOR 비트 미보유.
   *   4) 작성 ADMIN 의 grant 범위 내(position < 액터 최고 position · 권한 ⊆ 액터 maxPermissions).
   * 위반 시 ROLE_PRIVILEGE_ESCALATION 400. MemberRoleService.assign(FR-RM04)의 가드를
   * 작성 시점(질문 옵션 등록)으로 앞당겨, complete 자동 부여 경로의 위계 우회를 원천 차단한다.
   */
  private async assertOptionRolesGrantable(
    workspaceId: string,
    actorUserId: string,
    options: QuestionOption[],
  ): Promise<void> {
    const roleIds = [
      ...new Set(
        options
          .map((o) => o.roleId)
          .filter((id): id is string => typeof id === 'string' && id.length > 0),
      ),
    ];
    if (roleIds.length === 0) return;

    const roles = await this.prisma.role.findMany({
      where: { id: { in: roleIds }, workspaceId },
      select: { id: true, position: true, permissions: true, isSystem: true },
    });
    const roleMap = new Map(roles.map((r) => [r.id, r]));

    // 액터(작성 ADMIN)의 grant 컨텍스트: 보유 역할의 최고 position · 권한 OR · ADMINISTRATOR 여부.
    const actorRoles = await this.prisma.memberRole.findMany({
      where: { workspaceId, userId: actorUserId },
      select: { role: { select: { position: true, permissions: true } } },
    });
    let topPosition = 0;
    let maxPermissions = 0n;
    for (const r of actorRoles) {
      if (r.role.position > topPosition) topPosition = r.role.position;
      maxPermissions |= fromStoragePermissions(r.role.permissions);
    }
    const isAdministrator = hasRaw(maxPermissions, PERMISSIONS.ADMINISTRATOR);

    for (const roleId of roleIds) {
      const role = roleMap.get(roleId);
      if (!role) {
        throw new DomainError(
          ErrorCode.ONBOARDING_INVALID_OPTION,
          `unknown role ${roleId} in question option`,
        );
      }
      if (role.isSystem) {
        throw new DomainError(
          ErrorCode.ROLE_PRIVILEGE_ESCALATION,
          'cannot map a system role to an onboarding option',
        );
      }
      const rolePerms = fromStoragePermissions(role.permissions);
      if (hasRaw(rolePerms, PERMISSIONS.ADMINISTRATOR)) {
        throw new DomainError(
          ErrorCode.ROLE_PRIVILEGE_ESCALATION,
          'cannot map an ADMINISTRATOR role to an onboarding option',
        );
      }
      // ADMINISTRATOR 액터는 grant 범위 제약 면제(자기 이하 전부 부여 가능 — FR-RM04 선례).
      if (!isAdministrator) {
        if (role.position >= topPosition) {
          throw new DomainError(
            ErrorCode.ROLE_PRIVILEGE_ESCALATION,
            'cannot map a role at or above your own highest role position',
          );
        }
        if ((rolePerms & ~maxPermissions) !== 0n) {
          throw new DomainError(
            ErrorCode.ROLE_PRIVILEGE_ESCALATION,
            'cannot map a role granting permissions you do not hold',
          );
        }
      }
    }
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
    // security MEDIUM: 비공개(isPrivate)/보관(archivedAt) 채널을 웰컴 입장 메시지 대상으로
    // 지정하지 못하게 한다 — 입장 메시지가 비공개 채널을 노출하거나 보관 채널에 게시되는 것 차단.
    if (req.welcomeChannelId) {
      const channel = await this.prisma.channel.findFirst({
        where: {
          id: req.welcomeChannelId,
          workspaceId,
          deletedAt: null,
          archivedAt: null,
          isPrivate: false,
        },
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
