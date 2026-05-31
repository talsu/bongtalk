import { z } from 'zod';
import { Cuid2Schema, MRKDWN_PARSE_LIMITS } from './mrkdwn';

/**
 * D16 rich_text AST 노드 Zod 스키마 (FR-RC02).
 *
 * 메시지 본문은 contentRaw(원본 mrkdwn) → contentAst(파싱 AST JSON) →
 * contentPlain(평문) 파이프라인으로 저장됩니다. 본 파일은 contentAst JSON 의
 * 구조 계약(단일 출처)을 정의하며, 서버 파서(apps/api)·클라이언트 렌더러
 * (apps/web) 모두 이 스키마로 검증합니다.
 *
 * 노드 타입은 mrkdwn.ts MRKDWN_AST_NODE_TYPES 와 정합합니다:
 *   block : paragraph · heading · blockquote · code_block · list · subtext · divider
 *   inline: text · mention_user · mention_channel · mention_role · emoji · link
 *
 * Zod 재귀(블록 → 인라인/블록 children)는 z.lazy 로 처리합니다.
 */

/** 인라인 text 노드 마크. D16 §2 — bold/italic/underline/strike/code/spoiler. */
export const TEXT_MARKS = ['bold', 'italic', 'underline', 'strike', 'code', 'spoiler'] as const;
export const TextMarkSchema = z.enum(TEXT_MARKS);
export type TextMark = z.infer<typeof TextMarkSchema>;

// ── 인라인 노드 ──────────────────────────────────────────────────────────────
export const TextNodeSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
  // 마크는 누락 시 [] 로 forward-compat (구 row / plain text 노드).
  marks: z.array(TextMarkSchema).default([]),
});
export type TextNode = z.infer<typeof TextNodeSchema>;

export const MentionUserNodeSchema = z.object({
  type: z.literal('mention_user'),
  userId: Cuid2Schema,
});
export type MentionUserNode = z.infer<typeof MentionUserNodeSchema>;

export const MentionChannelNodeSchema = z.object({
  type: z.literal('mention_channel'),
  channelId: Cuid2Schema,
});
export type MentionChannelNode = z.infer<typeof MentionChannelNodeSchema>;

export const MentionRoleNodeSchema = z.object({
  type: z.literal('mention_role'),
  roleId: Cuid2Schema,
});
export type MentionRoleNode = z.infer<typeof MentionRoleNodeSchema>;

export const EmojiNodeSchema = z.object({
  type: z.literal('emoji'),
  /** :name: slug (유니코드/커스텀 공통). 커스텀이면 customId 동반. */
  name: z.string().min(1).max(64),
  customId: Cuid2Schema.nullable().default(null),
});
export type EmojiNode = z.infer<typeof EmojiNodeSchema>;

/**
 * link.url 스킴 allowlist (security S01 MED — XSS A03). AST 가 신뢰 경계
 * 이므로 `javascript:` / `data:` / `vbscript:` 같은 활성 스킴은 계약에서
 * 거부합니다. http(s) 절대 URL + 프로토콜-상대(//host) + 상대경로(/path,
 * ./, #anchor)만 허용합니다. 렌더러 escape 와 별개의 1차 방어선입니다.
 */
const ACTIVE_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const SAFE_SCHEME_RE = /^https?:/i;
export function isSafeLinkUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed.length === 0) return false;
  // 스킴이 명시된 경우 http(s) 만 허용. 스킴이 없으면(상대/anchor/proto-relative) 허용.
  if (ACTIVE_SCHEME_RE.test(trimmed)) {
    return SAFE_SCHEME_RE.test(trimmed);
  }
  return true;
}

export const LinkNodeSchema = z.object({
  type: z.literal('link'),
  url: z.string().refine(isSafeLinkUrl, { message: 'unsafe link url scheme' }),
  /** 표시 텍스트(없으면 url 자체를 렌더). */
  text: z.string().nullable().default(null),
});
export type LinkNode = z.infer<typeof LinkNodeSchema>;

export const InlineNodeSchema = z.discriminatedUnion('type', [
  TextNodeSchema,
  MentionUserNodeSchema,
  MentionChannelNodeSchema,
  MentionRoleNodeSchema,
  EmojiNodeSchema,
  LinkNodeSchema,
]);
export type InlineNode =
  | TextNode
  | MentionUserNode
  | MentionChannelNode
  | MentionRoleNode
  | EmojiNode
  | LinkNode;

// ── 블록 노드 ────────────────────────────────────────────────────────────────
// list item / blockquote 는 인라인/블록 혼합 children 을 가질 수 있어 재귀 정의.
type ListItem = { nodes: RichTextNode[] };

export const ParagraphNodeSchema = z.object({
  type: z.literal('paragraph'),
  nodes: z.array(InlineNodeSchema),
});
export type ParagraphNode = z.infer<typeof ParagraphNodeSchema>;

