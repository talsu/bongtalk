import { z } from 'zod';

/**
 * FR-RM10a (063 / ADR E5) · FR-RM10b (069): AutoMod 모더레이션 단일 출처(shared-types).
 *
 * 트리거 3종(discriminated union by triggerType):
 *   KEYWORD       — 키워드/구문 매칭. matchMode SUBSTRING(includes) · WORD(단어경계) ·
 *                   ★REGEX(정규식 — FR-RM10b · 저장 시 ReDoS 검증 · worker_threads 격리 매칭).
 *   MENTION_SPAM  — 작성자별 윈도 내 누적 멘션 수가 mentionThreshold 초과 시 액션.
 *   REPEAT_SPAM   — 작성자별 윈도 내 동일 본문 반복이 repeatThreshold 초과 시 액션.
 *
 * KEYWORD 매칭(SUBSTRING/WORD)은 contentPlain.toLowerCase() 기준이며 REGEX 는 원문(소문자
 * 캡)에 대해 패턴을 평가한다. spam 트리거는 Redis sliding window 카운트(messages.service 가
 * mentionCount/contentPlain 을 check 로 넘긴다).
 */

/** 규칙 이름 길이(1~100자, trim). */
export const AUTOMOD_RULE_NAME_MAX = 100;
/** 규칙당 키워드(또는 정규식 패턴) 최대 개수. */
export const AUTOMOD_KEYWORDS_MAX = 50;
/** 키워드(또는 정규식 패턴) 1개의 최대 길이(자). */
export const AUTOMOD_KEYWORD_MAX_LEN = 256;
/** 워크스페이스당 AutoMod 규칙 최대 개수(과다 규칙 hot-path 보호). */
export const AUTOMOD_RULES_PER_WORKSPACE_MAX = 100;
/**
 * FR-RM10a (리뷰 F5): 규칙 1개의 면제 역할/채널 ID 최대 개수. 종전엔 규칙 cap 상수
 * (AUTOMOD_RULES_PER_WORKSPACE_MAX)를 오용해 의미가 어긋났다 — 면제 목록은 별도의
 * 작은 cap 으로 둔다(과다 면제 주입 방지 · check() 의 면제 스캔 비용 bounded).
 */
export const AUTOMOD_EXEMPT_ROLES_MAX = 50;
export const AUTOMOD_EXEMPT_CHANNELS_MAX = 50;

/**
 * FR-RM10b: spam 트리거 임계값/윈도 범위. threshold 는 1~1000(과도한 룰 방지), windowSeconds
 * 는 5초~1시간(짧은 버스트~중기 윈도). 기본값은 서버/FE 가 보수적으로 둔다(false positive 완화).
 */
export const AUTOMOD_SPAM_THRESHOLD_MIN = 1;
export const AUTOMOD_SPAM_THRESHOLD_MAX = 1000;
export const AUTOMOD_SPAM_WINDOW_MIN_SECONDS = 5;
export const AUTOMOD_SPAM_WINDOW_MAX_SECONDS = 3600;

/** AutoMod 트리거 종류. FR-RM10b 에서 3종 전부 구현. */
export const AUTOMOD_TRIGGERS = ['KEYWORD', 'MENTION_SPAM', 'REPEAT_SPAM'] as const;
export const AutoModTriggerSchema = z.enum(AUTOMOD_TRIGGERS);
export type AutoModTrigger = z.infer<typeof AutoModTriggerSchema>;

/** AutoMod 매칭 결과 액션. */
export const AUTOMOD_ACTIONS = ['BLOCK', 'ALERT', 'TIMEOUT'] as const;
export const AutoModActionSchema = z.enum(AUTOMOD_ACTIONS);
export type AutoModAction = z.infer<typeof AutoModActionSchema>;

/**
 * AutoMod 키워드 매칭 모드. SUBSTRING(부분 문자열) / WORD(단어 경계) / REGEX(정규식·FR-RM10b).
 * REGEX 는 KEYWORD 트리거에서만 의미가 있고, spam 트리거는 matchMode 를 SUBSTRING 으로 둔다
 * (스키마/DB NOT NULL 충족용 placeholder — 매칭에 쓰이지 않음).
 */
export const AUTOMOD_MATCH_MODES = ['SUBSTRING', 'WORD', 'REGEX'] as const;
export const AutoModMatchSchema = z.enum(AUTOMOD_MATCH_MODES);
export type AutoModMatch = z.infer<typeof AutoModMatchSchema>;

/** FR-RM10a: 액션 한국어 라벨(FE 표시용). */
export const AUTOMOD_ACTION_LABELS: Record<AutoModAction, string> = {
  BLOCK: '메시지 차단',
  ALERT: '경고(저장 + 감사)',
  TIMEOUT: '차단 + 타임아웃',
};

