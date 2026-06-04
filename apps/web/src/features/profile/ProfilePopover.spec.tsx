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
  it('trigger exposes role=button + aria-haspopup=dialog (no duplicate ARIA wrapper)', () => {
    renderPopover();
    const trigger = screen.getByTestId('profile-trigger-u1');
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger.getAttribute('role')).toBe('button');
    // F3 (a11y B-2): aria-haspopup=dialog 를 가진 요소가 정확히 1개여야 한다
    // (별도 wrapper span 제거 — 중복 ARIA 없음).
    expect(document.querySelectorAll('[aria-haspopup="dialog"]').length).toBe(1);
    // F3 (a11y M-4): outline-none 을 두지 않아 DS :focus-visible 링이 살아 있다.
    expect(trigger.className).not.toContain('outline-none');
    // F3: 트리거는 키보드 진입 가능(tabIndex=0).
    expect(trigger.getAttribute('tabindex')).toBe('0');
  });

  it('F5: triggerProps can make the trigger mouse-only (tabIndex=-1 + aria-hidden)', () => {
    render(
      <MemoryRouter>
        <ProfilePopover
          userId="u1"
          workspaceId="w1"
          triggerProps={{ tabIndex: -1, 'aria-hidden': true }}
        >
          <span>avatar</span>
        </ProfilePopover>
      </MemoryRouter>,
    );
    const trigger = screen.getByTestId('profile-trigger-u1');
    expect(trigger.getAttribute('tabindex')).toBe('-1');
    expect(trigger.getAttribute('aria-hidden')).toBe('true');
  });

  it('F3: renders the trigger host as a div when as="div" (block-in-inline 회피)', () => {
    render(
      <MemoryRouter>
        <ProfilePopover userId="u1" workspaceId="w1" as="div">
          <div>member row</div>
        </ProfilePopover>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('profile-trigger-u1').tagName).toBe('DIV');
  });

  it('opens on click and renders effective name, handle, custom status', () => {
    renderPopover();
    fireEvent.click(screen.getByTestId('profile-trigger-u1'));
    expect(screen.getByTestId('profile-name-u1').textContent).toBe('Ace');
    expect(screen.getByText('@alice')).toBeTruthy();
    expect(screen.getByTestId('profile-custom-status-u1').textContent).toContain('busy');
    expect(screen.getByTestId('profile-about-u1').textContent).toBe('ws bio');
  });

  it('caps role badges at 3 and shows a +N more badge with an accessible label (F12)', () => {
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
    const more = screen.getByTestId('profile-roles-more-u1');
    expect(more.textContent).toBe('+2');
    // F12 (a11y N-2): "+N" 뱃지 접근명.
    expect(more.getAttribute('aria-label')).toBe('역할 2개 더 있음');
    // F7 (a11y H-2): roles 컨테이너는 list, 각 뱃지는 listitem.
    const rolesBox = screen.getByTestId('profile-roles-u1');
    expect(rolesBox.getAttribute('role')).toBe('list');
    expect(rolesBox.querySelectorAll('[role="listitem"]').length).toBe(4); // 3 + more
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
