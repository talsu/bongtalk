// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));

const pushNotify = vi.fn();
vi.mock('../../stores/notification-store', () => ({
  useNotifications: (sel: (s: { push: typeof pushNotify }) => unknown) => sel({ push: pushNotify }),
}));

vi.mock('../../design-system/primitives', () => ({
  Button: ({
    children,
    onClick,
    type,
    ...rest
  }: {
    children?: ReactNode;
    onClick?: () => void;
    type?: 'button' | 'submit';
    [k: string]: unknown;
  }) => (
    <button type={type ?? 'button'} onClick={onClick} {...rest}>
      {children}
    </button>
  ),
}));

const submitMut = { mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false };
vi.mock('./useApplications', () => ({
  useSubmitApplication: () => submitMut,
}));

import { ApplicationForm } from './ApplicationForm';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  navigate.mockReset();
  pushNotify.mockReset();
  submitMut.mutateAsync.mockReset().mockResolvedValue(undefined);
});
afterEach(() => cleanup());

const REQUIRED_Q = [{ id: 'why', label: '가입 이유', required: true }];

describe('S70 ApplicationForm (FR-W06)', () => {
  it('ui HIGH/B-2: 답변 입력은 qf-textarea 클래스를 쓴다', () => {
    render(<ApplicationForm slug="acme" />);
    const ta = screen.getByTestId('application-answer-intro');
    expect(ta.className).toContain('qf-textarea');
  });

  it('a11y H-2: form 은 제목으로 aria-labelledby 연결된다', () => {
    render(<ApplicationForm slug="acme" />);
    const title = document.getElementById('application-form-title');
    expect(title).toBeTruthy();
    const section = title?.closest('[aria-labelledby="application-form-title"]');
    expect(section).toBeTruthy();
  });

  it('a11y H-1: 필수 질문 textarea 는 aria-required=true', () => {
    render(<ApplicationForm slug="acme" questions={REQUIRED_Q} />);
    const ta = screen.getByTestId('application-answer-why');
    expect(ta.getAttribute('aria-required')).toBe('true');
  });

  it('a11y B-3: 필수 미응답 제출 시 aria-invalid + role=alert 오류 + 포커스 이동', () => {
    render(<ApplicationForm slug="acme" questions={REQUIRED_Q} />);
    fireEvent.submit(screen.getByTestId('application-answer-why').closest('form')!);
    const ta = screen.getByTestId('application-answer-why');
    expect(ta.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toContain('필수');
    expect(document.activeElement).toBe(ta);
    expect(submitMut.mutateAsync).not.toHaveBeenCalled();
    expect(pushNotify).toHaveBeenCalledWith(expect.objectContaining({ variant: 'warning' }));
  });

  it('유효 제출 시 mutation 호출 후 대기 화면으로 이동한다', async () => {
    render(<ApplicationForm slug="acme" />);
    const ta = screen.getByTestId('application-answer-intro');
    fireEvent.change(ta, { target: { value: '안녕하세요' } });
    fireEvent.submit(ta.closest('form')!);
    await vi.waitFor(() => expect(submitMut.mutateAsync).toHaveBeenCalled());
    expect(submitMut.mutateAsync).toHaveBeenCalledWith([
      { questionId: 'intro', answer: '안녕하세요' },
    ]);
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/w/acme/pending'));
  });
});
