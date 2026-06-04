// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { WorkspaceMemberProfileView } from '@qufox/shared-types';

/**
 * S74 (D14 / FR-PS-06): 워크스페이스별 프로필 편집 패널 테스트.
 *   - 닉네임/아바타/About Me 편집 + null 비우기(전역 폴백).
 *   - 변경된 필드만 PATCH.
 *   - 아바타 presign → upload → finalize.
 */
vi.mock('../../design-system/primitives', () => ({
  Icon: ({ name }: { name: string }) => <svg data-testid={`icon-${name}`} aria-hidden="true" />,
}));

const pushMock = vi.fn();
vi.mock('../../stores/notification-store', () => ({
  useNotifications: (sel: (s: { push: typeof pushMock }) => unknown) => sel({ push: pushMock }),
}));

const uploadMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../users/avatarUpload', () => ({
  uploadAvatarBlob: (...args: unknown[]) => uploadMock(...args),
}));

let profileData: WorkspaceMemberProfileView | null;
const updateMut = { mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false };
const presignMut = {
  mutateAsync: vi.fn().mockResolvedValue({
    key: 'ws-avatars/w1/u1/x.png',
    url: 'http://post',
    fields: { key: 'ws-avatars/w1/u1/x.png', 'Content-Type': 'image/png' },
  }),
  isPending: false,
};
const finalizeMut = {
  mutateAsync: vi.fn().mockResolvedValue({ avatarUrl: 'http://wsa' }),
  isPending: false,
};
const deleteMut = { mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false };
vi.mock('./useWorkspaceProfile', () => ({
  useWorkspaceProfile: () => ({ data: profileData, isLoading: false, isError: false }),
  useUpdateWorkspaceProfile: () => updateMut,
  useWorkspaceAvatarPresign: () => presignMut,
  useWorkspaceAvatarFinalize: () => finalizeMut,
  useWorkspaceAvatarDelete: () => deleteMut,
}));

import { WorkspaceProfilePanel } from './WorkspaceProfilePanel';

function baseProfile(over: Partial<WorkspaceMemberProfileView> = {}): WorkspaceMemberProfileView {
  return {
    workspaceId: '00000000-0000-0000-0000-000000000010',
    userId: '00000000-0000-0000-0000-000000000001',
    nickname: null,
    avatarUrl: null,
    workspaceBio: null,
    ...over,
  };
}

function renderPanel(): void {
  render(<WorkspaceProfilePanel workspaceId="00000000-0000-0000-0000-000000000010" />);
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  profileData = baseProfile();
  pushMock.mockReset();
  updateMut.mutateAsync.mockReset().mockResolvedValue(undefined);
  presignMut.mutateAsync.mockReset().mockResolvedValue({
    key: 'ws-avatars/w1/u1/x.png',
    url: 'http://post',
    fields: { key: 'ws-avatars/w1/u1/x.png', 'Content-Type': 'image/png' },
  });
  finalizeMut.mutateAsync.mockReset().mockResolvedValue({ avatarUrl: 'http://wsa' });
  deleteMut.mutateAsync.mockReset().mockResolvedValue(undefined);
  uploadMock.mockReset().mockResolvedValue(undefined);
});
afterEach(() => cleanup());

describe('WorkspaceProfilePanel (FR-PS-06)', () => {
  it('prefills nickname + bio from the profile', () => {
    profileData = baseProfile({ nickname: 'Ace', workspaceBio: 'hello' });
    renderPanel();
    expect((screen.getByTestId('ws-nickname') as HTMLInputElement).value).toBe('Ace');
    expect((screen.getByTestId('ws-bio') as HTMLTextAreaElement).value).toBe('hello');
  });

  it('PATCHes only changed fields on save', async () => {
    profileData = baseProfile({ nickname: 'Ace', workspaceBio: 'hello' });
    renderPanel();
    fireEvent.change(screen.getByTestId('ws-nickname'), { target: { value: 'Neo' } });
    fireEvent.click(screen.getByTestId('ws-profile-save'));
    await waitFor(() => expect(updateMut.mutateAsync).toHaveBeenCalled());
    const arg = updateMut.mutateAsync.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.nickname).toBe('Neo');
    expect('workspaceBio' in arg).toBe(false);
  });

  it('clears nickname to null (fallback to global) when emptied', async () => {
    profileData = baseProfile({ nickname: 'Ace' });
    renderPanel();
    fireEvent.change(screen.getByTestId('ws-nickname'), { target: { value: '  ' } });
    fireEvent.click(screen.getByTestId('ws-profile-save'));
    await waitFor(() => expect(updateMut.mutateAsync).toHaveBeenCalled());
    const arg = updateMut.mutateAsync.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.nickname).toBeNull();
  });

  it('renders the ws avatar preview when avatarUrl is set', () => {
    profileData = baseProfile({ avatarUrl: 'http://cdn/ws.png' });
    renderPanel();
    expect((screen.getByTestId('ws-avatar-preview') as HTMLImageElement).getAttribute('src')).toBe(
      'http://cdn/ws.png',
    );
  });

  it('runs ws avatar presign → upload → finalize', async () => {
    renderPanel();
    const file = new File([new Uint8Array([0x89, 0x50])], 'a.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('ws-avatar-file'), { target: { files: [file] } });
    await waitFor(() =>
      expect(finalizeMut.mutateAsync).toHaveBeenCalledWith('ws-avatars/w1/u1/x.png'),
    );
    expect(uploadMock).toHaveBeenCalledWith(
      'http://post',
      { key: 'ws-avatars/w1/u1/x.png', 'Content-Type': 'image/png' },
      file,
    );
  });

  it('shows the remove button only when a ws avatar exists', () => {
    profileData = baseProfile({ avatarUrl: 'http://cdn/ws.png' });
    renderPanel();
    expect(screen.getByTestId('ws-avatar-remove')).toBeTruthy();
    cleanup();
    profileData = baseProfile({ avatarUrl: null });
    renderPanel();
    expect(screen.queryByTestId('ws-avatar-remove')).toBeNull();
  });
});
