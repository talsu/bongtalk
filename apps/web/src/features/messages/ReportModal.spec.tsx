// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

// S64 (FR-RM11): ReportModal RTL. Dialog/Button pass-through 모킹(portal 회피) +
// reportMessage api 모킹으로 신고 제출/중복(409) 분기를 검증한다.
vi.mock('../../design-system/primitives', () => ({
  Dialog: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
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
}));

const pushMock = vi.fn();
vi.mock('../../stores/notification-store', () => ({
  useNotifications: () => ({ push: pushMock }),
}));

const reportMessageMock = vi.fn();
vi.mock('./api', () => ({
  reportMessage: (...args: unknown[]) => reportMessageMock(...args),
}));

import { ReportModal } from './ReportModal';

describe('ReportModal', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    pushMock.mockReset();
    reportMessageMock.mockReset();
  });
  afterEach(() => cleanup());

  it('submits the selected category + reason', async () => {
    reportMessageMock.mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<ReportModal workspaceId="ws" channelId="ch" messageId="m1" onClose={onClose} />);
    fireEvent.change(screen.getByTestId('report-category-select'), {
      target: { value: 'HARASSMENT' },
    });
    fireEvent.change(screen.getByTestId('report-modal-reason'), {
      target: { value: '괴롭힘 사례' },
    });
    fireEvent.click(screen.getByTestId('report-modal-submit'));
    await waitFor(() => {
      expect(reportMessageMock).toHaveBeenCalledWith('ws', 'ch', 'm1', {
        category: 'HARASSMENT',
        reason: '괴롭힘 사례',
      });
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(pushMock).toHaveBeenCalledWith(expect.objectContaining({ variant: 'success' }));
  });

  it('shows an info toast and closes on duplicate report (409)', async () => {
    reportMessageMock.mockRejectedValue(
      Object.assign(new Error('dup'), { errorCode: 'REPORT_DUPLICATE' }),
    );
    const onClose = vi.fn();
    render(<ReportModal workspaceId="ws" channelId="ch" messageId="m1" onClose={onClose} />);
    fireEvent.click(screen.getByTestId('report-modal-submit'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(pushMock).toHaveBeenCalledWith(expect.objectContaining({ variant: 'info' }));
  });
});
