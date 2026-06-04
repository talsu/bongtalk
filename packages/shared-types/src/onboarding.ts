import { z } from 'zod';

/**
 * S71 (D13 / FR-W07·W08·W09·W09a): 워크스페이스 온보딩 컨트랙트.
 *
 * 신규 멤버가 워크스페이스 첫 진입 시 거치는 3단계 온보딩:
 *   Step1 (FR-W07) 규칙 동의   — WorkspaceRule(최대 10) 전체화면 block. 동의 전 메시지
 *                                전송·리액션 추가는 서버가 403 RULES_NOT_ACCEPTED 로 차단.
 *   Step2 (FR-W08) 관심사 선택 — OnboardingQuestion(최대 5) 응답. 선택지의 channelIds/roleId 로
 *                                채널 구독 + 역할 부여(단일 $transaction · ON CONFLICT DO NOTHING · 멱등).
 *   Step3 (FR-W09) 웰컴        — WorkspaceWelcome(메시지·welcomeChannel·todos). 완료 시 BullMQ 가
 *                                시스템 DM + welcomeChannel 입장 메시지를 비동기 게시.
 *
 * 각 단계는 데이터가 비어 있으면 skip 한다(규칙 0개 → Step1 skip · 질문 0개 → Step2 skip ·
 * welcome 미설정 → Step3 skip). 모든 단계가 비면 진입 즉시 자동 완료(오버레이 미표시 — Fork A-1).
 *
 * 관리자(ADMIN+)는 규칙/질문/웰컴을 CRUD 로 설정한다(온보딩이 빈 상태면 기능/테스트 불가하므로
 * in-scope). 와이어 길이 상한은 DB VarChar 와 1:1(title 100 · description/message 500 · label 200).
 */

// ----- 상한 상수(단일 출처) ---------------------------------------------------

/** FR-W07: 워크스페이스 규칙 최대 개수. */
export const WORKSPACE_RULES_MAX = 10;
/** FR-W08: 관심사 질문 최대 개수. */
export const ONBOARDING_QUESTIONS_MAX = 5;
/** FR-W08: 질문 1개의 선택지 최대 개수. */
export const ONBOARDING_OPTIONS_MAX = 10;
/** FR-W09: 웰컴 to-do 최대 개수. */
export const WORKSPACE_WELCOME_TODOS_MAX = 5;

export const RULE_TITLE_MAX = 100;
export const RULE_DESCRIPTION_MAX = 500;
export const QUESTION_LABEL_MAX = 200;
export const OPTION_LABEL_MAX = 100;
export const WELCOME_MESSAGE_MAX = 500;
export const WELCOME_TODO_MAX = 200;
/** SHORT_TEXT 답변 본문 상한(자유 입력). */
export const ONBOARDING_SHORT_TEXT_MAX = 1000;

// ----- 질문 타입 -------------------------------------------------------------

/** Prisma QuestionType enum 과 1:1 동기. SINGLE/MULTI = 선택지형 · SHORT_TEXT = 자유 입력. */
export const QuestionTypeSchema = z.enum(['SINGLE', 'MULTI', 'SHORT_TEXT']);
export type QuestionType = z.infer<typeof QuestionTypeSchema>;

// ----- 규칙(WorkspaceRule) ----------------------------------------------------

export const WorkspaceRuleSchema = z.object({
  id: z.string().uuid(),
  position: z.number().int().nonnegative(),
  title: z.string().min(1).max(RULE_TITLE_MAX),
  description: z.string().max(RULE_DESCRIPTION_MAX).nullable(),
});
export type WorkspaceRule = z.infer<typeof WorkspaceRuleSchema>;

// ----- 질문 선택지 / 질문(OnboardingQuestion) --------------------------------

/**
 * 선택지 1개. 선택 시 channelIds 채널을 구독하고 roleId 역할을 부여한다(complete tx).
 * SHORT_TEXT 질문은 선택지가 없고(빈 배열) 답변을 onboardingAnswers 에 저장한다.
 */
export const QuestionOptionSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(OPTION_LABEL_MAX),
  channelIds: z.array(z.string().uuid()).max(50).default([]),
  roleId: z.string().uuid().nullable().optional(),
});
export type QuestionOption = z.infer<typeof QuestionOptionSchema>;

export const OnboardingQuestionSchema = z.object({
  id: z.string().uuid(),
  position: z.number().int().nonnegative(),
  type: QuestionTypeSchema,
  isRequired: z.boolean(),
  label: z.string().min(1).max(QUESTION_LABEL_MAX),
  options: z.array(QuestionOptionSchema).max(ONBOARDING_OPTIONS_MAX),
});
export type OnboardingQuestion = z.infer<typeof OnboardingQuestionSchema>;

// ----- 웰컴(WorkspaceWelcome) -------------------------------------------------

export const WorkspaceWelcomeSchema = z.object({
  welcomeChannelId: z.string().uuid().nullable(),
  message: z.string().max(WELCOME_MESSAGE_MAX).nullable(),
  todos: z.array(z.string().min(1).max(WELCOME_TODO_MAX)).max(WORKSPACE_WELCOME_TODOS_MAX),
});
export type WorkspaceWelcome = z.infer<typeof WorkspaceWelcomeSchema>;

// ----- 멤버 온보딩 상태(GET /workspaces/:slug/onboarding) ---------------------

