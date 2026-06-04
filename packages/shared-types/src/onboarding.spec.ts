import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AcceptRulesResponseSchema,
  CompleteOnboardingRequestSchema,
  CompleteOnboardingResponseSchema,
  ONBOARDING_OPTIONS_MAX,
  ONBOARDING_QUESTIONS_MAX,
  OnboardingQuestionSchema,
  OnboardingStateResponseSchema,
  QuestionTypeSchema,
  ReorderRulesRequestSchema,
  UpsertQuestionRequestSchema,
  UpsertWelcomeRequestSchema,
  UpsertWorkspaceRuleRequestSchema,
  WORKSPACE_RULES_MAX,
  WorkspaceRuleSchema,
  WorkspaceWelcomeSchema,
} from './onboarding';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const RULE_ID = '11111111-1111-4111-8111-111111111111';
const Q_ID = '22222222-2222-4222-8222-222222222222';
const CH_ID = '33333333-3333-4333-8333-333333333333';
const ROLE_ID = '44444444-4444-4444-8444-444444444444';
const TS = '2025-01-01T00:00:00.000Z';

describe('S71 QuestionTypeSchema', () => {
  it('accepts the three canonical types', () => {
    expect(QuestionTypeSchema.parse('SINGLE')).toBe('SINGLE');
    expect(QuestionTypeSchema.parse('MULTI')).toBe('MULTI');
    expect(QuestionTypeSchema.parse('SHORT_TEXT')).toBe('SHORT_TEXT');
  });
  it('rejects unknown types', () => {
    expect(() => QuestionTypeSchema.parse('DROPDOWN')).toThrow();
  });
});

describe('S71 WorkspaceRuleSchema round-trip', () => {
  it('accepts a valid rule with null description', () => {
    const rule = { id: RULE_ID, position: 0, title: 'Be kind', description: null };
    expect(WorkspaceRuleSchema.parse(rule)).toEqual(rule);
  });
  it('rejects an over-long title', () => {
    expect(() =>
      WorkspaceRuleSchema.parse({
        id: RULE_ID,
        position: 0,
        title: 'x'.repeat(101),
        description: null,
      }),
    ).toThrow();
  });
  it('rejects an empty title', () => {
    expect(() =>
      WorkspaceRuleSchema.parse({ id: RULE_ID, position: 0, title: '', description: null }),
    ).toThrow();
  });
});

describe('S71 OnboardingQuestionSchema round-trip', () => {
  it('accepts a SINGLE question with options', () => {
    const q = {
      id: Q_ID,
      position: 0,
      type: 'SINGLE' as const,
      isRequired: true,
      label: 'What are you into?',
      options: [{ id: 'o1', label: 'Frontend', channelIds: [CH_ID], roleId: ROLE_ID }],
    };
    const parsed = OnboardingQuestionSchema.parse(q);
    expect(parsed.options[0].channelIds).toEqual([CH_ID]);
    expect(parsed.options[0].roleId).toBe(ROLE_ID);
  });
  it('defaults option channelIds to []', () => {
    const parsed = OnboardingQuestionSchema.parse({
      id: Q_ID,
      position: 0,
      type: 'SHORT_TEXT',
      isRequired: false,
      label: 'Tell us about you',
      options: [],
    });
    expect(parsed.options).toEqual([]);
  });
  it('rejects more than ONBOARDING_OPTIONS_MAX options', () => {
    const options = Array.from({ length: ONBOARDING_OPTIONS_MAX + 1 }, (_, i) => ({
      id: `o${i}`,
      label: `opt${i}`,
      channelIds: [],
    }));
    expect(() =>
      OnboardingQuestionSchema.parse({
        id: Q_ID,
        position: 0,
        type: 'MULTI',
        isRequired: false,
        label: 'pick',
        options,
      }),
    ).toThrow();
  });
});

