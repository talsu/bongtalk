// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ServerNotificationPreference } from '@qufox/shared-types';

const putMutateAsync = vi.fn().mockResolvedValue(undefined);
const unmuteMutateAsync = vi.fn().mockResolvedValue(undefined);
let prefState: ServerNotificationPreference | undefined;

vi.mock('./useNotifLevels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useNotifLevels')>();
  return {
    ...actual,
    useServerNotificationPref: () => ({ data: prefState }),
    usePutServerNotificationPref: () => ({ mutateAsync: putMutateAsync, isPending: false }),
    useUnmuteServer: () => ({ mutateAsync: unmuteMutateAsync, isPending: false }),
  };
});

const pushToast = vi.fn();
vi.mock('../../stores/notification-store', () => ({
  useNotifications: (selector: (s: { push: typeof pushToast }) => unknown) =>
    selector({ push: pushToast }),
}));

import { ServerNotifSettings } from './ServerNotifSettings';

const WS = 'ws-1';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  putMutateAsync.mockClear();
  unmuteMutateAsync.mockClear();
  pushToast.mockClear();
  prefState = {
    level: 'MENTIONS',
    isMuted: false,
    muteUntil: null,
    suppressEveryone: false,
    suppressRoleMentions: false,
  };
});
afterEach(cleanup);

describe('ServerNotifSettings suppress toggles (S48 FR-MN-09)', () => {
  it('suppress 토글 2종 렌더', () => {
    render(<ServerNotifSettings workspaceId={WS} />);
    expect(screen.getByTestId('suppress-everyone-checkbox')).toBeTruthy();
    expect(screen.getByTestId('suppress-role-checkbox')).toBeTruthy();
  });

  it('@everyone 억제 체크 → PUT { suppressEveryone: true }', () => {
    render(<ServerNotifSettings workspaceId={WS} />);
    fireEvent.click(screen.getByTestId('suppress-everyone-checkbox'));
    expect(putMutateAsync).toHaveBeenCalledWith({ suppressEveryone: true });
  });

  it('역할 멘션 억제 체크 → PUT { suppressRoleMentions: true }', () => {
    render(<ServerNotifSettings workspaceId={WS} />);
    fireEvent.click(screen.getByTestId('suppress-role-checkbox'));
    expect(putMutateAsync).toHaveBeenCalledWith({ suppressRoleMentions: true });
  });

  it('서버 pref 값이 토글 체크 상태에 반영', () => {
    prefState = {
      level: 'MENTIONS',
      isMuted: false,
      muteUntil: null,
      suppressEveryone: true,
      suppressRoleMentions: false,
    };
    render(<ServerNotifSettings workspaceId={WS} />);
    const everyone = screen.getByTestId('suppress-everyone-checkbox') as HTMLInputElement;
    const role = screen.getByTestId('suppress-role-checkbox') as HTMLInputElement;
    expect(everyone.checked).toBe(true);
    expect(role.checked).toBe(false);
  });
});
