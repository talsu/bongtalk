// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * S75 (D14 / FR-PS-14): 개인정보/안전 설정 — 차단 목록 + 해제.
 *   - 빈 목록 안내.
 *   - 차단 사용자 행 렌더 + 해제 버튼이 useUnblockUser 를 호출.
 */
vi.mock('../../design-system/primitives', () => ({
  Avatar: ({ name }: { name: string }) => <span data-testid={`avatar-${name}`}>{name}</span>,
}));

const pushMock = vi.fn();
vi.mock('../../stores/notification-store', () => ({
  useNotifications: (sel: (s: { push: typeof pushMock }) => unknown) => sel({ push: pushMock }),
}));

type Row = { friendshipId: string; otherUserId: string; otherUsername: string };
let blockedRows: Row[];
const unblockMutate = vi.fn();
vi.mock('../friends/useFriends', () => ({
  useFriendsList: () => ({ data: { items: blockedRows }, isLoading: false }),
  useUnblockUser: () => ({ mutate: unblockMutate, isPending: false }),
}));

import { PrivacySafetySettingsPage } from './PrivacySafetySettingsPage';

function renderPage(): void {
  render(
    <MemoryRouter>
      <PrivacySafetySettingsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  blockedRows = [];
  unblockMutate.mockReset();
  pushMock.mockReset();
});

afterEach(() => cleanup());

describe('PrivacySafetySettingsPage (FR-PS-14)', () => {
  it('shows an empty state when no users are blocked', () => {
    blockedRows = [];
    renderPage();
    expect(screen.getByTestId('blocked-empty')).toBeTruthy();
  });

  it('renders a blocked user row and unblocks on click', () => {
    blockedRows = [{ friendshipId: 'f1', otherUserId: 'u-blocked', otherUsername: 'troublemaker' }];
    renderPage();
    expect(screen.getByTestId('blocked-row-u-blocked')).toBeTruthy();
    fireEvent.click(screen.getByTestId('blocked-unblock-u-blocked'));
    expect(unblockMutate).toHaveBeenCalledWith(
      { userId: 'u-blocked' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });
});
