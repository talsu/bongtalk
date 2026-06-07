// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Role } from '@qufox/shared-types';
import { serializePermissions, PERMISSIONS } from '@qufox/shared-types';

// S61 (D12 / FR-RM01): RolesModal RTL. Dialog/Button pass-through 모킹(portal 회피),
// useWorkspaces hooks 모킹으로 모달 렌더·토글·시스템역할 보호 UI 를 검증한다.
vi.mock('../../../design-system/primitives', () => ({
  Dialog: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  Button: ({
    children,
    onClick,
    disabled,
    ...rest
  }: {
    children?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    [k: string]: unknown;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
}));

const createMut = { mutateAsync: vi.fn(), isPending: false };
const updateMut = { mutateAsync: vi.fn(), isPending: false };
const deleteMut = { mutateAsync: vi.fn(), isPending: false };
let rolesData: Role[] = [];

vi.mock('../useWorkspaces', () => ({
  useRoles: () => ({ data: rolesData }),
  useCreateRole: () => createMut,
  useUpdateRole2: () => updateMut,
  useDeleteRole: () => deleteMut,
}));

vi.mock('../../../stores/notification-store', () => ({
  useNotifications: () => vi.fn(),
}));

import { RolesModal } from './RolesModal';

function role(over: Partial<Role>): Role {
  return {
    id: over.id ?? 'r1',
    workspaceId: 'ws',
    name: over.name ?? 'Role',
    colorHex: over.colorHex ?? null,
    position: over.position ?? 100,
    permissions: over.permissions ?? '0',
    isSystem: over.isSystem ?? false,
    mentionable: over.mentionable ?? false,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  };
}

describe('RolesModal', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    createMut.mutateAsync.mockReset();
    updateMut.mutateAsync.mockReset();
    deleteMut.mutateAsync.mockReset();
    rolesData = [
      role({ id: 'owner', name: 'OWNER', position: 500, isSystem: true }),
      role({
        id: 'helpers',
        name: 'Helpers',
        position: 50,
        // eslint-disable-next-line no-restricted-syntax -- 역할 colorHex 는 본질적으로 hex 색상 데이터(사용자 입력 모사 fixture)이므로 DS 토큰 대상 아님(task-018 예외).
        colorHex: '#00ff00',
        permissions: serializePermissions(PERMISSIONS.SEND_MESSAGES),
      }),
    ];
  });
  afterEach(() => cleanup());

  it('renders nothing when closed', () => {
    const { container } = render(
      <RolesModal workspaceId="ws" canManage open={false} onClose={vi.fn()} />,
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('lists roles sorted by position desc with system badge', () => {
    render(<RolesModal workspaceId="ws" canManage open onClose={vi.fn()} />);
    const items = screen.getAllByTestId(/^role-item-/);
    // OWNER(500) first, Helpers(50) second.
    expect(items[0].textContent).toContain('OWNER');
    expect(items[0].textContent).toContain('시스템');
    expect(items[1].textContent).toContain('Helpers');
  });

  it('selecting a system role disables name editing and hides delete', () => {
    render(<RolesModal workspaceId="ws" canManage open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('role-item-OWNER'));
    expect((screen.getByTestId('role-edit-name') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByTestId('role-delete-btn')).toBeNull();
    // S88a (FR-MN-03 · D6): 시스템 역할도 @멘션 허용 토글 + 저장 버튼은 노출된다.
    expect(screen.getByText('시스템 역할은 @멘션 허용만 변경할 수 있습니다.')).toBeTruthy();
    expect(screen.getByTestId('role-save-btn')).toBeTruthy();
  });

  // S88a (FR-MN-03 · D6): mentionable 토글 — 시스템 역할도 mentionable 만 저장한다.
  it('system role: toggling @멘션 허용 saves only mentionable', async () => {
    updateMut.mutateAsync.mockResolvedValue(undefined);
    render(<RolesModal workspaceId="ws" canManage open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('role-item-OWNER'));
    const toggle = screen
      .getByTestId('role-mentionable')
      .querySelector('input') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(false); // canManage 면 시스템 역할도 토글 가능.
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId('role-save-btn'));
    expect(updateMut.mutateAsync).toHaveBeenCalledTimes(1);
    const arg = updateMut.mutateAsync.mock.calls[0][0];
    expect(arg.input).toEqual({ mentionable: true });
    expect(arg.roleId).toBe('owner');
  });

  // S88a (FR-MN-03 · D6): 커스텀 역할 저장 payload 에 mentionable 포함.
  it('custom role: save includes mentionable in payload', async () => {
    updateMut.mutateAsync.mockResolvedValue(undefined);
    render(<RolesModal workspaceId="ws" canManage open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('role-item-Helpers'));
    const toggle = screen
      .getByTestId('role-mentionable')
      .querySelector('input') as HTMLInputElement;
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId('role-save-btn'));
    const arg = updateMut.mutateAsync.mock.calls[0][0];
    expect(arg.input.mentionable).toBe(true);
  });

  it('selecting a custom role reflects its permission toggles and saves serialized bits', async () => {
    updateMut.mutateAsync.mockResolvedValue(undefined);
    render(<RolesModal workspaceId="ws" canManage open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('role-item-Helpers'));

    // SEND_MESSAGES is on, ATTACH_FILES off.
    const sendToggle = screen
      .getByTestId('role-perm-SEND_MESSAGES')
      .querySelector('input') as HTMLInputElement;
    const attachToggle = screen
      .getByTestId('role-perm-ATTACH_FILES')
      .querySelector('input') as HTMLInputElement;
    expect(sendToggle.checked).toBe(true);
    expect(attachToggle.checked).toBe(false);

    // Toggle ATTACH_FILES on, then save → serialized mask includes both bits.
    fireEvent.click(attachToggle);
    fireEvent.click(screen.getByTestId('role-save-btn'));
    expect(updateMut.mutateAsync).toHaveBeenCalledTimes(1);
    const arg = updateMut.mutateAsync.mock.calls[0][0];
    const expected = serializePermissions(PERMISSIONS.SEND_MESSAGES | PERMISSIONS.ATTACH_FILES);
    expect(arg.input.permissions).toBe(expected);
    expect(arg.roleId).toBe('helpers');
  });

  it('delete requires a confirmation step', () => {
    render(<RolesModal workspaceId="ws" canManage open onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('role-item-Helpers'));
    fireEvent.click(screen.getByTestId('role-delete-btn'));
    expect(screen.getByTestId('role-delete-confirm')).toBeTruthy();
    expect(deleteMut.mutateAsync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('role-delete-confirm'));
    expect(deleteMut.mutateAsync).toHaveBeenCalledWith('helpers');
  });

  it('read-only mode hides create form', () => {
    render(<RolesModal workspaceId="ws" canManage={false} open onClose={vi.fn()} />);
    expect(screen.queryByTestId('role-create-btn')).toBeNull();
  });
});