/** FR-RM10a/b: 매칭 모드 한국어 라벨(FE 표시용). */
export const AUTOMOD_MATCH_LABELS: Record<AutoModMatch, string> = {
  SUBSTRING: '부분 일치',
  WORD: '단어 단위',
  REGEX: '정규식',
};

/** FR-RM10b: 트리거 한국어 라벨(FE 표시용). */
export const AUTOMOD_TRIGGER_LABELS: Record<AutoModTrigger, string> = {
  KEYWORD: '키워드',
  MENTION_SPAM: '멘션 스팸',
  REPEAT_SPAM: '반복 스팸',
};

/** TIMEOUT 액션의 타임아웃 길이 하한/상한(초) — moderation 타임아웃과 동일 범위. */
export const AUTOMOD_TIMEOUT_MIN_SECONDS = 60;
export const AUTOMOD_TIMEOUT_MAX_SECONDS = 2419200;

/**
 * 키워드(또는 정규식 패턴) 1개 스키마 — trim 후 1~256자. 소문자 정규화는 서버(서비스 레이어)가
 * 리터럴(SUBSTRING/WORD)에만 수행한다(REGEX 는 대소문자 의미가 있어 원문 보존). 빈 문자열 거부.
 */
const KeywordSchema = z
  .string()
  .trim()
  .min(1, 'keyword must not be empty')
  .max(AUTOMOD_KEYWORD_MAX_LEN, `keyword must be at most ${AUTOMOD_KEYWORD_MAX_LEN} characters`);

/** 규칙 이름 스키마 — trim 후 1~100자. */
const RuleNameSchema = z
  .string()
  .trim()
  .min(1, 'name must not be empty')
  .max(AUTOMOD_RULE_NAME_MAX, `name must be at most ${AUTOMOD_RULE_NAME_MAX} characters`);

/** FR-RM10b: spam 임계값 스키마(1~1000). */
const SpamThresholdSchema = z
  .number()
  .int()
  .min(AUTOMOD_SPAM_THRESHOLD_MIN)
  .max(AUTOMOD_SPAM_THRESHOLD_MAX);

/** FR-RM10b: spam 윈도(초) 스키마(5~3600). */
const SpamWindowSchema = z
  .number()
  .int()
  .min(AUTOMOD_SPAM_WINDOW_MIN_SECONDS)
  .max(AUTOMOD_SPAM_WINDOW_MAX_SECONDS);

/** TIMEOUT 액션일 때 timeoutSeconds 필수를 강제하는 공통 superRefine. */
function refineTimeout(
  val: { action: AutoModAction; timeoutSeconds?: number | null },
  ctx: z.RefinementCtx,
): void {
  if (
    val.action === 'TIMEOUT' &&
    (val.timeoutSeconds === undefined || val.timeoutSeconds === null)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'timeoutSeconds is required when action is TIMEOUT',
      path: ['timeoutSeconds'],
    });
  }
}

/** FR-RM10a/b: AutoMod 규칙 응답 DTO. spam 파라미터는 nullable(KEYWORD 룰은 null). */
export const AutoModRuleSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string(),
  triggerType: AutoModTriggerSchema,
  keywords: z.array(z.string()),
  matchMode: AutoModMatchSchema,
  action: AutoModActionSchema,
  timeoutSeconds: z.number().int().nullable(),
  // FR-RM10b: spam 트리거 파라미터(KEYWORD 룰은 셋 다 null).
  mentionThreshold: z.number().int().nullable(),
  repeatThreshold: z.number().int().nullable(),
  windowSeconds: z.number().int().nullable(),
  exemptRoleIds: z.array(z.string().uuid()),
  exemptChannelIds: z.array(z.string().uuid()),
  enabled: z.boolean(),
  createdBy: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AutoModRule = z.infer<typeof AutoModRuleSchema>;

const ExemptRoleIdsSchema = z.array(z.string().uuid()).max(AUTOMOD_EXEMPT_ROLES_MAX).optional();
const ExemptChannelIdsSchema = z
  .array(z.string().uuid())
  .max(AUTOMOD_EXEMPT_CHANNELS_MAX)
  .optional();
const TimeoutSecondsSchema = z
  .number()
  .int()
  .min(AUTOMOD_TIMEOUT_MIN_SECONDS)
  .max(AUTOMOD_TIMEOUT_MAX_SECONDS)
  .optional();

/**
 * FR-RM10b: KEYWORD 트리거 생성 — keywords 1~50개·각 1~256자, matchMode SUBSTRING/WORD/REGEX.
 * REGEX 패턴의 ReDoS 안전성은 서버가 저장 전 worker 로 검증한다(REGEX_UNSAFE 400). action=
 * TIMEOUT 이면 timeoutSeconds 필수.
 */
