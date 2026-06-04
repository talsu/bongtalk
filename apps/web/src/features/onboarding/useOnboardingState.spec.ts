import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OnboardingStateResponse } from '@qufox/shared-types';
import { shouldShowOnboarding } from './useOnboardingState';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
});

const RULE = { id: 'r1', position: 0, title: 'Be kind', description: null };
const QUESTION = {
  id: 'q1',
  position: 0,
  type: 'SHORT_TEXT' as const,
  isRequired: false,
  label: 'about',
  options: [],
};

function state(over: Partial<OnboardingStateResponse> = {}): OnboardingStateResponse {
  return {
    rulesAcceptedAt: null,
    onboardingCompletedAt: null,
    rules: [],
    questions: [],
    welcome: null,
    ...over,
  };
}

describe('S71 shouldShowOnboarding (Fork A-1)', () => {
  it('빈 카탈로그(규칙0·질문0·웰컴없음)는 표시하지 않습니다(자동 완료)', () => {
    expect(shouldShowOnboarding(state(), 'MEMBER')).toBe(false);
  });

  it('OWNER 는 카탈로그가 있어도 표시하지 않습니다(생성자 면제)', () => {
    expect(shouldShowOnboarding(state({ rules: [RULE] }), 'OWNER')).toBe(false);
  });

  it('규칙 존재 + 미동의 멤버는 표시합니다', () => {
    expect(shouldShowOnboarding(state({ rules: [RULE] }), 'MEMBER')).toBe(true);
  });

  it('규칙 동의 완료 + 다른 단계 없음이면 표시하지 않습니다', () => {
    expect(
      shouldShowOnboarding(
        state({
          rules: [RULE],
          rulesAcceptedAt: '2025-01-01T00:00:00.000Z',
          onboardingCompletedAt: '2025-01-01T00:00:00.000Z',
        }),
        'MEMBER',
      ),
    ).toBe(false);
  });

  it('질문 존재 + onboardingCompletedAt null 이면 표시합니다', () => {
    expect(shouldShowOnboarding(state({ questions: [QUESTION] }), 'MEMBER')).toBe(true);
  });

  it('웰컴만 있고 미완료여도 표시합니다', () => {
    expect(
      shouldShowOnboarding(
        state({ welcome: { welcomeChannelId: null, message: 'hi', todos: [] } }),
        'MEMBER',
      ),
    ).toBe(true);
  });

  it('상태 미로딩(undefined)은 표시하지 않습니다', () => {
    expect(shouldShowOnboarding(undefined, 'MEMBER')).toBe(false);
  });
});
