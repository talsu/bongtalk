// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const pushMock = vi.fn();
vi.mock('../../stores/notification-store', () => ({
  useNotifications: (sel: (s: { push: typeof pushMock }) => unknown) => sel({ push: pushMock }),
}));

vi.mock('../../design-system/primitives', () => ({
  Dialog: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
}));

const setupMutate = vi.fn();
const verifyMutate = vi.fn();
vi.mock('./useSecurity', () => ({
  useTotpSetup: () => ({ mutateAsync: setupMutate, isPending: false }),
  useTotpVerify: () => ({ mutateAsync: verifyMutate, isPending: false }),
}));

import { TotpSetupWizard } from './TotpSetupWizard';

const BACKUP = Array.from({ length: 10 }, (_, i) => `code${i}aa`);

beforeEach(() => {
  vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
  pushMock.mockReset();
  setupMutate.mockReset();
  setupMutate.mockResolvedValue({
    otpauthUri: 'otpauth://totp/qufox:me@qufox.dev?secret=ABC',
    secret: 'ABCDEF',
    qrDataUri: 'data:image/png;base64,xxx',
  });
  verifyMutate.mockReset();
  verifyMutate.mockResolvedValue({ totpEnabled: true, backupCodes: BACKUP });
});
afterEach(() => cleanup());

describe('TotpSetupWizard (FR-PS-15·20)', () => {
  it('진입 시 setup 호출 → 1단계 QR + secret 표시', async () => {
    render(<TotpSetupWizard open onOpenChange={vi.fn()} onCompleted={vi.fn()} />);
    await waitFor(() => expect(setupMutate).toHaveBeenCalled());
    expect((screen.getByTestId('totp-qr') as HTMLImageElement).src).toContain('data:image/png');
    expect(screen.getByTestId('totp-secret').textContent).toBe('ABCDEF');
  });

  it('3단계 흐름: QR → 코드 입력(verify) → 백업코드 10개 표시 + 저장 확인 후 완료', async () => {
    const onCompleted = vi.fn();
    const onOpenChange = vi.fn();
    render(<TotpSetupWizard open onOpenChange={onOpenChange} onCompleted={onCompleted} />);
    await waitFor(() => expect(screen.getByTestId('totp-step1-next')).toBeTruthy());

    // 1단계 → 2단계.
    fireEvent.click(screen.getByTestId('totp-step1-next'));
    fireEvent.change(screen.getByTestId('totp-code-input'), { target: { value: '123456' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('totp-verify'));
    });
    expect(verifyMutate).toHaveBeenCalledWith('123456');

    // 3단계 — 백업코드 10개.
    const list = screen.getByTestId('totp-backup-codes');
    expect(list.querySelectorAll('li')).toHaveLength(10);

    // 저장 확인 전엔 완료 비활성, 체크 후 활성 → 클릭 시 onCompleted + 닫기.
    const complete = screen.getByTestId('totp-complete') as HTMLButtonElement;
    expect(complete.disabled).toBe(true);
    fireEvent.click(screen.getByTestId('totp-saved-confirm'));
    expect(complete.disabled).toBe(false);
    fireEvent.click(complete);
    expect(onCompleted).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('verify TOTP_INVALID 면 2단계에서 에러 표기(머무름)', async () => {
    verifyMutate.mockRejectedValueOnce(
      Object.assign(new Error('bad'), { errorCode: 'TOTP_INVALID' }),
    );
    render(<TotpSetupWizard open onOpenChange={vi.fn()} onCompleted={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('totp-step1-next')).toBeTruthy());
    fireEvent.click(screen.getByTestId('totp-step1-next'));
    fireEvent.change(screen.getByTestId('totp-code-input'), { target: { value: '000000' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('totp-verify'));
    });
    expect(screen.getByTestId('totp-code-error').textContent).toContain('올바르지 않습니다');
    // 백업코드 단계로 진입하지 않는다.
    expect(screen.queryByTestId('totp-backup-codes')).toBeNull();
  });
});