describe('S71 OnboardingStateResponseSchema', () => {
  it('accepts a fully-populated state', () => {
    const state = {
      rulesAcceptedAt: null,
      onboardingCompletedAt: null,
      rules: [{ id: RULE_ID, position: 0, title: 'r', description: null }],
      questions: [],
      welcome: { welcomeChannelId: CH_ID, message: 'Welcome!', todos: ['say hi'] },
    };
    expect(OnboardingStateResponseSchema.parse(state)).toEqual(state);
  });
  it('accepts null welcome + ISO timestamps', () => {
    const state = {
      rulesAcceptedAt: TS,
      onboardingCompletedAt: TS,
      rules: [],
      questions: [],
      welcome: null,
    };
    expect(OnboardingStateResponseSchema.parse(state)).toEqual(state);
  });
});

describe('S71 CompleteOnboardingRequestSchema', () => {
  it('defaults answers to [] (skip)', () => {
    expect(CompleteOnboardingRequestSchema.parse({})).toEqual({ answers: [] });
  });
  it('accepts SINGLE/MULTI optionIds and SHORT_TEXT text', () => {
    const parsed = CompleteOnboardingRequestSchema.parse({
      answers: [
        { questionId: Q_ID, optionIds: ['o1'] },
        { questionId: RULE_ID, optionIds: [], text: 'hello' },
      ],
    });
    expect(parsed.answers).toHaveLength(2);
  });
  it('rejects more than ONBOARDING_QUESTIONS_MAX answers', () => {
    const answers = Array.from({ length: ONBOARDING_QUESTIONS_MAX + 1 }, () => ({
      questionId: Q_ID,
      optionIds: [],
    }));
    expect(() => CompleteOnboardingRequestSchema.parse({ answers })).toThrow();
  });
});

describe('S71 CompleteOnboardingResponseSchema', () => {
  it('round-trips counts + timestamp', () => {
    const res = { onboardingCompletedAt: TS, joinedChannelCount: 2, assignedRoleCount: 1 };
    expect(CompleteOnboardingResponseSchema.parse(res)).toEqual(res);
  });
});

describe('S71 AcceptRulesResponseSchema', () => {
  it('round-trips the acceptance timestamp', () => {
    expect(AcceptRulesResponseSchema.parse({ rulesAcceptedAt: TS })).toEqual({
      rulesAcceptedAt: TS,
    });
  });
});

describe('S71 admin CRUD requests', () => {
  it('UpsertWorkspaceRuleRequestSchema accepts title + optional description', () => {
    expect(UpsertWorkspaceRuleRequestSchema.parse({ title: 'r' })).toEqual({ title: 'r' });
  });
  it('ReorderRulesRequestSchema rejects empty list', () => {
    expect(() => ReorderRulesRequestSchema.parse({ ruleIds: [] })).toThrow();
  });
  it('ReorderRulesRequestSchema rejects more than WORKSPACE_RULES_MAX', () => {
    const ruleIds = Array.from({ length: WORKSPACE_RULES_MAX + 1 }, () => RULE_ID);
    expect(() => ReorderRulesRequestSchema.parse({ ruleIds })).toThrow();
  });
  it('UpsertQuestionRequestSchema defaults isRequired=false + options=[]', () => {
    const parsed = UpsertQuestionRequestSchema.parse({ type: 'SHORT_TEXT', label: 'q' });
    expect(parsed.isRequired).toBe(false);
    expect(parsed.options).toEqual([]);
  });
  it('UpsertWelcomeRequestSchema defaults todos=[]', () => {
    expect(UpsertWelcomeRequestSchema.parse({})).toEqual({ todos: [] });
  });
});

describe('S71 WorkspaceWelcomeSchema', () => {
  it('rejects more than 5 todos', () => {
    expect(() =>
      WorkspaceWelcomeSchema.parse({
        welcomeChannelId: null,
        message: null,
        todos: ['a', 'b', 'c', 'd', 'e', 'f'],
      }),
    ).toThrow();
  });
});
