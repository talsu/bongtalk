// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { ModerationReport } from '@qufox/shared-types';

// S64 (FR-RM11): ReportQueuePanel RTL. Dialog/Button pass-through + useReports/
// useResolveReport 모킹으로 큐 목록·필터·처리 모달 제출을 검증한다.
vi.mock('../../../design-system/primitives', () => ({
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
vi.mock('../../../stores/notification-store', () => ({
  useNotifications: () => ({ push: pushMock }),
}));

const resolveMutateAsync = vi.fn();
let reportsData: ModerationReport[] = [];
vi.mock('../useModeration', () => ({
  useReports: () => ({ data: { reports: reportsData }, isLoading: false, isError: false }),
  useResolveReport: () => ({ mutateAsync: resolveMutateAsync, isPending: false }),
}));

import { ReportQueuePanel } from './ReportQueuePanel';

function report(over: Partial<ModerationReport>): ModerationReport {
  return {
    id: over.id ?? 'rep-1',
    workspaceId: 'ws',
    messageId: 'm1',
    channelId: 'ch',
    reporterId: 'u-reporter',
    category: over.category ?? 'SPAM',
    reason: over.reason ?? null,
    createdAt: '2025-01-01T00:00:00.000Z',
    resolvedAt: over.resolvedAt ?? null,
    resolvedBy: over.resolvedBy ?? null,
    resolvedAction: over.resolvedAction ?? null,
    message: over.message ?? {
      authorId: 'u-author',
      content: 'bad message',
      deleted: false,
      contentMasked: false,
    },
    reporter: over.reporter ?? { id: 'u-reporter', username: 'reporter1' },
  };
}

describe('ReportQueuePanel', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    pushMock.mockReset();
    resolveMutateAsync.mockReset();
    reportsData = [report({ id: 'rep-1', category: 'HARASSMENT' })];
  });
  afterEach(() => cleanup());

  it('renders open reports with category label + resolve button', () => {
    render(<ReportQueuePanel workspaceId="ws" />);
    expect(screen.getByTestId('report-queue-list')).toBeTruthy();
    expect(screen.getAllByTestId('report-row').length).toBe(1);
    expect(screen.getByText(/괴롭힘/)).toBeTruthy();
    expect(screen.getByTestId('report-resolve-open')).toBeTruthy();
  });

  it('opens the resolve modal and submits a DISMISS action', async () => {
    resolveMutateAsync.mockResolvedValue(undefined);
    render(<ReportQueuePanel workspaceId="ws" />);
    fireEvent.click(screen.getByTestId('report-resolve-open'));
    expect(screen.getByTestId('resolve-report-modal')).toBeTruthy();
    fireEvent.click(screen.getByTestId('report-resolve-submit'));
    await waitFor(() => {
      expect(resolveMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ reportId: 'rep-1', action: 'DISMISS' }),
      );
    });
  });

  it('shows empty state when no reports', () => {
    reportsData = [];
    render(<ReportQueuePanel workspaceId="ws" />);
    expect(screen.getByTestId('report-queue-empty')).toBeTruthy();
  });

  it('masks private-channel content (A-2) instead of showing the body', () => {
    reportsData = [
      report({
        id: 'rep-masked',
        message: { authorId: 'u-author', content: null, deleted: false, contentMasked: true },
      }),
    ];
    render(<ReportQueuePanel workspaceId="ws" />);
    expect(screen.getByText(/\[비공개 채널 메시지\]/)).toBeTruthy();
  });

  it('labels the resolve button with category + reporter (H-02)', () => {
    render(<ReportQueuePanel workspaceId="ws" />);
    const btn = screen.getByTestId('report-resolve-open');
    expect(btn.getAttribute('aria-label')).toContain('괴롭힘');
    expect(btn.getAttribute('aria-label')).toContain('reporter1');
  });

  it('shows a resolved badge (not color-only) for resolved reports (M-04)', () => {
    reportsData = [
      report({
        id: 'rep-done',
        resolvedAt: '2025-01-01T00:00:00.000Z',
        resolvedAction: 'DISMISS',
      }),
    ];
    render(<ReportQueuePanel workspaceId="ws" />);
    const badge = screen.getByTestId('report-resolved-badge');
    expect(badge.className).toContain('qf-badge--success');
    expect(badge.textContent).toContain('기각');
  });
});
