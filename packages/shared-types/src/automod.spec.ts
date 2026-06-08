import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AUTOMOD_KEYWORDS_MAX,
  AUTOMOD_KEYWORD_MAX_LEN,
  AUTOMOD_EXEMPT_ROLES_MAX,
  AUTOMOD_EXEMPT_CHANNELS_MAX,
  AUTOMOD_RULES_PER_WORKSPACE_MAX,
  CreateAutoModRuleRequestSchema,
  UpdateAutoModRuleRequestSchema,
  ListAutoModRulesResponseSchema,
} from './automod';

const UUID = '11111111-1111-1111-1111-111111111111';

/** UUID v4-shaped generator so cap tests use distinct valid uuids. */
function uuid(n: number): string {
  const hex = n.toString(16).padStart(12, '0');
  return `11111111-1111-4111-8111-${hex}`;
}

describe('FR-RM10a AutoMod Zod contracts', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  });

  describe('CreateAutoModRuleRequestSchema', () => {
    const base = {
      name: 'bad words',
      triggerType: 'KEYWORD' as const,
      keywords: ['spam'],
      matchMode: 'SUBSTRING' as const,
      action: 'BLOCK' as const,
    };

    it('accepts a minimal valid BLOCK rule', () => {
      const parsed = CreateAutoModRuleRequestSchema.safeParse(base);
      expect(parsed.success).toBe(true);
    });

    it('rejects non-KEYWORD trigger (FR-RM10a is KEYWORD-only)', () => {
      const parsed = CreateAutoModRuleRequestSchema.safeParse({
        ...base,
        triggerType: 'MENTION_SPAM',
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects empty keywords array', () => {
      const parsed = CreateAutoModRuleRequestSchema.safeParse({ ...base, keywords: [] });
      expect(parsed.success).toBe(false);
    });

    it('rejects more than the keyword cap', () => {
      const keywords = Array.from({ length: AUTOMOD_KEYWORDS_MAX + 1 }, (_, i) => `kw${i}`);
      const parsed = CreateAutoModRuleRequestSchema.safeParse({ ...base, keywords });
      expect(parsed.success).toBe(false);
    });

    it('accepts exactly the keyword cap', () => {
      const keywords = Array.from({ length: AUTOMOD_KEYWORDS_MAX }, (_, i) => `kw${i}`);
      const parsed = CreateAutoModRuleRequestSchema.safeParse({ ...base, keywords });
      expect(parsed.success).toBe(true);
    });

    it('rejects a keyword over the per-keyword length cap', () => {
      const parsed = CreateAutoModRuleRequestSchema.safeParse({
        ...base,
        keywords: ['x'.repeat(AUTOMOD_KEYWORD_MAX_LEN + 1)],
      });
      expect(parsed.success).toBe(false);
    });

    it('trims keywords and rejects whitespace-only', () => {
      const parsed = CreateAutoModRuleRequestSchema.safeParse({ ...base, keywords: ['   '] });
      expect(parsed.success).toBe(false);
    });

    it('requires timeoutSeconds when action is TIMEOUT (refine)', () => {
      const parsed = CreateAutoModRuleRequestSchema.safeParse({ ...base, action: 'TIMEOUT' });
      expect(parsed.success).toBe(false);
    });

    it('accepts TIMEOUT with valid timeoutSeconds', () => {
      const parsed = CreateAutoModRuleRequestSchema.safeParse({
        ...base,
        action: 'TIMEOUT',
        timeoutSeconds: 300,
      });
      expect(parsed.success).toBe(true);
    });

    it('rejects timeoutSeconds below the minimum', () => {
      const parsed = CreateAutoModRuleRequestSchema.safeParse({
        ...base,
        action: 'TIMEOUT',
        timeoutSeconds: 10,
      });
      expect(parsed.success).toBe(false);
    });

    it('accepts exempt role/channel uuid arrays', () => {
      const parsed = CreateAutoModRuleRequestSchema.safeParse({
        ...base,
        exemptRoleIds: [UUID],
        exemptChannelIds: [UUID],
      });
      expect(parsed.success).toBe(true);
    });

    it('rejects non-uuid exempt ids', () => {
      const parsed = CreateAutoModRuleRequestSchema.safeParse({
        ...base,
        exemptRoleIds: ['not-a-uuid'],
      });
      expect(parsed.success).toBe(false);
    });

    // ★리뷰 F5: exempt cap 은 keywords/규칙 cap 과 무관한 별도 상수(50)다.
    it('uses a dedicated exempt cap distinct from the per-workspace rule cap', () => {
      expect(AUTOMOD_EXEMPT_ROLES_MAX).toBe(50);
      expect(AUTOMOD_EXEMPT_CHANNELS_MAX).toBe(50);
      expect(AUTOMOD_EXEMPT_ROLES_MAX).not.toBe(AUTOMOD_RULES_PER_WORKSPACE_MAX);
    });

    it('accepts exactly the exempt-role cap and rejects one over', () => {
      const ok = Array.from({ length: AUTOMOD_EXEMPT_ROLES_MAX }, (_, i) => uuid(i));
      expect(CreateAutoModRuleRequestSchema.safeParse({ ...base, exemptRoleIds: ok }).success).toBe(
        true,
      );
      const over = Array.from({ length: AUTOMOD_EXEMPT_ROLES_MAX + 1 }, (_, i) => uuid(i));
      expect(
        CreateAutoModRuleRequestSchema.safeParse({ ...base, exemptRoleIds: over }).success,
      ).toBe(false);
    });

    it('rejects exempt channels over the dedicated cap', () => {
      const over = Array.from({ length: AUTOMOD_EXEMPT_CHANNELS_MAX + 1 }, (_, i) => uuid(i));
      expect(
        CreateAutoModRuleRequestSchema.safeParse({ ...base, exemptChannelIds: over }).success,
      ).toBe(false);
    });
  });

  describe('UpdateAutoModRuleRequestSchema', () => {
    it('accepts an empty partial update', () => {
      expect(UpdateAutoModRuleRequestSchema.safeParse({}).success).toBe(true);
    });

    it('requires timeoutSeconds when switching action to TIMEOUT', () => {
      expect(UpdateAutoModRuleRequestSchema.safeParse({ action: 'TIMEOUT' }).success).toBe(false);
      expect(
        UpdateAutoModRuleRequestSchema.safeParse({ action: 'TIMEOUT', timeoutSeconds: 600 })
          .success,
      ).toBe(true);
    });

    it('allows action to non-TIMEOUT without timeoutSeconds', () => {
      expect(UpdateAutoModRuleRequestSchema.safeParse({ action: 'BLOCK' }).success).toBe(true);
    });

    it('rejects empty keywords array on update', () => {
      expect(UpdateAutoModRuleRequestSchema.safeParse({ keywords: [] }).success).toBe(false);
    });

    it('allows toggling enabled only', () => {
      expect(UpdateAutoModRuleRequestSchema.safeParse({ enabled: false }).success).toBe(true);
    });
  });

  describe('ListAutoModRulesResponseSchema', () => {
    it('validates a rule DTO list', () => {
      const parsed = ListAutoModRulesResponseSchema.safeParse({
        rules: [
          {
            id: UUID,
            workspaceId: UUID,
            name: 'rule',
            triggerType: 'KEYWORD',
            keywords: ['spam'],
            matchMode: 'WORD',
            action: 'ALERT',
            timeoutSeconds: null,
            exemptRoleIds: [],
            exemptChannelIds: [],
            enabled: true,
            createdBy: UUID,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
          },
        ],
      });
      expect(parsed.success).toBe(true);
    });
  });
});
