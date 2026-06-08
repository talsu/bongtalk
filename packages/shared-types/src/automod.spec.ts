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

    // FR-RM10b: MENTION_SPAM 은 keywords/matchMode 가 아니라 threshold/window 를 요구한다 —
    // KEYWORD 모양으로 보내면(spam 필드 누락) discriminatedUnion 이 거부한다.
    it('rejects a MENTION_SPAM rule shaped like a KEYWORD rule (missing threshold/window)', () => {
      const parsed = CreateAutoModRuleRequestSchema.safeParse({
        ...base,
        triggerType: 'MENTION_SPAM',
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects an unknown trigger type', () => {
      const parsed = CreateAutoModRuleRequestSchema.safeParse({ ...base, triggerType: 'BOGUS' });
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

    // FR-RM10b: KEYWORD 트리거가 matchMode='REGEX' 를 허용한다(ReDoS 검증은 서버 worker).
    it('accepts a KEYWORD rule with matchMode REGEX', () => {
      const parsed = CreateAutoModRuleRequestSchema.safeParse({
        ...base,
        matchMode: 'REGEX',
        keywords: ['\\d{4,}'],
      });
      expect(parsed.success).toBe(true);
    });
  });

  // FR-RM10b: MENTION_SPAM / REPEAT_SPAM 트리거의 discriminated union 멤버 검증.
  describe('CreateAutoModRuleRequestSchema — spam triggers', () => {
    it('accepts a MENTION_SPAM rule with threshold + window', () => {
      const parsed = CreateAutoModRuleRequestSchema.safeParse({
        name: 'mention spam',
        triggerType: 'MENTION_SPAM',
        mentionThreshold: 5,
        windowSeconds: 60,
        action: 'BLOCK',
      });
      expect(parsed.success).toBe(true);
    });

    it('accepts a REPEAT_SPAM rule with threshold + window', () => {
      const parsed = CreateAutoModRuleRequestSchema.safeParse({
        name: 'repeat spam',
        triggerType: 'REPEAT_SPAM',
        repeatThreshold: 3,
        windowSeconds: 30,
        action: 'TIMEOUT',
        timeoutSeconds: 300,
      });
      expect(parsed.success).toBe(true);
    });

    it('rejects spam threshold below the minimum', () => {
      const parsed = CreateAutoModRuleRequestSchema.safeParse({
        name: 'spam',
        triggerType: 'MENTION_SPAM',
        mentionThreshold: 0,
        windowSeconds: 60,
        action: 'BLOCK',
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects spam window below the minimum', () => {
      const parsed = CreateAutoModRuleRequestSchema.safeParse({
        name: 'spam',
        triggerType: 'REPEAT_SPAM',
        repeatThreshold: 3,
        windowSeconds: 1,
        action: 'BLOCK',
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects spam window above the maximum', () => {
      const parsed = CreateAutoModRuleRequestSchema.safeParse({
        name: 'spam',
        triggerType: 'MENTION_SPAM',
        mentionThreshold: 5,
        windowSeconds: 99999,
        action: 'BLOCK',
      });
      expect(parsed.success).toBe(false);
    });

    it('rejects MENTION_SPAM TIMEOUT without timeoutSeconds (refine)', () => {
      const parsed = CreateAutoModRuleRequestSchema.safeParse({
        name: 'spam',
        triggerType: 'MENTION_SPAM',
        mentionThreshold: 5,
        windowSeconds: 60,
        action: 'TIMEOUT',
      });
      expect(parsed.success).toBe(false);
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
    it('validates a KEYWORD rule DTO list (FR-RM10b: spam fields nullable)', () => {
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
            mentionThreshold: null,
            repeatThreshold: null,
            windowSeconds: null,
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

    it('validates a MENTION_SPAM rule DTO (threshold/window populated)', () => {
      const parsed = ListAutoModRulesResponseSchema.safeParse({
        rules: [
          {
            id: UUID,
            workspaceId: UUID,
            name: 'mspam',
            triggerType: 'MENTION_SPAM',
            keywords: [],
            matchMode: 'SUBSTRING',
            action: 'BLOCK',
            timeoutSeconds: null,
            mentionThreshold: 5,
            repeatThreshold: null,
            windowSeconds: 60,
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
