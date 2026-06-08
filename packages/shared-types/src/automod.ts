import { z } from 'zod';

/**
 * FR-RM10a (063 / ADR E5): AutoMod 키워드 모더레이션 단일 출처(shared-types).
 *
 * ★ADR E1: FR-RM10a 는 **리터럴 키워드 매칭만** 한다(정규식 없음 — ReDoS 회피).
 * 매칭은 contentPlain.toLowerCase() 에 대한 SUBSTRING(includes) 또는 WORD(단어경계)
 * 체크다. MENTION_SPAM / REPEAT_SPAM 트리거는 후속 슬라이스(FR-RM10b)용 예약값이며
 * 이 슬라이스의 생성 요청은 KEYWORD 만 허용한다.
 */

/** 규칙 이름 길이(1~100자, trim). */
export const AUTOMOD_RULE_NAME_MAX = 100;
/** 규칙당 키워드 최대 개수. */
export const AUTOMOD_KEYWORDS_MAX = 50;
/** 키워드 1개의 최대 길이(자). */
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

/** AutoMod 트리거 종류. FR-RM10a 는 KEYWORD 만 구현(나머지는 예약). */
export const AUTOMOD_TRIGGERS = ['KEYWORD', 'MENTION_SPAM', 'REPEAT_SPAM'] as const;
export const AutoModTriggerSchema = z.enum(AUTOMOD_TRIGGERS);
export type AutoModTrigger = z.infer<typeof AutoModTriggerSchema>;

/** AutoMod 매칭 결과 액션. */
export const AUTOMOD_ACTIONS = ['BLOCK', 'ALERT', 'TIMEOUT'] as const;
export const AutoModActionSchema = z.enum(AUTOMOD_ACTIONS);
export type AutoModAction = z.infer<typeof AutoModActionSchema>;

/** AutoMod 키워드 매칭 모드. SUBSTRING(부분 문자열) / WORD(단어 경계). */
export const AUTOMOD_MATCH_MODES = ['SUBSTRING', 'WORD'] as const;
export const AutoModMatchSchema = z.enum(AUTOMOD_MATCH_MODES);
export type AutoModMatch = z.infer<typeof AutoModMatchSchema>;

/** FR-RM10a: 액션 한국어 라벨(FE 표시용). */
export const AUTOMOD_ACTION_LABELS: Record<AutoModAction, string> = {
  BLOCK: '메시지 차단',
  ALERT: '경고(저장 + 감사)',
  TIMEOUT: '차단 + 타임아웃',
};

/** FR-RM10a: 매칭 모드 한국어 라벨(FE 표시용). */
export const AUTOMOD_MATCH_LABELS: Record<AutoModMatch, string> = {
  SUBSTRING: '부분 일치',
  WORD: '단어 단위',
};

/** TIMEOUT 액션의 타임아웃 길이 하한/상한(초) — moderation 타임아웃과 동일 범위. */
export const AUTOMOD_TIMEOUT_MIN_SECONDS = 60;
export const AUTOMOD_TIMEOUT_MAX_SECONDS = 2419200;

/**
 * 키워드 1개 스키마 — trim 후 1~256자. 소문자 정규화는 서버(서비스 레이어)가 수행한다
 * (입력은 원문 허용, 저장/매칭은 toLowerCase). 빈 문자열은 거부.
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

/** FR-RM10a: AutoMod 규칙 응답 DTO. */
export const AutoModRuleSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  name: z.string(),
  triggerType: AutoModTriggerSchema,
  keywords: z.array(z.string()),
  matchMode: AutoModMatchSchema,
  action: AutoModActionSchema,
  timeoutSeconds: z.number().int().nullable(),
  exemptRoleIds: z.array(z.string().uuid()),
  exemptChannelIds: z.array(z.string().uuid()),
  enabled: z.boolean(),
  createdBy: z.string().uuid(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AutoModRule = z.infer<typeof AutoModRuleSchema>;

/**
 * FR-RM10a: 규칙 생성 요청. triggerType 은 KEYWORD 만 허용(나머지는 후속). keywords
 * 1~50개·각 1~256자. action=TIMEOUT 이면 timeoutSeconds 필수. exempt* 는 uuid[].
 */
export const CreateAutoModRuleRequestSchema = z
  .object({
    name: RuleNameSchema,
    // FR-RM10a 는 KEYWORD 만 구현 — 다른 트리거는 거부한다(후속 FR-RM10b).
    triggerType: z.literal('KEYWORD'),
    keywords: z
      .array(KeywordSchema)
      .min(1, 'at least one keyword is required')
      .max(AUTOMOD_KEYWORDS_MAX),
    matchMode: AutoModMatchSchema,
    action: AutoModActionSchema,
    timeoutSeconds: z
      .number()
      .int()
      .min(AUTOMOD_TIMEOUT_MIN_SECONDS)
      .max(AUTOMOD_TIMEOUT_MAX_SECONDS)
      .optional(),
    exemptRoleIds: z.array(z.string().uuid()).max(AUTOMOD_EXEMPT_ROLES_MAX).optional(),
    exemptChannelIds: z.array(z.string().uuid()).max(AUTOMOD_EXEMPT_CHANNELS_MAX).optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine(refineTimeout);
export type CreateAutoModRuleRequest = z.infer<typeof CreateAutoModRuleRequestSchema>;

/**
 * FR-RM10a: 규칙 수정 요청. 모든 필드 선택(부분 수정). action 을 TIMEOUT 으로 바꾸면
 * timeoutSeconds 가 같은 요청에 함께 와야 한다(refine). triggerType 변경은 미지원
 * (KEYWORD 고정)이라 받지 않는다.
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
