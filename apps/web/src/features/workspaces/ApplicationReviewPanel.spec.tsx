// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { WorkspaceMemberApplication } from '@qufox/shared-types';

const pushNotify = vi.fn();
vi.mock('../../stores/notification-store', () => ({
  useNotifications: (sel: (s: { push: typeof pushNotify }) => unknown) => sel({ push: pushNotify }),
}));

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
  Icon: () => <span />,
  // Dialog: open 일 때만 children 을 렌더하고, alertDialog 면 role 을 노출한다.
  Dialog: ({
    open,
    alertDialog,
    title,
    children,
  }: {
    open: boolean;
    alertDialog?: boolean;
    title: string;
    children: ReactNode;
  }) =>
    open ? (
      <div role={alertDialog ? 'alertdialog' : 'dialog'} aria-label={title}>
        {children}
      </div>
    ) : null,
}));

const processMut = { mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false };
let pending: { data: { applications: WorkspaceMemberApplication[] }; isLoading: boolean };
let interview: { data: { applications: WorkspaceMemberApplication[] }; isLoading: boolean };
vi.mock('./useApplications', () => ({
  useApplications: (_slug: string, status?: string) =>
    status === 'INTERVIEW' ? interview : pending,
  useProcessApplication: () => processMut,
}));

// S71 (S70 연계): 패널이 질문 카탈로그(listQuestions)를 useQuery 로 읽어 dt 라벨을 개선한다.
// 테스트는 react-query useQuery 를 가벼운 stub 으로 대체해 QueryClientProvider 없이 렌더한다
// (questionsData 를 케이스별로 주입). 기본은 빈 목록(폴백 경로 — 기존 동작 유지).
let questionsData: { questions: { id: string; label: string }[] } = { questions: [] };
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: questionsData, isLoading: false }),
}));
vi.mock('../onboarding/api', () => ({
  listQuestions: vi.fn().mockResolvedValue({ questions: [] }),
}));

import { ApplicationReviewPanel } from './ApplicationReviewPanel';

function app(over: Partial<WorkspaceMemberApplication> = {}): WorkspaceMemberApplication {
  return {
    id: 'app-1',
    workspaceId: 'ws-1',
    applicantId: 'u-1',
    status: 'PENDING',
    answers: [{ questionId: 'q-uuid-1', answer: '안녕하세요' }],
    reviewedById: null,
    reviewNote: null,
    interviewChannelId: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    applicant: { id: 'u-1', username: 'alice' },
    ...over,
  };
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  pushNotify.mockReset();
  processMut.mutateAsync.mockReset().mockResolvedValue(undefined);
  pending = { data: { applications: [app()] }, isLoading: false };
  interview = { data: { applications: [] }, isLoading: false };
  questionsData = { questions: [] };
});
afterEach(() => cleanup());

describe('S70 ApplicationReviewPanel (FR-W06)', () => {
  it('enabled=false 면 렌더하지 않는다', () => {
    const { container } = render(<ApplicationReviewPanel slug="acme" enabled={false} canApprove />);
    expect(container.firstChild).toBeNull();
  });

  it('ui MEDIUM: 거절 버튼은 danger 변형이다', () => {
    render(<ApplicationReviewPanel slug="acme" enabled canApprove />);
    const reject = screen.getByTestId('application-reject-app-1');
    expect(reject.getAttribute('variant')).toBe('danger');
  });

  it('a11y H-5: 질문 카탈로그 미매칭이면 questionId 원문 + "질문 N" aria-label 폴백', () => {
    render(<ApplicationReviewPanel slug="acme" enabled canApprove />);
    const dt = screen.getByText('q-uuid-1');
    expect(dt.getAttribute('aria-label')).toBe('질문 1');
  });

  it('S71 연계: 질문 카탈로그에 매칭되면 dt 에 질문 본문(label)을 노출한다', () => {
    questionsData = { questions: [{ id: 'q-uuid-1', label: '어떤 일을 하시나요?' }] };
    render(<ApplicationReviewPanel slug="acme" enabled canApprove />);
    const dt = screen.getByText('어떤 일을 하시나요?');
    expect(dt.getAttribute('aria-label')).toBe('어떤 일을 하시나요?');
  });

  it('a11y M-3: section 은 제목으로 aria-labelledby 연결된다', () => {
    render(<ApplicationReviewPanel slug="acme" enabled canApprove />);
    const panel = screen.getByTestId('application-review-panel');
    expect(panel.getAttribute('aria-labelledby')).toBe('application-review-heading');
    expect(document.getElementById('application-review-heading')).toBeTruthy();
  });

  it('a11y H-6: 거절 클릭은 즉시 처리하지 않고 alertdialog 확인을 연다', () => {
    render(<ApplicationReviewPanel slug="acme" enabled canApprove />);
    fireEvent.click(screen.getByTestId('application-reject-app-1'));
    // 아직 mutation 미호출(확인 대기).
    expect(processMut.mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    // 확인 클릭 시에만 reject 가 실행된다.
    fireEvent.click(screen.getByTestId('application-reject-confirm'));
    expect(processMut.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ applicationId: 'app-1', action: 'reject' }),
    );
  });

  it('승인 클릭은 곧바로 approve 를 호출한다', () => {
    render(<ApplicationReviewPanel slug="acme" enabled canApprove />);
    fireEvent.click(screen.getByTestId('application-approve-app-1'));
    expect(processMut.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ applicationId: 'app-1', action: 'approve' }),
    );
  });

  it('a11y M-4: PENDING/INTERVIEW 중 하나라도 로딩이면 busy 표시', () => {
    pending = { data: { applications: [] }, isLoading: false };
    interview = { data: { applications: [] }, isLoading: true };
    render(<ApplicationReviewPanel slug="acme" enabled canApprove />);
    // sr-only 라이브 영역 + 로딩 문단이 모두 role=status 라, 텍스트로 로딩 문단을 특정한다.
    const busy = screen.getByText('불러오는 중…');
    expect(busy.getAttribute('aria-busy')).toBe('true');
  });
});
