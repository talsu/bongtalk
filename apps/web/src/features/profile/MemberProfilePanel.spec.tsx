// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { MemberFullProfileView } from '@qufox/shared-types';

/**
 * S75 (D14 / FR-PS-08): 전체 프로필 패널.
 *   - 표시이름/@핸들/제목/대명사/시간대+현지시각/역할(시스템+커스텀)/About Me 전체.
 *   - 닫기 버튼이 setProfilePanelUser(null) 호출.
 *   - profilePanelUserId 가 null 이면 미렌더.
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

let panelUserId: string | null = 'u1';
const setProfilePanelUser = vi.fn();
vi.mock('../../stores/ui-store', () => ({
  useUI: (
    sel: (s: {
      profilePanelUserId: string | null;
      setProfilePanelUser: typeof setProfilePanelUser;
    }) => unknown,
  ) => sel({ profilePanelUserId: panelUserId, setProfilePanelUser }),
}));

let profile: MemberFullProfileView | undefined;
vi.mock('./useFullProfile', () => ({
  useFullProfile: () => ({ data: profile, isLoading: false }),
}));

import { MemberProfilePanel } from './MemberProfilePanel';

function baseProfile(over: Partial<MemberFullProfileView> = {}): MemberFullProfileView {
  return {
    userId: 'u1',
    username: 'alice',
    handle: 'alice',
    displayName: 'Alice',
    fullName: null,
    pronouns: 'she/her',
    title: 'Engineer',
    timezone: 'Asia/Seoul',
    bio: 'global bio',
    avatarUrl: null,
    bannerUrl: null,
    wsNickname: null,
    wsAvatarUrl: null,
    workspaceBio: null,
    presenceStatus: 'online',
    customStatus: null,
    customStatusEmoji: null,
    systemRole: 'ADMIN',
    customRoles: [{ id: 'r1', name: 'Builder', color: '#5865F2' }],
    effectiveDisplayName: 'Alice',
    effectiveAvatarUrl: null,
    effectiveBio: 'global bio',
    ...over,
  };
}

function renderPanel(): void {
  render(
    <MemoryRouter>
      <MemberProfilePanel workspaceId="w1" />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  panelUserId = 'u1';
  profile = baseProfile();
  navigateMock.mockReset();
  setProfilePanelUser.mockReset();
});

afterEach(() => cleanup());

describe('MemberProfilePanel (FR-PS-08)', () => {
  it('renders nothing when no profilePanelUserId is set', () => {
    panelUserId = null;
    renderPanel();
    expect(screen.queryByTestId('member-profile-panel')).toBeNull();
  });

  it('renders the full profile fields (title/pronouns/localtime/roles)', () => {
    renderPanel();
    expect(screen.getByTestId('member-profile-name').textContent).toBe('Alice');
    expect(screen.getByTestId('member-profile-title').textContent).toBe('Engineer');
    expect(screen.getByTestId('member-profile-pronouns').textContent).toBe('she/her');
    // 시간대 + 현지시각(1분 갱신 클록) 노출.
    expect(screen.getByTestId('member-profile-localtime').textContent).toContain('Asia/Seoul');
    // 역할 목록 = 시스템 ADMIN + 커스텀 Builder 모두 노출.
    const roles = screen.getByTestId('member-profile-roles');
    expect(roles.textContent).toContain('ADMIN');
    expect(roles.textContent).toContain('Builder');
    expect(screen.getByTestId('member-profile-about').textContent).toBe('global bio');
  });

  it('closes via the X button', () => {
    renderPanel();
    fireEvent.click(screen.getByTestId('member-profile-close'));
    expect(setProfilePanelUser).toHaveBeenCalledWith(null);
  });

  it('F8: announces the panel via an sr-only aria-live region', () => {
    renderPanel();
    const live = screen.getByTestId('member-profile-live');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toBe('멤버 프로필 패널이 열렸습니다');
  });

  it('F9: localtime wrapper carries a single combined aria-label, inner spans are hidden', () => {
    renderPanel();
    const localtime = screen.getByTestId('member-profile-localtime');
    // timezone + 현지시각을 단일 wrapper aria-label 로 묶는다.
    expect(localtime.getAttribute('aria-label')).toContain('Asia/Seoul');
    expect(localtime.getAttribute('aria-label')).toContain('현지 시각');
    // 내부 span(타임존/시각)은 중복 낭독을 막으려 aria-hidden.
    for (const span of Array.from(localtime.querySelectorAll('span'))) {
      expect(span.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('F7: roles container is a list with listitem badges', () => {
    renderPanel();
    const roles = screen.getByTestId('member-profile-roles');
    expect(roles.getAttribute('role')).toBe('list');
    expect(roles.getAttribute('aria-label')).toBe('역할');
    const items = roles.querySelectorAll('[role="listitem"]');
    // 시스템 ADMIN + 커스텀 Builder = 2 listitem.
    expect(items.length).toBe(2);
  });

  it('F16: panel is width-constrained to 280px at the app layer', () => {
    renderPanel();
    const panel = screen.getByTestId('member-profile-panel');
    expect(panel.style.width).toBe('280px');
  });

  it('navigates to /dm/:userId on DM button', () => {
    renderPanel();
    fireEvent.click(screen.getByTestId('member-profile-dm'));
    expect(navigateMock).toHaveBeenCalledWith('/dm/u1');
  });
});
