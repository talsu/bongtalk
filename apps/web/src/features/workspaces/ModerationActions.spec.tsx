// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

// S63 (D12 / FR-RM05·06·07): ModerationActions RTL. Dialog/Button pass-through 모킹
// (portal 회피), useWorkspaces 모더레이션 hooks + notification store 모킹으로 확인
// 다이얼로그·duration picker·kick undo 토스트 배선을 검증한다.
vi.mock('../../design-system/primitives', () => ({
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

const kickMut = { mutateAsync: vi.fn(), isPending: false };
const undoMut = { mutateAsync: vi.fn(), isPending: false };
const banMut = { mutateAsync: vi.fn(), isPending: false };
const timeoutMut = { mutateAsync: vi.fn(), isPending: false };

vi.mock('./useWorkspaces', () => ({
  useKickMember: () => kickMut,
  useKickUndo: () => undoMut,
  useBanMember: () => banMut,
  useTimeoutMember: () => timeoutMut,
}));

const pushSpy = vi.fn();
vi.mock('../../stores/notification-store', () => ({
  useNotifications: (selector: (s: { push: typeof pushSpy }) => unknown) =>
    selector({ push: pushSpy }),
}));

import { ModerationActions } from './ModerationActions';

function renderActions() {
  return render(<ModerationActions workspaceId="ws-1" targetUserId="u-2" targetUsername="bob" />);
}

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  kickMut.mutateAsync.mockReset();
  undoMut.mutateAsync.mockReset();
  banMut.mutateAsync.mockReset();
  timeoutMut.mutateAsync.mockReset();
  pushSpy.mockReset();
});
afterEach(() => cleanup());

describe('ModerationActions', () => {
  it('renders the three action triggers', () => {
    renderActions();
    expect(screen.getByTestId('mod-timeout-bob')).toBeTruthy();
    expect(screen.getByTestId('mod-kick-bob')).toBeTruthy();
    expect(screen.getByTestId('mod-ban-bob')).toBeTruthy();
  });

  it('kick → confirm calls kick mutation then surfaces an undo toast (9s ttl)', async () => {
    kickMut.mutateAsync.mockResolvedValue({
      undoToken: 'tok-1',
      undoExpiresAt: '2025-01-01T00:00:05.000Z',
    });
    renderActions();
    fireEvent.click(screen.getByTestId('mod-kick-bob'));
    // 확인 다이얼로그 노출.
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByTestId('mod-kick-confirm'));
    await waitFor(() =>
      expect(kickMut.mutateAsync).toHaveBeenCalledWith({ userId: 'u-2', reason: undefined }),
    );
    // Undo 토스트(되돌리기 액션 포함). S63 fix-forward (a11y BLOCKER-1): TTL 5초→9초
    // (WCAG 2.2.1 — 사용자 인지·조작 시간 확보). 서버 Undo 윈도는 여전히 5초다.
    await waitFor(() => expect(pushSpy).toHaveBeenCalled());
    const toast = pushSpy.mock.calls[0][0];
    expect(toast.ttlMs).toBe(9000);
    expect(toast.action.label).toBe('되돌리기');
    // 토스트 액션이 kickUndo 를 토큰과 함께 호출한다.
    undoMut.mutateAsync.mockResolvedValue(undefined);
    toast.action.onClick();
    await waitFor(() =>
      expect(undoMut.mutateAsync).toHaveBeenCalledWith({ userId: 'u-2', undoToken: 'tok-1' }),
    );
  });

  it('kick passes a trimmed reason when provided', async () => {
    kickMut.mutateAsync.mockResolvedValue({ undoToken: 't', undoExpiresAt: 'x' });
    renderActions();
    fireEvent.click(screen.getByTestId('mod-kick-bob'));
    fireEvent.change(screen.getByTestId('mod-kick-reason'), { target: { value: '  스팸  ' } });
    fireEvent.click(screen.getByTestId('mod-kick-confirm'));
    await waitFor(() =>
      expect(kickMut.mutateAsync).toHaveBeenCalledWith({ userId: 'u-2', reason: '스팸' }),
    );
  });

  it('ban → confirm calls ban mutation', async () => {
    banMut.mutateAsync.mockResolvedValue(undefined);
    renderActions();
    fireEvent.click(screen.getByTestId('mod-ban-bob'));
    fireEvent.click(screen.getByTestId('mod-ban-confirm'));
    await waitFor(() =>
      expect(banMut.mutateAsync).toHaveBeenCalledWith({ userId: 'u-2', reason: undefined }),
    );
  });

  it('timeout → picker default is 1h (3600s); changing the picker is honored', async () => {
    timeoutMut.mutateAsync.mockResolvedValue({ userId: 'u-2', mutedUntil: 'x' });
    renderActions();
    fireEvent.click(screen.getByTestId('mod-timeout-bob'));
    const picker = screen.getByTestId('mod-timeout-duration') as HTMLSelectElement;
    expect(picker.value).toBe('3600');
    // 7일(604800)로 변경.
    fireEvent.change(picker, { target: { value: '604800' } });
    fireEvent.click(screen.getByTestId('mod-timeout-confirm'));
    await waitFor(() =>
      expect(timeoutMut.mutateAsync).toHaveBeenCalledWith({
        userId: 'u-2',
        durationSeconds: 604800,
        reason: undefined,
      }),
    );
  });

  it('surfaces a danger toast when kick fails', async () => {
    kickMut.mutateAsync.mockRejectedValue(new Error('boom'));
    renderActions();
    fireEvent.click(screen.getByTestId('mod-kick-bob'));
    fireEvent.click(screen.getByTestId('mod-kick-confirm'));
    await waitFor(() => expect(pushSpy).toHaveBeenCalled());
    expect(pushSpy.mock.calls[0][0].variant).toBe('danger');
  });
});
