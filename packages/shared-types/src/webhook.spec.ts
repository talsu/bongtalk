import { describe, it, expect } from 'vitest';
import {
  isReservedBotName,
  RESERVED_BOT_NAMES,
  CreateWebhookRequestSchema,
  IncomingWebhookPayloadSchema,
  WebhookCreatedResponseSchema,
  WEBHOOK_NAME_MAX,
} from './webhook';

const UUID = '00000000-0000-0000-0000-000000000001';

describe('S84a webhook contracts (FR-RC11)', () => {
  describe('isReservedBotName', () => {
    it('rejects reserved names case/space-insensitively', () => {
      for (const n of RESERVED_BOT_NAMES) expect(isReservedBotName(n)).toBe(true);
      expect(isReservedBotName('System')).toBe(true);
      expect(isReservedBotName('  QUFOX ')).toBe(true);
      expect(isReservedBotName('Admin')).toBe(true);
    });
    it('allows non-reserved names', () => {
      expect(isReservedBotName('deploy-bot')).toBe(false);
      expect(isReservedBotName('systembot')).toBe(false);
      expect(isReservedBotName('qa')).toBe(false);
    });
  });

  describe('CreateWebhookRequestSchema', () => {
    it('accepts a minimal valid request', () => {
      const r = CreateWebhookRequestSchema.safeParse({ channelId: UUID, name: 'CI bot' });
      expect(r.success).toBe(true);
    });
    it('accepts optional botDisplayName + avatarUrl', () => {
      const r = CreateWebhookRequestSchema.safeParse({
        channelId: UUID,
        name: 'CI',
        botDisplayName: 'Deploy',
        avatarUrl: 'https://cdn.example.com/a.png',
      });
      expect(r.success).toBe(true);
    });
    it('rejects missing channelId', () => {
      expect(CreateWebhookRequestSchema.safeParse({ name: 'x' }).success).toBe(false);
    });
    it('rejects name over the max length', () => {
      const r = CreateWebhookRequestSchema.safeParse({
        channelId: UUID,
        name: 'a'.repeat(WEBHOOK_NAME_MAX + 1),
      });
      expect(r.success).toBe(false);
    });
    it('rejects a non-URL avatarUrl', () => {
      const r = CreateWebhookRequestSchema.safeParse({
        channelId: UUID,
        name: 'x',
        avatarUrl: 'not-a-url',
      });
      expect(r.success).toBe(false);
    });
    // S84a 리뷰 fix-forward (security LOW-6): http/https 외 scheme 거부(SSRF hardening).
    it('rejects a non-http(s) avatarUrl scheme', () => {
      for (const avatarUrl of [
        'ftp://host/a.png',
        'file:///etc/passwd',
        'data:image/png;base64,AA',
      ]) {
        const r = CreateWebhookRequestSchema.safeParse({ channelId: UUID, name: 'x', avatarUrl });
        expect(r.success).toBe(false);
      }
    });
  });

  describe('IncomingWebhookPayloadSchema', () => {
    it('accepts content with username/avatar_url override', () => {
      const r = IncomingWebhookPayloadSchema.safeParse({
        content: 'deploy succeeded',
        username: 'Deploy Bot',
        avatar_url: 'https://cdn.example.com/a.png',
      });
      expect(r.success).toBe(true);
    });
    it('rejects empty content', () => {
      expect(IncomingWebhookPayloadSchema.safeParse({ content: '' }).success).toBe(false);
    });
    it('rejects content over MESSAGE_MAX_LENGTH (4000)', () => {
      expect(IncomingWebhookPayloadSchema.safeParse({ content: 'a'.repeat(4001) }).success).toBe(
        false,
      );
    });
    it('rejects username over the max length', () => {
      const r = IncomingWebhookPayloadSchema.safeParse({
        content: 'hi',
        username: 'a'.repeat(WEBHOOK_NAME_MAX + 1),
      });
      expect(r.success).toBe(false);
    });
    it('note: reserved username passes schema (service enforces 422)', () => {
      // Reserved-word rejection is a service-layer 422 (WEBHOOK_NAME_RESERVED),
      // not a schema (400) concern — the schema only checks shape.
      expect(
        IncomingWebhookPayloadSchema.safeParse({ content: 'hi', username: 'system' }).success,
      ).toBe(true);
    });
  });

  describe('WebhookCreatedResponseSchema', () => {
    it('carries the one-time plaintext token + postUrl', () => {
      const r = WebhookCreatedResponseSchema.safeParse({
        id: UUID,
        workspaceId: UUID,
        channelId: UUID,
        name: 'CI',
        botDisplayName: null,
        avatarUrl: null,
        createdBy: UUID,
        createdAt: '2026-06-21T00:00:00.000Z',
        rotatedAt: null,
        revokedAt: null,
        lastUsedAt: null,
        token: 'whk_rawplaintext',
        postUrl: `/webhooks/${UUID}`,
      });
      expect(r.success).toBe(true);
    });
  });
});