export const HeadingNodeSchema = z.object({
  type: z.literal('heading'),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  nodes: z.array(InlineNodeSchema),
});
export type HeadingNode = z.infer<typeof HeadingNodeSchema>;

export const SubtextNodeSchema = z.object({
  type: z.literal('subtext'),
  nodes: z.array(InlineNodeSchema),
});
export type SubtextNode = z.infer<typeof SubtextNodeSchema>;

export const CodeBlockNodeSchema = z.object({
  type: z.literal('code_block'),
  code: z.string(),
  lang: z.string().max(32).nullable().optional(),
});
export type CodeBlockNode = z.infer<typeof CodeBlockNodeSchema>;

export const DividerNodeSchema = z.object({
  type: z.literal('divider'),
});
export type DividerNode = z.infer<typeof DividerNodeSchema>;

// blockquote / list 는 RichTextNode 를 재귀로 품어 z.lazy 가 필요.
export interface BlockquoteNode {
  type: 'blockquote';
  nodes: RichTextNode[];
}
export const BlockquoteNodeSchema: z.ZodType<BlockquoteNode, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({
    type: z.literal('blockquote'),
    nodes: z.array(RichTextNodeSchema),
  }),
);

export interface ListNode {
  type: 'list';
  ordered: boolean;
  indent: number;
  items: ListItem[];
}
export const ListItemSchema: z.ZodType<ListItem, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({ nodes: z.array(RichTextNodeSchema) }),
);
export const ListNodeSchema: z.ZodType<ListNode, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.object({
    type: z.literal('list'),
    ordered: z.boolean(),
    // 최대 3레벨(D16 §2) — 음수/과대 indent 방어는 파서가 한도 enforce.
    indent: z.number().int().min(0).max(3),
    items: z.array(ListItemSchema),
  }),
);

// ── 노드 union + root ────────────────────────────────────────────────────────
export type RichTextNode =
  | ParagraphNode
  | HeadingNode
  | BlockquoteNode
  | CodeBlockNode
  | ListNode
  | SubtextNode
  | DividerNode
  | InlineNode;

export const RichTextNodeSchema: z.ZodType<RichTextNode, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.union([
    ParagraphNodeSchema,
    HeadingNodeSchema,
    BlockquoteNodeSchema,
    CodeBlockNodeSchema,
    ListNodeSchema,
    SubtextNodeSchema,
    DividerNodeSchema,
    InlineNodeSchema,
  ]),
);

/**
 * 트리 깊이/노드 수를 단일 순회로 측정합니다. z.lazy 재귀는 구조만 검증할
 * 뿐 깊이·노드 한도를 강제하지 못하므로(reviewer S01 MAJOR — DoS/스택
 * 방어 갭), RichTextRootSchema 의 superRefine 에서 본 함수로 한도를
 * enforce 합니다. children 후보 키(nodes/items)를 모두 순회합니다.
 */
function measureTree(node: unknown): { count: number; depth: number } {
  if (node === null || typeof node !== 'object') {
    return { count: 0, depth: 0 };
  }
  let count = 1;
  let maxChildDepth = 0;
  const children: unknown[] = [];
  const rec = node as Record<string, unknown>;
  if (Array.isArray(rec.nodes)) children.push(...rec.nodes);
  if (Array.isArray(rec.items)) {
    for (const item of rec.items) {
      if (item && typeof item === 'object' && Array.isArray((item as { nodes?: unknown }).nodes)) {
        children.push(...(item as { nodes: unknown[] }).nodes);
      }
    }
  }
  for (const child of children) {
    const m = measureTree(child);
    count += m.count;
    if (m.depth > maxChildDepth) maxChildDepth = m.depth;
  }
  return { count, depth: maxChildDepth + 1 };
}

export const RichTextRootSchema = z
  .object({
    type: z.literal('root'),
    nodes: z.array(RichTextNodeSchema),
  })
  .superRefine((root, ctx) => {
    // FR-MSG-23 한도 enforce — isRichTextRoot 가 unknown 공개 가드라
    // 스키마 단독이 신뢰 경계가 됩니다(파서 슬라이스는 후속).
    const { count, depth } = measureTree(root);
    if (depth > MRKDWN_PARSE_LIMITS.MAX_DEPTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `rich_text tree depth ${depth} exceeds MAX_DEPTH ${MRKDWN_PARSE_LIMITS.MAX_DEPTH}`,
      });
    }
    if (count > MRKDWN_PARSE_LIMITS.MAX_NODES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `rich_text node count ${count} exceeds MAX_NODES ${MRKDWN_PARSE_LIMITS.MAX_NODES}`,
      });
    }
  });
export type RichTextRoot = z.infer<typeof RichTextRootSchema>;

/** contentAst JSON 이 유효한 rich_text root 인지 좁히는 타입 가드. */
export function isRichTextRoot(value: unknown): value is RichTextRoot {
  return RichTextRootSchema.safeParse(value).success;
}
