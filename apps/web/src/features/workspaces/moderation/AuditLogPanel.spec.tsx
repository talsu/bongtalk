// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { AuditLogEntry } from '@qufox/shared-types';

// S64 (FR-RM12): AuditLogPanel RTL. Button pass-through + useAuditLogs 모킹으로
// 목록 렌더·action 필터·더 보기 페이지네이션을 검증한다.
vi.mock('../../../design-system/primitives', () => ({
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

const fetchNextPage = vi.fn();
let mockState: {
  pages: { entries: AuditLogEntry[]; nextCursor: string | null }[];
  hasNextPage: boolean;
  isLoading: boolean;
  isError: boolean;
};

vi.mock('../useModeration', () => ({
  useAuditLogs: () => ({
    data: { pages: mockState.pages },
    hasNextPage: mockState.hasNextPage,
    isFetchingNextPage: false,
    isLoading: mockState.isLoading,
    isError: mockState.isError,
    fetchNextPage,
  }),
}));

import { AuditLogPanel } from './AuditLogPanel';

function entry(over: Partial<AuditLogEntry>): AuditLogEntry {
  return {
    id: over.id ?? 'a1',
    workspaceId: 'ws',
    actorId: over.actorId ?? 'actor-1',
    action: over.action ?? 'ROLE_CREATE',
    targetId: over.targetId ?? null,
    channelId: null,
    details: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    actor: over.actor ?? { id: 'actor-1', username: 'alice' },
  };
}

describe('AuditLogPanel', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    fetchNextPage.mockReset();
    mockState = {
      pages: [{ entries: [entry({ id: 'a1' }), entry({ id: 'a2' })], nextCursor: 'c1' }],
      hasNextPage: true,
      isLoading: false,
      isError: false,
    };
  });
  afterEach(() => cleanup());

  it('renders entries with korean action labels', () => {
    render(<AuditLogPanel workspaceId="ws" />);
    expect(screen.getByTestId('audit-log-list')).toBeTruthy();
    expect(screen.getAllByTestId('audit-log-row').length).toBe(2);
    // ROLE_CREATE → '역할 생성' 라벨.
    expect(screen.getAllByText('역할 생성').length).toBeGreaterThanOrEqual(1);
  });

  it('renders the action filter and load-more when hasNextPage', () => {
    render(<AuditLogPanel workspaceId="ws" />);
    expect(screen.getByTestId('audit-action-filter')).toBeTruthy();
    const more = screen.getByTestId('audit-log-load-more');
    fireEvent.click(more);
    expect(fetchNextPage).toHaveBeenCalled();
  });

  it('shows empty state when there are no entries', () => {
    mockState = {
      pages: [{ entries: [], nextCursor: null }],
      hasNextPage: false,
      isLoading: false,
      isError: false,
    };
    render(<AuditLogPanel workspaceId="ws" />);
    expect(screen.getByTestId('audit-log-empty')).toBeTruthy();
  });
});
