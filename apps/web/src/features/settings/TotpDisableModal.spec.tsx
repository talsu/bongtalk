// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const pushMock = vi.fn();
vi.mock('../../stores/notification-store', () => ({
  useNotifications: (sel: (s: { push: typeof pushMock }) => unknown) => sel({ push: pushMock }),
}));

let lastAlertDialog: boolean | undefined;
vi.mock('../../design-system/primitives', () => ({
  Dialog: ({
    children,
    open,
    alertDialog,
  }: {
    children?: ReactNode;
    open?: boolean;
    alertDialog?: boolean;
  }) => {
    lastAlertDialog = alertDialog;
    return open ? <div role="alertdialog">{children}</div> : null;
  },
}));

const disableMutate = vi.fn();
vi.mock('./useSecurity', () => ({
  useTotpDisable: () => ({ mutateAsync: disableMutate, isPending: false }),
}));

import { TotpDisableModal } from './TotpDisableModal';

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  pushMock.mockReset();
  disableMutate.mockReset();
  disableMutate.mockResolvedValue(undefined);
  lastAlertDialog = undefined;
});
afterEach(() => cleanup());

describe('TotpDisableModal (FR-PS-15)', () => {
  it('alertDialog 로 노출된다(파괴적 보안 변경)', () => {
    render(<TotpDisableModal open onOpenChange={vi.fn()} onDisabled={vi.fn()} />);
    expect(lastAlertDialog).toBe(true);
  });

  it('비번+6자리 코드 둘 다 채워야 해제 버튼이 활성화된다', () => {
    render(<TotpDisableModal open onOpenChange={vi.fn()} onDisabled={vi.fn()} />);
    const submit = screen.getByTestId('totp-disable-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('totp-disable-password'), { target: { value: 'pw' } });
    expect(submit.disabled).toBe(true); // 코드 없음.
    fireEvent.change(screen.getByTestId('totp-disable-code'), { target: { value: '123456' } });
    expect(submit.disabled).toBe(false);
  });

  it('제출 시 currentPassword+totpCode 로 disable mutation 호출 후 닫힌다', async () => {
    const onOpenChange = vi.fn();
    const onDisabled = vi.fn();
    render(<TotpDisableModal open onOpenChange={onOpenChange} onDisabled={onDisabled} />);
    fireEvent.change(screen.getByTestId('totp-disable-password'), {
      target: { value: 'mypw' },
    });
    fireEvent.change(screen.getByTestId('totp-disable-code'), { target: { value: '654321' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('totp-disable-submit'));
    });
    expect(disableMutate).toHaveBeenCalledWith({ currentPassword: 'mypw', totpCode: '654321' });
    expect(onDisabled).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('PASSWORD_INCORRECT 면 에러 표기(머무름)', async () => {
    disableMutate.mockRejectedValueOnce(
      Object.assign(new Error('x'), { errorCode: 'PASSWORD_INCORRECT' }),
    );
    render(<TotpDisableModal open onOpenChange={vi.fn()} onDisabled={vi.fn()} />);
    fireEvent.change(screen.getByTestId('totp-disable-password'), { target: { value: 'bad' } });
    fireEvent.change(screen.getByTestId('totp-disable-code'), { target: { value: '111111' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('totp-disable-submit'));
    });
    expect(screen.getByTestId('totp-disable-error').textContent).toContain('비밀번호가 올바르지 않습니다');
  });

  it('코드 입력은 숫자만 허용한다', () => {
    render(<TotpDisableModal open onOpenChange={vi.fn()} onDisabled={vi.fn()} />);
    const code = screen.getByTestId('totp-disable-code') as HTMLInputElement;
    fireEvent.change(code, { target: { value: '12ab34' } });
    expect(code.value).toBe('1234');
  });
});
