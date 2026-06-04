// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../design-system/primitives', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...rest
  }: {
    children?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    [k: string]: unknown;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
  // 정적 a11y 가드(input-label-guard)가 mock 요소도 스캔하므로 한 줄에 aria-label 을 명시한다
  // (실제 DS Input 은 props.aria-label 을 forward — 동일 의미).
  // prettier-ignore
  Input: (props: Record<string, unknown>) => <input aria-label="mock" {...props} />,
  Dialog: ({
    open,
    alertDialog,
    title,
    description,
    children,
  }: {
    open: boolean;
    alertDialog?: boolean;
    title: string;
    description?: string;
    children: ReactNode;
  }) =>
    open ? (
      <div role={alertDialog ? 'alertdialog' : 'dialog'} aria-label={title}>
        {description ? <p>{description}</p> : null}
        {children}
      </div>
    ) : null,
}));

// 규칙 1개를 가진 목록을 반환하는 useQuery stub. useMutation 은 mutate 를 기록한다.
const removeRule = vi.fn();
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    if (queryKey[2] === 'rules') {
      return { data: { rules: [{ id: 'rule-1', position: 0, title: '존중', description: null }] } };
    }
    if (queryKey[2] === 'questions') return { data: { questions: [] } };
    return { data: { welcome: null } };
  },
  useMutation: ({ mutationFn }: { mutationFn: (arg?: unknown) => unknown }) => ({
    mutate: (arg?: unknown) => {
      if (typeof arg === 'string') removeRule(arg);
      return mutationFn(arg);
    },
    isPending: false,
  }),
}));

vi.mock('./api', () => ({
  listRules: vi.fn(),
  listQuestions: vi.fn(),
  getWelcome: vi.fn(),
  createRule: vi.fn(),
  createQuestion: vi.fn(),
  deleteRule: vi.fn(),
  deleteQuestion: vi.fn(),
  upsertWelcome: vi.fn(),
}));

import { OnboardingSettingsPanel } from './OnboardingSettingsPanel';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  removeRule.mockReset();
});
afterEach(() => cleanup());

describe('S71 OnboardingSettingsPanel (FR-W07) 삭제 확인 + danger', () => {
  it('ui MEDIUM: 규칙 삭제 버튼은 danger 변형이다', () => {
    render(<OnboardingSettingsPanel slug="acme" />);
    expect(screen.getByTestId('rule-delete-rule-1').getAttribute('variant')).toBe('danger');
  });

  it('a11y MAJOR-3: 삭제 클릭은 즉시 삭제하지 않고 alertDialog 확인 후 실행한다', () => {
    render(<OnboardingSettingsPanel slug="acme" />);
    // 삭제 클릭 → 아직 mutate 안 됨(확인 단계).
    fireEvent.click(screen.getByTestId('rule-delete-rule-1'));
    expect(removeRule).not.toHaveBeenCalled();
    // alertDialog 가 "되돌릴 수 없음" 을 안내.
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('되돌릴 수 없습니다');
    // 확인 → 실제 삭제 실행.
    fireEvent.click(screen.getByTestId('rule-delete-confirm'));
    expect(removeRule).toHaveBeenCalledWith('rule-1');
  });

  it('취소하면 삭제하지 않는다', () => {
    render(<OnboardingSettingsPanel slug="acme" />);
    fireEvent.click(screen.getByTestId('rule-delete-rule-1'));
    fireEvent.click(screen.getByTestId('rule-delete-cancel'));
    expect(removeRule).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
