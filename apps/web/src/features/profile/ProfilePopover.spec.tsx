// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { MemberFullProfileView } from '@qufox/shared-types';

/**
 * S75 (D14 / FR-PS-07): 프로필 팝오버 미니카드.
 *   - 트리거 클릭 시 표시이름·@핸들·프레즌스·역할 뱃지(≤3 + 더보기)·About Me·DM/전체 프로필.
 *   - "전체 프로필" 클릭 시 ui-store.setProfilePanelUser 호출.
 *   - 트리거 a11y(role=button aria-haspopup=dialog).
 */
vi.mock('../../design-system/primitives', () => ({
  Avatar: ({ name }: { name: string }) => <span data-testid={`avatar-${name}`}>{name}</span>,
  Icon: ({ name }: { name: string }) => <svg data-testid={`icon-${name}`} aria-hidden="true" />,
}));

const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

const setProfilePanelUser = vi.fn();
vi.mock('../../stores/ui-store', () => ({
  useUI: (sel: (s: { setProfilePanelUser: typeof setProfilePanelUser }) => unknown) =>
    sel({ setProfilePanelUser }),
}));

let profile: MemberFullProfileView | undefined;
let loading = false;
vi.mock('./useFullProfile', () => ({
  useFullProfile: () => ({ data: profile, isLoading: loading }),
}));

import { ProfilePopover } from './ProfilePopover';

function baseProfile(over: Partial<MemberFullProfileView> = {}): MemberFullProfileView {
  return {
    userId: 'u1',
    username: 'alice',
    handle: 'alice',
    displayName: 'Alice',
    fullName: null,
    pronouns: null,
    title: null,
    timezone: 'Asia/Seoul',
    bio: 'global bio',
    avatarUrl: null,
    bannerUrl: null,
    wsNickname: 'Ace',
    wsAvatarUrl: null,
    workspaceBio: 'ws bio',
    presenceStatus: 'online',
    customStatus: 'busy',
    customStatusEmoji: '🔴',
    systemRole: 'MEMBER',
    customRoles: [],
    effectiveDisplayName: 'Ace',
    effectiveAvatarUrl: null,
    effectiveBio: 'ws bio',
    ...over,
  };
}

function renderPopover(): void {
  render(
    <MemoryRouter>
      <ProfilePopover userId="u1" workspaceId="w1">
        <span>trigger</span>
      </ProfilePopover>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  profile = baseProfile();
  loading = false;
  navigateMock.mockReset();
  setProfilePanelUser.mockReset();
});

afterEach(() => cleanup());

describe('ProfilePopover (FR-PS-07)', () => {
  it('trigger exposes role=button + aria-haspopup=dialog', () => {
    renderPopover();
    const trigger = screen.getByTestId('profile-trigger-u1');
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('role')).toBe('button');
  });

  it('opens on click and renders effective name, handle, custom status', () => {
    renderPopover();
    fireEvent.click(screen.getByTestId('profile-trigger-u1'));
    expect(screen.getByTestId('profile-name-u1').textContent).toBe('Ace');
    expect(screen.getByText('@alice')).toBeTruthy();
    expect(screen.getByTestId('profile-custom-status-u1').textContent).toContain('busy');
    expect(screen.getByTestId('profile-about-u1').textContent).toBe('ws bio');
  });

  it('caps role badges at 3 and shows a +N more badge', () => {
    profile = baseProfile({
      customRoles: [
        { id: 'r1', name: 'A', color: null },
        { id: 'r2', name: 'B', color: null },
        { id: 'r3', name: 'C', color: null },
        { id: 'r4', name: 'D', color: null },
        { id: 'r5', name: 'E', color: null },
      ],
    });
    renderPopover();
    fireEvent.click(screen.getByTestId('profile-trigger-u1'));
    expect(screen.getByTestId('profile-roles-more-u1').textContent).toBe('+2');
  });

  it('navigates to /dm/:userId on "DM 보내기"', () => {
    renderPopover();
    fireEvent.click(screen.getByTestId('profile-trigger-u1'));
    fireEvent.click(screen.getByTestId('profile-dm-u1'));
    expect(navigateMock).toHaveBeenCalledWith('/dm/u1');
  });

  it('opens the full profile panel on "전체 프로필"', () => {
    renderPopover();
    fireEvent.click(screen.getByTestId('profile-trigger-u1'));
    fireEvent.click(screen.getByTestId('profile-open-panel-u1'));
    expect(setProfilePanelUser).toHaveBeenCalledWith('u1');
  });
});
