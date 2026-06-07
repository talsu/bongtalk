import { describe, it, expect } from 'vitest';
import {
  RichEmbedSchema,
  RichEmbedArraySchema,
  RichEmbedFieldSchema,
  RICH_EMBED_MAX_FIELDS,
  RICH_EMBED_MAX_PER_MESSAGE,
  isRenderableRichEmbed,
  normalizeEmbedColor,
} from './rich-embed';
import { IncomingWebhookPayloadSchema } from './webhook';

describe('S84b rich embed contracts (FR-RC12)', () => {
  describe('RichEmbedSchema', () => {
    it('accepts a full Discord-style embed', () => {
      const r = RichEmbedSchema.safeParse({
        color: '#5865F2',
        author: {
          name: 'CI',
          icon_url: 'https://cdn.example.com/i.png',
          url: 'https://ci.example.com',
        },
        title: 'Build #42',
        url: 'https://ci.example.com/42',
        description: 'passed',
        fields: [{ name: 'branch', value: 'main', inline: true }],
        image: { url: 'https://cdn.example.com/img.png' },
        thumbnail: { url: 'https://cdn.example.com/t.png' },
        footer: { text: 'qufox-ci' },
        timestamp: '2026-06-22T00:00:00.000Z',
      });
      expect(r.success).toBe(true);
    });

    it('rejects a non-http(s) URL (SSRF)', () => {
      expect(RichEmbedSchema.safeParse({ title: 'x', url: 'file:///etc/passwd' }).success).toBe(
        false,
      );
      expect(RichEmbedSchema.safeParse({ image: { url: 'http://169.254.169.254/' } }).success).toBe(
        true,
      ); // http는 허용(내부망 차단은 BE 네트워크 정책 영역 — scheme만 검증)
      expect(
        RichEmbedSchema.safeParse({ author: { name: 'a', icon_url: 'ftp://h/i' } }).success,
      ).toBe(false);
    });

    it('rejects a malformed color', () => {
      expect(RichEmbedSchema.safeParse({ title: 'x', color: 'red' }).success).toBe(false);
      expect(RichEmbedSchema.safeParse({ title: 'x', color: '#12345' }).success).toBe(false);
      expect(RichEmbedSchema.safeParse({ title: 'x', color: '5865F2' }).success).toBe(true);
    });

    it('rejects more than 25 fields', () => {
      const fields = Array.from({ length: RICH_EMBED_MAX_FIELDS + 1 }, (_v, i) => ({
        name: `f${i}`,
        value: 'v',
      }));
      expect(RichEmbedSchema.safeParse({ fields }).success).toBe(false);
    });

    it('rejects an over-long title/description', () => {
      expect(RichEmbedSchema.safeParse({ title: 'a'.repeat(257) }).success).toBe(false);
      expect(RichEmbedSchema.safeParse({ description: 'a'.repeat(4097) }).success).toBe(false);
    });
  });

  describe('RichEmbedFieldSchema', () => {
    it('requires non-empty name and value', () => {
      expect(RichEmbedFieldSchema.safeParse({ name: '', value: 'v' }).success).toBe(false);
      expect(RichEmbedFieldSchema.safeParse({ name: 'n', value: '' }).success).toBe(false);
      expect(RichEmbedFieldSchema.safeParse({ name: 'n', value: 'v' }).success).toBe(true);
    });
  });

  describe('RichEmbedArraySchema', () => {
    it('rejects more than 10 embeds', () => {
      const embeds = Array.from({ length: RICH_EMBED_MAX_PER_MESSAGE + 1 }, () => ({ title: 'x' }));
      expect(RichEmbedArraySchema.safeParse(embeds).success).toBe(false);
    });
    // S84b 리뷰 fix-forward (LOW-2): combined-char 총합 캡(6000).
    it('rejects when combined embed text exceeds 6000 chars', () => {
      const big = [{ description: 'a'.repeat(4096) }, { description: 'b'.repeat(4096) }];
      expect(RichEmbedArraySchema.safeParse(big).success).toBe(false);
      const ok = [{ description: 'a'.repeat(3000) }, { description: 'b'.repeat(3000) }];
      expect(RichEmbedArraySchema.safeParse(ok).success).toBe(true);
    });
    it('rejects SSRF URLs on image/thumbnail/author.icon/footer.icon', () => {
      expect(RichEmbedArraySchema.safeParse([{ image: { url: 'ftp://h/i' } }]).success).toBe(false);
      expect(RichEmbedArraySchema.safeParse([{ thumbnail: { url: 'file:///x' } }]).success).toBe(
        false,
      );
      expect(
        RichEmbedArraySchema.safeParse([{ footer: { text: 't', icon_url: 'ftp://h/i' } }]).success,
      ).toBe(false);
    });
  });

  describe('isRenderableRichEmbed', () => {
    it('is false for empty / color-only / timestamp-only embeds', () => {
      expect(isRenderableRichEmbed({})).toBe(false);
      expect(isRenderableRichEmbed({ color: '#fff000' })).toBe(false);
      expect(isRenderableRichEmbed({ timestamp: '2026-06-22T00:00:00.000Z' })).toBe(false);
    });
    it('is true when any content field is present', () => {
      expect(isRenderableRichEmbed({ title: 'x' })).toBe(true);
      expect(isRenderableRichEmbed({ description: 'x' })).toBe(true);
      expect(isRenderableRichEmbed({ fields: [{ name: 'n', value: 'v' }] })).toBe(true);
      expect(isRenderableRichEmbed({ author: { name: 'a' } })).toBe(true);
      expect(isRenderableRichEmbed({ image: { url: 'https://e.com/i.png' } })).toBe(true);
      expect(isRenderableRichEmbed({ footer: { text: 't' } })).toBe(true);
    });
  });

  describe('normalizeEmbedColor', () => {
    it('normalizes to #rrggbb lowercase with leading #', () => {
      expect(normalizeEmbedColor('#5865F2')).toBe('#5865f2');
      expect(normalizeEmbedColor('5865F2')).toBe('#5865f2');
    });
  });

  describe('IncomingWebhookPayloadSchema with embeds', () => {
    it('accepts embed-only message (no content)', () => {
      expect(IncomingWebhookPayloadSchema.safeParse({ embeds: [{ title: 'x' }] }).success).toBe(
        true,
      );
    });
    // S84b 리뷰 fix-forward (LOW-1): Discord 의 content:"" + embeds 도 embed-only 로 허용.
    it('accepts content:"" with embeds (empty string preprocessed)', () => {
      expect(
        IncomingWebhookPayloadSchema.safeParse({ content: '', embeds: [{ title: 'x' }] }).success,
      ).toBe(true);
    });
    it('rejects content:"" with no embeds', () => {
      expect(IncomingWebhookPayloadSchema.safeParse({ content: '' }).success).toBe(false);
    });
    it('rejects empty payload (neither content nor embeds)', () => {
      expect(IncomingWebhookPayloadSchema.safeParse({}).success).toBe(false);
      expect(IncomingWebhookPayloadSchema.safeParse({ embeds: [] }).success).toBe(false);
    });
    it('accepts content + embeds together', () => {
      expect(
        IncomingWebhookPayloadSchema.safeParse({ content: 'hi', embeds: [{ title: 'x' }] }).success,
      ).toBe(true);
    });
  });
});