const CreateKeywordRuleSchema = z.object({
  name: RuleNameSchema,
  triggerType: z.literal('KEYWORD'),
  keywords: z
    .array(KeywordSchema)
    .min(1, 'at least one keyword is required')
    .max(AUTOMOD_KEYWORDS_MAX),
  matchMode: AutoModMatchSchema,
  action: AutoModActionSchema,
  timeoutSeconds: TimeoutSecondsSchema,
  exemptRoleIds: ExemptRoleIdsSchema,
  exemptChannelIds: ExemptChannelIdsSchema,
  enabled: z.boolean().optional(),
});

/** FR-RM10b: MENTION_SPAM 생성 — mentionThreshold + windowSeconds(keywords 불요). */
const CreateMentionSpamRuleSchema = z.object({
  name: RuleNameSchema,
  triggerType: z.literal('MENTION_SPAM'),
  mentionThreshold: SpamThresholdSchema,
  windowSeconds: SpamWindowSchema,
  action: AutoModActionSchema,
  timeoutSeconds: TimeoutSecondsSchema,
  exemptRoleIds: ExemptRoleIdsSchema,
  exemptChannelIds: ExemptChannelIdsSchema,
  enabled: z.boolean().optional(),
});

/** FR-RM10b: REPEAT_SPAM 생성 — repeatThreshold + windowSeconds(keywords 불요). */
const CreateRepeatSpamRuleSchema = z.object({
  name: RuleNameSchema,
  triggerType: z.literal('REPEAT_SPAM'),
  repeatThreshold: SpamThresholdSchema,
  windowSeconds: SpamWindowSchema,
  action: AutoModActionSchema,
  timeoutSeconds: TimeoutSecondsSchema,
  exemptRoleIds: ExemptRoleIdsSchema,
  exemptChannelIds: ExemptChannelIdsSchema,
  enabled: z.boolean().optional(),
});

/**
 * FR-RM10a/b: 규칙 생성 요청(triggerType 기준 discriminated union). KEYWORD 는 keywords +
 * matchMode(REGEX 허용), spam 2종은 threshold + windowSeconds. discriminatedUnion 멤버는 순수
 * ZodObject 여야 하므로 timeoutSeconds refine 은 union 전체에 한 번 superRefine 으로 적용한다.
 */
export const CreateAutoModRuleRequestSchema = z
  .discriminatedUnion('triggerType', [
    CreateKeywordRuleSchema,
    CreateMentionSpamRuleSchema,
    CreateRepeatSpamRuleSchema,
  ])
  .superRefine(refineTimeout);
export type CreateAutoModRuleRequest = z.infer<typeof CreateAutoModRuleRequestSchema>;

/**
 * FR-RM10a/b: 규칙 수정 요청(부분). triggerType 변경은 미지원(생성 시 고정)이라 받지 않는다.
 * 모든 트리거 공통 필드(name/action/timeout/enabled/exempt*) + KEYWORD 필드(keywords/matchMode)
 * + spam 필드(mentionThreshold/repeatThreshold/windowSeconds)를 전부 optional 로 둔다. 서비스가
 * 룰의 실제 triggerType 에 맞춰 해당 필드만 적용한다(무관 필드는 무시). action 을 TIMEOUT 으로
 * 바꾸면 timeoutSeconds 가 함께 와야 한다(refine).
 */
export const UpdateAutoModRuleRequestSchema = z
  .object({
    name: RuleNameSchema.optional(),
    keywords: z
      .array(KeywordSchema)
      .min(1, 'at least one keyword is required')
      .max(AUTOMOD_KEYWORDS_MAX)
      .optional(),
    matchMode: AutoModMatchSchema.optional(),
    mentionThreshold: SpamThresholdSchema.optional(),
    repeatThreshold: SpamThresholdSchema.optional(),
    windowSeconds: SpamWindowSchema.optional(),
    action: AutoModActionSchema.optional(),
    timeoutSeconds: z
      .number()
      .int()
      .min(AUTOMOD_TIMEOUT_MIN_SECONDS)
      .max(AUTOMOD_TIMEOUT_MAX_SECONDS)
      .nullable()
      .optional(),
    exemptRoleIds: z.array(z.string().uuid()).max(AUTOMOD_EXEMPT_ROLES_MAX).optional(),
    exemptChannelIds: z.array(z.string().uuid()).max(AUTOMOD_EXEMPT_CHANNELS_MAX).optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    // action 을 명시적으로 TIMEOUT 으로 바꾸는데 timeoutSeconds 가 함께 안 오면 거부.
    if (
      val.action === 'TIMEOUT' &&
      (val.timeoutSeconds === undefined || val.timeoutSeconds === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'timeoutSeconds is required when action is TIMEOUT',
        path: ['timeoutSeconds'],
      });
    }
  });
export type UpdateAutoModRuleRequest = z.infer<typeof UpdateAutoModRuleRequestSchema>;

/** FR-RM10a: 규칙 목록 응답. */
export const ListAutoModRulesResponseSchema = z.object({
  rules: z.array(AutoModRuleSchema),
});
export type ListAutoModRulesResponse = z.infer<typeof ListAutoModRulesResponseSchema>;
