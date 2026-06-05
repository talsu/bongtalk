import { z } from 'zod';

/**
 * S79 (D15 / FR-SC-01·02·03) — 슬래시 커맨드 자동완성 계약.
 *
 * 본 슬라이스는 **자동완성 + `/명령 ` 삽입까지만** 다룬다(실행은 S80, 커스텀
 * CRUD 는 S81). 따라서 이 계약은 GET 목록 응답의 한 항목(`SlashCommandItem`)
 * 만 정의한다 — 클라이언트는 이 목록으로 자동완성 팝업을 채우고, 선택 시
 * `/name ` 토큰을 컴포저에 삽입한다.
 *
 * responseType / handlerType 은 PRD D15 빌트인 상세 테이블(EPHEMERAL/IN_CHANNEL,
 * BUILTIN/INTERNAL_ACTION)과 정합한다. S79 자동완성은 이 두 필드를 표시/실행에
 * 쓰지 않지만(실행은 S80), 동일 GET 응답을 S80 이 그대로 재사용하므로 계약에
 * 미리 포함해 라운드트립을 안정화한다.
 *
 * isBuiltin: 항목이 NestJS `BUILTIN_COMMANDS` 상수에서 왔는지(true) 워크스페이스
 * SlashCommand 테이블에서 왔는지(false) 구분한다. 빌트인은 id 가 `builtin:<name>`
 * 형태의 합성 식별자라 워크스페이스 커스텀(uuid)과 충돌하지 않는다.
 */
export const ResponseTypeSchema = z.enum(['EPHEMERAL', 'IN_CHANNEL']);
export type ResponseType = z.infer<typeof ResponseTypeSchema>;

export const HandlerTypeSchema = z.enum(['BUILTIN', 'INTERNAL_ACTION']);
export type HandlerType = z.infer<typeof HandlerTypeSchema>;

export const SlashCommandItemSchema = z.object({
  /** 빌트인은 `builtin:<name>`, 커스텀은 uuid. */
  id: z.string().min(1),
  /** sigil 제외 커맨드명(예: `shrug`). 자동완성 삽입 시 `/` + name + 공백. */
  name: z.string().min(1).max(32),
  /** 한 줄 짧은 설명(자동완성 항목 보조 텍스트). */
  description: z.string(),
  /** 파라미터 usage hint(예: `/remind [@사람] "할일" [시간]`). 선택 후 placeholder 로 노출. */
  usageHint: z.string(),
  responseType: ResponseTypeSchema,
  handlerType: HandlerTypeSchema,
  /** true = NestJS 상수 빌트인, false = 워크스페이스 커스텀(SlashCommand 테이블). */
  isBuiltin: z.boolean(),
});
export type SlashCommandItem = z.infer<typeof SlashCommandItemSchema>;

/** GET /workspaces/:workspaceId/slash-commands 응답. */
export const SlashCommandListResponseSchema = z.object({
  items: z.array(SlashCommandItemSchema),
});
export type SlashCommandListResponse = z.infer<typeof SlashCommandListResponseSchema>;

// ── S81c (D15 / FR-SC-09·10): 커스텀 슬래시 커맨드 CRUD + configurable action ──────
//
// 워크스페이스 관리자(ADMIN+)가 REST 로 커스텀 슬래시 커맨드를 등록·수정·삭제한다.
// 실행은 NestJS 내부 핸들러(configurable action)로만 한다 — ★외부 URL/webhook 호출은
// 절대 없다(PRD 명시·SSRF 회피). handler URL 필드를 두지 않는다(저장만 되고 실행 안 되는
// 혼란 방지). 안전한 in-process 액션만 CustomActionType 으로 표현한다.

/**
 * 커스텀 커맨드 실행 액션 종류(외부 호출 없는 안전 액션만):
 *   - EPHEMERAL_TEXT:   actionParams.text 를 발신자 전용 EPHEMERAL 로 반환(고정 안내문).
 *   - SEND_TEMPLATE:    actionParams.template 을 채널에 일반 메시지로 게시(IN_CHANNEL).
 *                       template 의 `{args}` 자리에 사용자 인자를 1회 치환(MESSAGE 길이 준수).
 *   - REDIRECT_CHANNEL: actionParams.channelId 로 클라이언트 네비게이션(본인 접근 가능 채널만).
 */
