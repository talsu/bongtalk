// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { GlobalNotificationSettings } from '@qufox/shared-types';

const pushMock = vi.fn();
vi.mock('../../stores/notification-store', () => ({
  useNotifications: (sel: (s: { push: typeof pushMock }) => unknown) => sel({ push: pushMock }),
}));

vi.mock('../workspaces/useWorkspaces', () => ({
  useMyWorkspaces: () => ({ data: { workspaces: [] } }),
}));

vi.mock('../notifications/useNotificationPreferences', () => ({
  HARDCODED_DEFAULTS: {
    MENTION: 'BOTH',
    REPLY: 'BOTH',
    REACTION: 'TOAST',
    DIRECT: 'BOTH',
    FRIEND_REQUEST: 'TOAST',
  },
  resolveChannel: () => 'BOTH',
  useNotificationPreferences: () => ({ data: [] }),
  useUpsertNotificationPreference: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

let globalSettings: GlobalNotificationSettings;
const updateMutate = vi.fn();
vi.mock('../notifications/useNotifLevels', () => ({
  useGlobalNotificationSettings: () => ({ data: globalSettings }),
  useUpdateGlobalNotificationSettings: () => ({ mutateAsync: updateMutate, isPending: false }),
}));

// 하위 섹션 컴포넌트는 별도 테스트 대상 — 여기서는 스텁으로 격리.
vi.mock('../notifications/NotifLevelRadio', () => ({ NotifLevelRadio: () => <div /> }));
vi.mock('../notifications/DndSnoozeControl', () => ({ DndSnoozeControl: () => <div /> }));
vi.mock('../notifications/KeywordsInput', () => ({ KeywordsInput: () => <div /> }));
vi.mock('../notifications/ServerNotifSettings', () => ({ ServerNotifSettings: () => <div /> }));
vi.mock('../notifications/MuteListSection', () => ({ MuteListSection: () => <div /> }));

import { NotificationSettingsPage } from './NotificationSettingsPage';

function renderPage(): void {
  render(
    <MemoryRouter>
      <NotificationSettingsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  globalSettings = {
    notifTrigger: 'MENTIONS',
    keywords: [],
    dndUntil: null,
    dndSchedule: null,
    notifDesktop: true,
    notifMobile: true,
  };
  updateMutate.mockReset();
  updateMutate.mockResolvedValue(globalSettings);
  pushMock.mockReset();
});
afterEach(() => cleanup());

describe('NotificationSettingsPage channel toggles (FR-PS-10)', () => {
  it('renders desktop toggle reflecting current state; mobile toggle is disabled (준비 중)', () => {
    renderPage();
    expect(screen.getByTestId('notif-desktop-toggle').getAttribute('aria-checked')).toBe('true');
    // F-B1: 모바일 푸시는 실 푸시 인프라 부재로 토글 비활성("준비 중") — 죽은 컨트롤 방지.
    const mobile = screen.getByTestId('notif-mobile-toggle') as HTMLButtonElement;
    expect(mobile.disabled).toBe(true);
    expect(mobile.getAttribute('aria-disabled')).toBe('true');
  });

  it('PATCHes notifDesktop=false when the desktop toggle is flipped off', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('notif-desktop-toggle'));
    expect(updateMutate).toHaveBeenCalledWith({ notifDesktop: false });
  });

  it('does NOT PATCH from the disabled mobile toggle (F-B1)', () => {
    renderPage();
    fireEvent.click(screen.getByTestId('notif-mobile-toggle'));
    expect(updateMutate).not.toHaveBeenCalled();
  });

  it('flips back on when currently off', () => {
    globalSettings = { ...globalSettings, notifDesktop: false };
    renderPage();
    expect(screen.getByTestId('notif-desktop-toggle').getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByTestId('notif-desktop-toggle'));
    expect(updateMutate).toHaveBeenCalledWith({ notifDesktop: true });
  });
});
