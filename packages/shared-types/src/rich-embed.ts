import { z } from 'zod';

/**
 * S84b (D16 / FR-RC12) — 봇/웹훅 rich embed 배열 계약.
 *
 * Discord 호환 rich embed 구조다. 인커밍 웹훅 payload(`embeds[]`)로 게시 시점에
 * 통째 제공되는 **불변** 데이터로, Message.richEmbeds(JSON)에 자족적으로 저장되고
 * MessageDto.richEmbeds 로 그대로 렌더된다(S60 unfurl `embeds[]` 와는 별개 필드).
 *
 * 보안(SSRF · S84a avatar 일관): 모든 URL(author.url/iconUrl · title url · image ·
 * thumbnail · footer.iconUrl)은 http(s) scheme 만 허용한다. 길이·개수 캡으로 payload
 * 폭주를 막는다(embeds≤10/메시지 · fields≤25/embed).
 */

// ── 캡(Discord parity, 합리적 상한) ─────────────────────────────────────────────
export const RICH_EMBED_MAX_PER_MESSAGE = 10;
export const RICH_EMBED_MAX_FIELDS = 25;
export const RICH_EMBED_TITLE_MAX = 256;
export const RICH_EMBED_DESCRIPTION_MAX = 4096;
export const RICH_EMBED_FIELD_NAME_MAX = 256;
export const RICH_EMBED_FIELD_VALUE_MAX = 1024;
export const RICH_EMBED_AUTHOR_NAME_MAX = 256;
export const RICH_EMBED_FOOTER_TEXT_MAX = 2048;
export const RICH_EMBED_URL_MAX = 2048;

/** http(s) scheme 만 허용하는 URL(SSRF hardening · S84a avatar 일관). */
const HttpUrlSchema = z
  .string()
  .url()
  .max(RICH_EMBED_URL_MAX)
  .refine((u) => /^https?:\/\//i.test(u), { message: 'URL must be http(s)' });

/**
 * color: `#RRGGBB` 또는 `RRGGBB`(앞 # 선택) 6자리 hex. 정규화는 서비스가
 * `#` 접두 소문자로 맞춘다(여기선 형식만 검증).
 */
export const RichEmbedColorSchema = z
  .string()
  .regex(/^#?[0-9a-fA-F]{6}$/, 'color must be a 6-digit hex');

/** embed field: name + value(둘 다 필수) + inline 여부(기본 false). */
export const RichEmbedFieldSchema = z.object({
  name: z.string().trim().min(1).max(RICH_EMBED_FIELD_NAME_MAX),
  value: z.string().trim().min(1).max(RICH_EMBED_FIELD_VALUE_MAX),
  inline: z.boolean().optional(),
});
export type RichEmbedField = z.infer<typeof RichEmbedFieldSchema>;

/** embed author: name 필수, icon_url/url 선택(http(s)). */
export const RichEmbedAuthorSchema = z.object({
  name: z.string().trim().min(1).max(RICH_EMBED_AUTHOR_NAME_MAX),
  // eslint-disable-next-line @typescript-eslint/naming-convention
  icon_url: HttpUrlSchema.optional(),
  url: HttpUrlSchema.optional(),
});
export type RichEmbedAuthor = z.infer<typeof RichEmbedAuthorSchema>;

/** embed footer: text 필수, icon_url 선택. */
export const RichEmbedFooterSchema = z.object({
  text: z.string().trim().min(1).max(RICH_EMBED_FOOTER_TEXT_MAX),
  // eslint-disable-next-line @typescript-eslint/naming-convention
  icon_url: HttpUrlSchema.optional(),
});
export type RichEmbedFooter = z.infer<typeof RichEmbedFooterSchema>;

/** image/thumbnail: { url }(http(s)). Discord 와 동일하게 객체로 받는다. */
export const RichEmbedMediaSchema = z.object({ url: HttpUrlSchema });
export type RichEmbedMedia = z.infer<typeof RichEmbedMediaSchema>;

/**
 * rich embed. 모든 필드 선택이지만, 적어도 하나는 의미 있는 내용을 담아야 렌더된다
 * (빈 embed 제거는 서비스가 처리). timestamp 는 ISO8601 datetime.
 */
export const RichEmbedSchema = z.object({
  color: RichEmbedColorSchema.optional(),
  author: RichEmbedAuthorSchema.optional(),
  title: z.string().trim().min(1).max(RICH_EMBED_TITLE_MAX).optional(),
  url: HttpUrlSchema.optional(),
  description: z.string().trim().min(1).max(RICH_EMBED_DESCRIPTION_MAX).optional(),
  fields: z.array(RichEmbedFieldSchema).max(RICH_EMBED_MAX_FIELDS).optional(),
  image: RichEmbedMediaSchema.optional(),
  thumbnail: RichEmbedMediaSchema.optional(),
  footer: RichEmbedFooterSchema.optional(),
  timestamp: z.string().datetime().optional(),
});
export type RichEmbed = z.infer<typeof RichEmbedSchema>;

/** 메시지당 embed 배열 캡(≤10). 인커밍 payload·MessageDto 공용. */
export const RichEmbedArraySchema = z.array(RichEmbedSchema).max(RICH_EMBED_MAX_PER_MESSAGE);

/**
 * embed 가 렌더할 내용이 하나라도 있는지(빈 embed 제거용). color/timestamp 만으로는
 * 카드를 띄우지 않는다(Discord 동작).
 */
export function isRenderableRichEmbed(e: RichEmbed): boolean {
  return Boolean(
    e.author?.name ||
      e.title ||
      e.description ||
      (e.fields && e.fields.length > 0) ||
      e.image ||
      e.thumbnail ||
      e.footer?.text,
  );
}

/** color 를 `#rrggbb`(소문자·# 접두) 정규형으로. 형식은 스키마가 보장. */
export function normalizeEmbedColor(color: string): string {
  const hex = color.startsWith('#') ? color.slice(1) : color;
  return `#${hex.toLowerCase()}`;
}