export const CustomActionTypeSchema = z.enum([
  'EPHEMERAL_TEXT',
  'SEND_TEMPLATE',
  'REDIRECT_CHANNEL',
]);
export type CustomActionType = z.infer<typeof CustomActionTypeSchema>;

// actionType 별 actionParams 형태. responseType 와 정합(EPHEMERAL_TEXT/REDIRECT_CHANNEL 은
// EPHEMERAL, SEND_TEMPLATE 는 IN_CHANNEL)은 서버가 actionType 으로부터 강제한다(CRUD 서비스).
export const EphemeralTextParamsSchema = z.object({
  actionType: z.literal('EPHEMERAL_TEXT'),
  // 발신자에게 보여줄 고정 안내문(1–2000자). EPHEMERAL 이라 채널에 게시되지 않으므로 mrkdwn
  // 안전성은 클라 렌더가 담당하고, 서버는 길이/존재만 강제한다.
  text: z.string().min(1).max(2000),
});

export const SendTemplateParamsSchema = z.object({
  actionType: z.literal('SEND_TEMPLATE'),
  // 채널에 게시할 템플릿 본문(1–2000자). `{args}` 1개를 사용자 인자로 치환한다(서버). 치환 후
  // 본문이 MESSAGE 상한(4000)을 넘으면 서버가 EPHEMERAL error 로 거부한다. `{args}` 가 없으면
  // 인자는 무시되고 템플릿 그대로 게시된다.
  template: z.string().min(1).max(2000),
});

export const RedirectChannelParamsSchema = z.object({
  actionType: z.literal('REDIRECT_CHANNEL'),
  // 네비게이션 대상 채널 id. 실행 시 본인 접근 가능 여부를 서버가 검증한다(IDOR 방지).
  channelId: z.string().uuid(),
});

// actionType 으로 구분되는 discriminated union — 본문(text/template/channelId)이 actionType 과
// 정합해야 한다. responseType 은 actionType 으로부터 서버가 도출하므로 CRUD 요청에는 받지 않는다.
export const CustomActionParamsSchema = z.discriminatedUnion('actionType', [
  EphemeralTextParamsSchema,
  SendTemplateParamsSchema,
  RedirectChannelParamsSchema,
]);
export type CustomActionParams = z.infer<typeof CustomActionParamsSchema>;

// 커맨드명: sigil(`/`) 제외, 소문자/숫자/`_`/`-` 만, 1–32자. 서버가 소문자 normalize 후 검증한다.
const CommandNameSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9_-]+$/, '소문자·숫자·_·- 만 사용할 수 있습니다');

/** POST /workspaces/:wsId/slash-commands 요청(등록 — ADMIN 전용). */
export const CreateCustomCommandRequestSchema = z.object({
  name: CommandNameSchema,
  description: z.string().max(255).optional().default(''),
  usageHint: z.string().max(128).optional().default(''),
  // configurable action(외부 호출 없음). responseType 은 action 으로부터 서버가 도출한다.
  action: CustomActionParamsSchema,
  // 기본 활성. false 면 자동완성 목록에서 숨기되 행은 보관한다.
  enabled: z.boolean().optional().default(true),
});
export type CreateCustomCommandRequest = z.infer<typeof CreateCustomCommandRequestSchema>;

/** PATCH /workspaces/:wsId/slash-commands/:cmdId 요청(수정 — ADMIN 전용·부분 갱신). */
export const UpdateCustomCommandRequestSchema = z
  .object({
    name: CommandNameSchema.optional(),
    description: z.string().max(255).optional(),
    usageHint: z.string().max(128).optional(),
    action: CustomActionParamsSchema.optional(),
    enabled: z.boolean().optional(),
  })
  // 빈 PATCH(아무 필드도 없음)는 무의미하므로 최소 1개 필드를 요구한다.
  .refine((v) => Object.keys(v).length > 0, '변경할 필드를 1개 이상 지정해 주세요');
export type UpdateCustomCommandRequest = z.infer<typeof UpdateCustomCommandRequestSchema>;
