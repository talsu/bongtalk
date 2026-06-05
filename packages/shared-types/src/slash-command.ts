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
