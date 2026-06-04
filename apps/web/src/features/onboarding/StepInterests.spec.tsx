// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { OnboardingQuestion } from '@qufox/shared-types';
import { StepInterests } from './StepInterests';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  cleanup();
});

const SHORT: OnboardingQuestion = {
  id: '11111111-1111-4111-8111-111111111111',
  position: 0,
  type: 'SHORT_TEXT',
  isRequired: true,
  label: '자기소개',
  options: [],
};

const SINGLE: OnboardingQuestion = {
  id: '22222222-2222-4222-8222-222222222222',
  position: 1,
  type: 'SINGLE',
  isRequired: true,
  label: '관심사',
  options: [
    { id: 'o1', label: 'FE', channelIds: [], roleId: null },
    { id: 'o2', label: 'BE', channelIds: [], roleId: null },
  ],
};

describe('S71 StepInterests (FR-W08) a11y', () => {
  it('HIGH-3: 필수 SHORT_TEXT textarea 에 aria-required + sr-only "필수 항목"', () => {
    render(
      <StepInterests
        questions={[SHORT]}
        pending={false}
        onComplete={() => undefined}
        onSkip={() => undefined}
      />,
    );
    const ta = screen.getByTestId(`q-text-${SHORT.id}`);
    expect(ta.getAttribute('aria-required')).toBe('true');
    // MAJOR-5: legend 와의 이중 발화 방지를 위해 aria-label 대신 aria-labelledby.
    expect(ta.getAttribute('aria-label')).toBeNull();
    expect(ta.getAttribute('aria-labelledby')).toBeTruthy();
    // qf-textarea 클래스(DS) 적용.
    expect(ta.className).toContain('qf-textarea');
    // sr-only 필수 항목 라벨.
    expect(screen.getByText('(필수 항목)')).toBeTruthy();
  });

  it('MINOR-2: 필수 SINGLE 옵션 컨테이너는 role=radiogroup + aria-required', () => {
    render(
      <StepInterests
        questions={[SINGLE]}
        pending={false}
        onComplete={() => undefined}
        onSkip={() => undefined}
      />,
    );
    const group = screen.getByRole('radiogroup');
    expect(group.getAttribute('aria-required')).toBe('true');
    expect(group.getAttribute('aria-labelledby')).toBeTruthy();
  });

  it('MAJOR-1: 소제목을 h3 로 노출한다', () => {
    render(
      <StepInterests
        questions={[SINGLE]}
        pending={false}
        onComplete={() => undefined}
        onSkip={() => undefined}
      />,
    );
    expect(screen.getByRole('heading', { name: '관심사 선택' }).tagName).toBe('H3');
  });

  it('SINGLE 선택 + 계속 시 선택한 optionId 가 answers 로 모인다', () => {
    const onComplete = vi.fn();
    render(
      <StepInterests
        questions={[SINGLE]}
        pending={false}
        onComplete={onComplete}
        onSkip={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId(`q-opt-${SINGLE.id}-o2`));
    fireEvent.click(screen.getByTestId('onboarding-complete'));
    expect(onComplete).toHaveBeenCalledWith([{ questionId: SINGLE.id, optionIds: ['o2'] }]);
  });
});
