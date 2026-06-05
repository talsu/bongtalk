// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * S75 (D14 / FR-PS-14): 개인정보/안전 설정 — 차단 목록 + 해제.
 *   - 빈 목록 안내.
 *   - 차단 사용자 행 렌더 + 해제 버튼이 확인 다이얼로그(F11) 거쳐 useUnblockUser 호출.
 *   - F6: 해제 버튼 aria-label 에 @username 포함.
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

// S77a (FR-PS-13): 프라이버시 섹션 hooks 모킹.
import type { PrivacySettings } from '@qufox/shared-types';
let privacyCurrent: PrivacySettings;
let privacyLoading: boolean;
const privacyMutateAsync = vi.fn();
vi.mock('./usePrivacySettings', () => ({
  usePrivacySettings: () => ({ data: privacyCurrent, isLoading: privacyLoading }),
  useUpdatePrivacySettings: () => ({ mutateAsync: privacyMutateAsync, isPending: false }),
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
  privacyCurrent = {
    allowDmFromWorkspaceMembers: true,
    messageRequestEnabled: true,
    allowFriendRequests: 'EVERYONE',
  };
  privacyLoading = false;
  privacyMutateAsync.mockReset();
  privacyMutateAsync.mockResolvedValue(privacyCurrent);
});

afterEach(() => cleanup());

describe('PrivacySafetySettingsPage (FR-PS-14)', () => {
  it('shows an empty state when no users are blocked', () => {
    blockedRows = [];
    renderPage();
    expect(screen.getByTestId('blocked-empty')).toBeTruthy();
  });

  it('renders a blocked user row and unblocks after confirming (F6/F11)', () => {
    blockedRows = [{ friendshipId: 'f1', otherUserId: 'u-blocked', otherUsername: 'troublemaker' }];
    renderPage();
    expect(screen.getByTestId('blocked-row-u-blocked')).toBeTruthy();
    // F6 (a11y H-1): 해제 버튼 접근명에 @username 포함.
    expect(screen.getByTestId('blocked-unblock-u-blocked').getAttribute('aria-label')).toBe(
      '@troublemaker 차단 해제',
    );
    // F11 (a11y M-5): 첫 클릭은 즉시 해제하지 않고 확인 다이얼로그를 연다.
    fireEvent.click(screen.getByTestId('blocked-unblock-u-blocked'));
    expect(unblockMutate).not.toHaveBeenCalled();
    // 확인 다이얼로그의 "차단 해제" 버튼을 눌러야 mutate 가 호출된다.
    fireEvent.click(screen.getByTestId('unblock-confirm-ok'));
    expect(unblockMutate).toHaveBeenCalledWith(
      { userId: 'u-blocked' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it('cancels the unblock from the confirm dialog (F11)', () => {
    blockedRows = [{ friendshipId: 'f1', otherUserId: 'u-blocked', otherUsername: 'troublemaker' }];
    renderPage();
    fireEvent.click(screen.getByTestId('blocked-unblock-u-blocked'));
    fireEvent.click(screen.getByTestId('unblock-confirm-cancel'));
    expect(unblockMutate).not.toHaveBeenCalled();
  });
});

describe('PrivacySafetySettingsPage — privacy section (FR-PS-13)', () => {
  it('renders the privacy preferences section + keeps the blocked-list section', () => {
    renderPage();
    expect(screen.getByTestId('privacy-prefs')).toBeTruthy();
    // 기존 차단 목록 섹션은 유지된다.
    expect(screen.getByTestId('blocked-empty')).toBeTruthy();
  });

  it('PATCHes allowDmFromWorkspaceMembers on toggle', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('privacy-allow-dm-toggle'));
    expect(privacyMutateAsync).toHaveBeenCalledWith({ allowDmFromWorkspaceMembers: false });
  });

  it('PATCHes messageRequestEnabled on toggle (honest stored-only label)', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('privacy-message-request-toggle'));
    expect(privacyMutateAsync).toHaveBeenCalledWith({ messageRequestEnabled: false });
  });

  it('PATCHes allowFriendRequests on dropdown change', () => {
    renderPage();
    fireEvent.change(screen.getByTestId('privacy-friend-req-select'), {
      target: { value: 'NOBODY' },
    });
    expect(privacyMutateAsync).toHaveBeenCalledWith({ allowFriendRequests: 'NOBODY' });
  });

  it('reflects the current allowFriendRequests value on the select', () => {
    privacyCurrent = {
      allowDmFromWorkspaceMembers: false,
      messageRequestEnabled: true,
      allowFriendRequests: 'MUTUAL_WORKSPACE',
    };
    renderPage();
    const select = screen.getByTestId('privacy-friend-req-select') as HTMLSelectElement;
    expect(select.value).toBe('MUTUAL_WORKSPACE');
    expect(screen.getByTestId('privacy-allow-dm-toggle').getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  // F6 (a11y M-3): 프라이버시 서버값 로딩 중에는 aria-busy 스켈레톤을 보이고 토글은 미렌더.
  it('shows an aria-busy loading region while privacy settings load', () => {
    privacyLoading = true;
    renderPage();
    const busy = screen.getByTestId('privacy-prefs-loading');
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByTestId('privacy-allow-dm-toggle')).toBeNull();
  });

  // F7 (a11y M-4): 장식용 eyebrow 는 접근성 트리에서 제거(aria-hidden).
  it('hides the decorative eyebrow from assistive tech', () => {
    renderPage();
    const eyebrow = document.querySelector('.qf-eyebrow');
    expect(eyebrow?.getAttribute('aria-hidden')).toBe('true');
  });
});
