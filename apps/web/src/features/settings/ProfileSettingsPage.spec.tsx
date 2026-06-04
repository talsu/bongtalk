// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ProfileView } from '@qufox/shared-types';
import { cooldownInfo } from './ProfileSettingsPage';

/**
 * S73 (D14 / FR-PS-01·02·03): 프로필 설정 탭 테스트.
 *   - 쿨다운 중 "다음 변경 가능일 D-N" 상시 표시(handleChangedAt 기반 클라 계산).
 *   - handle 정규식 실시간 검증.
 *   - 명시적 저장 버튼이 변경된 필드를 PATCH 로 전송.
 *   - 아바타 미리보기(avatarUrl) 렌더.
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

let profileData: ProfileView | null;
const updateMut = { mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false };
const presignMut = {
  mutateAsync: vi.fn().mockResolvedValue({ key: 'avatars/u1/x.png', putUrl: 'http://put' }),
  isPending: false,
};
const finalizeMut = {
  mutateAsync: vi.fn().mockResolvedValue({ avatarUrl: 'http://a' }),
  isPending: false,
};
const deleteMut = { mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false };
vi.mock('../users/useMyProfile', () => ({
  useMyProfile: () => ({ data: profileData, isLoading: false, isError: false }),
  useUpdateProfile: () => updateMut,
  useAvatarPresign: () => presignMut,
  useAvatarFinalize: () => finalizeMut,
  useAvatarDelete: () => deleteMut,
}));

import { ProfileSettingsPage } from './ProfileSettingsPage';

function baseProfile(over: Partial<ProfileView> = {}): ProfileView {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'me@e.com',
    username: 'me',
    handle: 'me',
    displayName: 'Me',
    fullName: null,
    pronouns: null,
    title: null,
    timezone: null,
    bio: null,
    handleChangedAt: null,
    avatarUrl: null,
    customStatus: null,
    links: null,
    ...over,
  };
}

function renderPage(): void {
  render(
    <MemoryRouter>
      <ProfileSettingsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  profileData = baseProfile();
  pushMock.mockReset();
  updateMut.mutateAsync.mockReset().mockResolvedValue(undefined);
  presignMut.mutateAsync
    .mockReset()
    .mockResolvedValue({ key: 'avatars/u1/x.png', putUrl: 'http://put' });
  finalizeMut.mutateAsync.mockReset().mockResolvedValue({ avatarUrl: 'http://a' });
  uploadMock.mockReset().mockResolvedValue(undefined);
});
afterEach(() => cleanup());

describe('cooldownInfo (FR-PS-03)', () => {
  it('returns null when never changed', () => {
    expect(cooldownInfo(null, Date.parse('2025-01-01T00:00:00Z'))).toBeNull();
  });
  it('returns null after 30 days elapsed', () => {
    // changed 2024-11-01, now 2025-01-01 → 61 days → no cooldown.
    expect(cooldownInfo('2024-11-01T00:00:00.000Z', Date.parse('2025-01-01T00:00:00Z'))).toBeNull();
  });
  it('computes daysLeft within the window', () => {
    // changed 2024-12-31, now 2025-01-01 → next allowed 2025-01-30 → 29 days left.
    const info = cooldownInfo('2024-12-31T00:00:00.000Z', Date.parse('2025-01-01T00:00:00Z'));
    expect(info).not.toBeNull();
    expect(info?.daysLeft).toBe(29);
  });
});

describe('ProfileSettingsPage', () => {
  it('shows the "D-N" cooldown hint when handle is on cooldown', () => {
    profileData = baseProfile({ handleChangedAt: '2024-12-31T00:00:00.000Z' });
    renderPage();
    const hint = screen.getByTestId('handle-cooldown');
    expect(hint.textContent).toContain('D-29');
  });

  it('does not show the cooldown hint when not on cooldown', () => {
    renderPage();
    expect(screen.queryByTestId('handle-cooldown')).toBeNull();
  });

  it('shows a live regex error for an invalid handle', () => {
    renderPage();
    const input = screen.getByTestId('profile-handle') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Bad Handle' } });
    expect(screen.getByTestId('handle-regex-error')).toBeTruthy();
  });

  it('disables save while the handle is invalid', () => {
    renderPage();
    fireEvent.change(screen.getByTestId('profile-handle'), { target: { value: 'X!' } });
    expect((screen.getByTestId('profile-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('PATCHes changed fields on save (omitting unchanged handle)', async () => {
    renderPage();
    fireEvent.change(screen.getByTestId('profile-displayName'), { target: { value: 'Alice' } });
    fireEvent.click(screen.getByTestId('profile-save'));
    await waitFor(() => expect(updateMut.mutateAsync).toHaveBeenCalled());
    const arg = updateMut.mutateAsync.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.displayName).toBe('Alice');
    // handle unchanged → not sent.
    expect('handle' in arg).toBe(false);
  });

  it('sends the new handle when changed', async () => {
    renderPage();
    fireEvent.change(screen.getByTestId('profile-handle'), { target: { value: 'newhandle' } });
    fireEvent.click(screen.getByTestId('profile-save'));
    await waitFor(() => expect(updateMut.mutateAsync).toHaveBeenCalled());
    const arg = updateMut.mutateAsync.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg.handle).toBe('newhandle');
  });

  it('surfaces HANDLE_TAKEN as an inline error', async () => {
    updateMut.mutateAsync.mockRejectedValueOnce(
      Object.assign(new Error('taken'), { errorCode: 'HANDLE_TAKEN' }),
    );
    renderPage();
    fireEvent.change(screen.getByTestId('profile-handle'), { target: { value: 'newhandle' } });
    fireEvent.click(screen.getByTestId('profile-save'));
    await waitFor(() => expect(screen.getByTestId('handle-server-error')).toBeTruthy());
    expect(screen.getByTestId('handle-server-error').textContent).toContain('이미 사용 중');
  });

  it('renders the avatar preview when avatarUrl is set', () => {
    profileData = baseProfile({ avatarUrl: 'http://cdn/avatar.png' });
    renderPage();
    const img = screen.getByTestId('avatar-preview') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('http://cdn/avatar.png');
  });

  it('runs presign → upload → finalize on a valid avatar file', async () => {
    renderPage();
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'a.png', {
      type: 'image/png',
    });
    const input = screen.getByTestId('avatar-file') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(finalizeMut.mutateAsync).toHaveBeenCalledWith('avatars/u1/x.png'));
    expect(presignMut.mutateAsync).toHaveBeenCalledWith({
      contentType: 'image/png',
      sizeBytes: file.size,
    });
    expect(uploadMock).toHaveBeenCalled();
  });

  it('rejects an oversize avatar client-side without calling presign', async () => {
    renderPage();
    const big = new File([new Uint8Array(1)], 'big.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: 9 * 1024 * 1024 });
    fireEvent.change(screen.getByTestId('avatar-file'), { target: { files: [big] } });
    await waitFor(() => expect(pushMock).toHaveBeenCalled());
    expect(presignMut.mutateAsync).not.toHaveBeenCalled();
  });
});
