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

describe('ServerNotifSettings suppress a11y (S48 fix-forward)', () => {
  // C-01: aria-label 제거 → 접근명이 시각 label 텍스트와 일치(label-content-name-mismatch 해소).
  it('C-01: checkbox 에 aria-label 없음(시각 텍스트가 접근명)', () => {
    render(<ServerNotifSettings workspaceId={WS} />);
    const everyone = screen.getByTestId('suppress-everyone-checkbox');
    const role = screen.getByTestId('suppress-role-checkbox');
    expect(everyone.getAttribute('aria-label')).toBeNull();
    expect(role.getAttribute('aria-label')).toBeNull();
    // 시각 텍스트(label 래핑)로 접근명이 잡힌다.
    expect(screen.getByLabelText('@everyone · @here 억제')).toBe(everyone);
    expect(screen.getByLabelText('역할 멘션 억제')).toBe(role);
  });

  // C-01: 부제는 aria-describedby 로 연결(접근명에서 분리).
  it('C-01: 부제가 aria-describedby 로 연결', () => {
    render(<ServerNotifSettings workspaceId={WS} />);
    const everyone = screen.getByTestId('suppress-everyone-checkbox');
    const descId = everyone.getAttribute('aria-describedby');
    expect(descId).toBeTruthy();
    const desc = document.getElementById(descId as string);
    expect(desc?.textContent).toBe('전체·접속자 멘션의 알림과 배지를 끕니다.');
  });

  // C-04: 두 토글 래퍼 role=group + aria-labelledby(섹션 heading).
  it('C-04: suppress 토글 래퍼 role=group + aria-labelledby 섹션 heading', () => {
    render(<ServerNotifSettings workspaceId={WS} />);
    const group = screen.getByRole('group', { name: '대량 멘션 알림 억제' });
    expect(group).toBeTruthy();
    expect(group.getAttribute('aria-labelledby')).toBe('server-notif-suppress-heading');
  });
});