/**
 * 멤버 1명의 온보딩 진행 상태 + 표시에 필요한 카탈로그(규칙/질문/웰컴). FE 가 이 응답만으로
 * 오버레이를 마운트할지(완료 여부)·어느 단계로 resume 할지를 판정한다.
 *   - rulesAcceptedAt: null 이면 Step1 미완료(규칙이 존재할 때만 의미).
 *   - onboardingCompletedAt: null 이면 Step2(관심사) 미완료. 모든 단계 완료 시 세팅.
 */
export const OnboardingStateResponseSchema = z.object({
  rulesAcceptedAt: z.string().datetime().nullable(),
  onboardingCompletedAt: z.string().datetime().nullable(),
  rules: z.array(WorkspaceRuleSchema),
  questions: z.array(OnboardingQuestionSchema),
  welcome: WorkspaceWelcomeSchema.nullable(),
});
export type OnboardingStateResponse = z.infer<typeof OnboardingStateResponseSchema>;

// ----- Step2 완료(POST /workspaces/:slug/onboarding/complete) -----------------

/**
 * 한 질문에 대한 응답. SINGLE/MULTI 는 optionIds(선택한 선택지 id) · SHORT_TEXT 는 text.
 * '건너뛰기'는 빈 answers 배열로 표현한다(채널/역할 미실행 · 기본 채널만).
 */
export const OnboardingAnswerSchema = z.object({
  questionId: z.string().uuid(),
  optionIds: z.array(z.string().min(1).max(64)).max(ONBOARDING_OPTIONS_MAX).default([]),
  text: z.string().max(ONBOARDING_SHORT_TEXT_MAX).nullable().optional(),
});
export type OnboardingAnswer = z.infer<typeof OnboardingAnswerSchema>;

export const CompleteOnboardingRequestSchema = z.object({
  answers: z.array(OnboardingAnswerSchema).max(ONBOARDING_QUESTIONS_MAX).default([]),
});
export type CompleteOnboardingRequest = z.infer<typeof CompleteOnboardingRequestSchema>;

export const CompleteOnboardingResponseSchema = z.object({
  onboardingCompletedAt: z.string().datetime(),
  // complete tx 가 구독한 채널 수 + 부여한 역할 수(관찰성 — FE 토스트 등).
  joinedChannelCount: z.number().int().nonnegative(),
  assignedRoleCount: z.number().int().nonnegative(),
});
export type CompleteOnboardingResponse = z.infer<typeof CompleteOnboardingResponseSchema>;

// ----- accept-rules(POST /workspaces/:slug/onboarding/accept-rules) -----------

export const AcceptRulesResponseSchema = z.object({
  rulesAcceptedAt: z.string().datetime(),
});
export type AcceptRulesResponse = z.infer<typeof AcceptRulesResponseSchema>;

// ----- 관리자 CRUD 요청(ADMIN+) ----------------------------------------------

export const UpsertWorkspaceRuleRequestSchema = z.object({
  title: z.string().min(1).max(RULE_TITLE_MAX),
  description: z.string().max(RULE_DESCRIPTION_MAX).nullable().optional(),
});
export type UpsertWorkspaceRuleRequest = z.infer<typeof UpsertWorkspaceRuleRequestSchema>;

export const ReorderRulesRequestSchema = z.object({
  // 새 순서대로 나열한 규칙 id 전체. 서버가 position 을 0..n-1 로 재배치한다.
  ruleIds: z.array(z.string().uuid()).min(1).max(WORKSPACE_RULES_MAX),
});
export type ReorderRulesRequest = z.infer<typeof ReorderRulesRequestSchema>;

export const UpsertQuestionRequestSchema = z.object({
  type: QuestionTypeSchema,
  isRequired: z.boolean().default(false),
  label: z.string().min(1).max(QUESTION_LABEL_MAX),
  // SHORT_TEXT 는 빈 배열. SINGLE/MULTI 는 1개 이상 권장(서버는 ≤10 만 강제).
  options: z.array(QuestionOptionSchema).max(ONBOARDING_OPTIONS_MAX).default([]),
});
export type UpsertQuestionRequest = z.infer<typeof UpsertQuestionRequestSchema>;

export const UpsertWelcomeRequestSchema = z.object({
  welcomeChannelId: z.string().uuid().nullable().optional(),
  message: z.string().max(WELCOME_MESSAGE_MAX).nullable().optional(),
  todos: z
    .array(z.string().min(1).max(WELCOME_TODO_MAX))
    .max(WORKSPACE_WELCOME_TODOS_MAX)
    .default([]),
});
export type UpsertWelcomeRequest = z.infer<typeof UpsertWelcomeRequestSchema>;

// 관리자 조회 응답(목록 + 웰컴 단건).
export const AdminRulesResponseSchema = z.object({ rules: z.array(WorkspaceRuleSchema) });
export type AdminRulesResponse = z.infer<typeof AdminRulesResponseSchema>;

export const AdminQuestionsResponseSchema = z.object({
  questions: z.array(OnboardingQuestionSchema),
});
export type AdminQuestionsResponse = z.infer<typeof AdminQuestionsResponseSchema>;

export const AdminWelcomeResponseSchema = z.object({ welcome: WorkspaceWelcomeSchema.nullable() });
export type AdminWelcomeResponse = z.infer<typeof AdminWelcomeResponseSchema>;
