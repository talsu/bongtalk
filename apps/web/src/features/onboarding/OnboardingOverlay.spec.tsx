// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { OnboardingStateResponse } from '@qufox/shared-types';

// Dialog stub: open 일 때 children + title/description 을 노출(focus trap 없이 children 렌더).
vi.mock('../../design-system/primitives', async () => {
  const actual = await vi.importActual<typeof import('../../design-system/primitives')>(
    '../../design-system/primitives',
  );
  return {
    ...actual,
    Dialog: ({
      open,
      title,
      description,
      children,
    }: {
      open: boolean;
      title: string;
      description?: string;
      children: ReactNode;
    }) =>
      open ? (
        <div role="dialog" aria-label={title}>
          {description ? <p data-testid="dialog-description">{description}</p> : null}
          {children}
        </div>
      ) : null,
  };
});

const acceptMut = { mutateAsync: vi.fn().mockResolvedValue({}), isPending: false };
const completeMut = { mutateAsync: vi.fn().mockResolvedValue({}), isPending: false };
vi.mock('./useOnboardingState', () => ({
  useAcceptRules: () => acceptMut,
  useCompleteOnboarding: () => completeMut,
}));

import { OnboardingOverlay } from './OnboardingOverlay';

function state(over: Partial<OnboardingStateResponse> = {}): OnboardingStateResponse {
  return {
    rulesAcceptedAt: null,
    onboardingCompletedAt: null,
    rules: [{ id: 'r1', position: 0, title: '존중', description: null }],
    questions: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        position: 0,
        type: 'SHORT_TEXT',
        isRequired: false,
        label: '소개',
        options: [],
      },
    ],
    welcome: null,
    ...over,
  };
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  acceptMut.mutateAsync.mockClear();
  completeMut.mutateAsync.mockClear();
});
afterEach(() => cleanup());

describe('S71 OnboardingOverlay a11y', () => {
  it('HIGH-1 + MAJOR-2: 영속 progressbar + aria-live 진행 라벨을 Dialog 내에 단일 선언한다', () => {
    render(<OnboardingOverlay slug="acme" state={state()} />);
    const progress = screen.getByTestId('onboarding-progress');
    expect(progress.getAttribute('role')).toBe('progressbar');
    expect(progress.getAttribute('aria-valuenow')).toBe('1');
    expect(progress.getAttribute('aria-valuemax')).toBe('2'); // rules + questions
    expect(progress.getAttribute('aria-valuetext')).toContain('단계');
    // aria-live 라벨이 progressbar 내부에 존재.
    expect(progress.querySelector('[aria-live="polite"]')).not.toBeNull();
  });

  it('HIGH-2: 규칙 단계는 "닫을 수 없음" 사유를 Dialog description 으로 노출한다', () => {
    render(<OnboardingOverlay slug="acme" state={state()} />);
    expect(screen.getByTestId('dialog-description').textContent).toContain('닫을 수 없습니다');
  });

  it('BLK-2: 단계 진입 시 현재 Step 루트(tabIndex=-1)로 포커스를 옮긴다', async () => {
    render(<OnboardingOverlay slug="acme" state={state()} />);
    const root = screen.getByTestId('onboarding-step-rules');
    expect(root.getAttribute('tabindex')).toBe('-1');
    await waitFor(() => expect(document.activeElement).toBe(root));
  });

  it('MINOR-1: 오버레이가 열린 동안 document.title 을 갱신하고 닫히면 복원한다', () => {
    document.title = '원래 제목';
    const { unmount } = render(<OnboardingOverlay slug="acme" state={state()} />);
    expect(document.title).toContain('워크스페이스 온보딩');
    unmount();
    expect(document.title).toBe('원래 제목');
  });
});
