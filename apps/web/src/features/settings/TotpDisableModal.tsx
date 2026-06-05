import { useEffect, useRef, useState } from 'react';
import { TOTP_CODE_LENGTH } from '@qufox/shared-types';
import { Dialog } from '../../design-system/primitives';
import { useNotifications } from '../../stores/notification-store';
import { useTotpDisable } from './useSecurity';

/**
 * S77b (D14 / FR-PS-15): 2FA 해제 모달(비밀번호 + TOTP 코드 동시 필수).
 *
 * 파괴적 보안 변경이므로 alertDialog 로 노출한다. 비번/코드를 모두 채워야 "해제" 가 활성화되며,
 * 코드 누락은 서버가 403 TOTP_CODE_REQUIRED 로도 거부한다(클라 가드 + 서버 강제 이중).
 */
export function TotpDisableModal({
  open,
  onOpenChange,
  onDisabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDisabled: () => void;
}): JSX.Element {
  const notify = useNotifications((s) => s.push);
  const disable = useTotpDisable();

  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setPassword('');
      setCode('');
      setError(null);
      // 진입 포커스 — 첫 입력란.
      const t = setTimeout(() => firstFieldRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open]);

  const canSubmit = password.length > 0 && code.length === TOTP_CODE_LENGTH;

  const onSubmit = async (): Promise<void> => {
    setError(null);
    try {
      await disable.mutateAsync({ currentPassword: password, totpCode: code });
      notify({ variant: 'success', title: '2단계 인증을 해제했습니다.' });
      onDisabled();
      onOpenChange(false);
    } catch (err) {
      const e = err as Error & { errorCode?: string };
      if (e.errorCode === 'PASSWORD_INCORRECT') {
        setError('비밀번호가 올바르지 않습니다.');
        return;
      }
      if (e.errorCode === 'TOTP_INVALID' || e.errorCode === 'TOTP_CODE_REQUIRED') {
        setError('인증 코드가 올바르지 않습니다.');
        return;
      }
      notify({ variant: 'danger', title: '2단계 인증 해제 실패', body: e.message });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="2단계 인증 해제"
      description="해제하려면 비밀번호와 인증 앱의 코드를 입력하세요."
      alertDialog
    >
      <form
        data-testid="totp-disable-modal"
        className="flex flex-col gap-[var(--s-3)]"
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit();
        }}
      >
        <div className="flex flex-col gap-[var(--s-1)]">
          <label
            htmlFor="totp-disable-password"
            className="text-[length:var(--fs-12)] uppercase tracking-wide text-text-muted"
          >
            현재 비밀번호
          </label>
          <input
            id="totp-disable-password"
            ref={firstFieldRef}
            data-testid="totp-disable-password"
            type="password"
            className="qf-input"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-[var(--s-1)]">
          <label
            htmlFor="totp-disable-code"
            className="text-[length:var(--fs-12)] uppercase tracking-wide text-text-muted"
          >
            인증 코드
          </label>
          <input
            id="totp-disable-code"
            data-testid="totp-disable-code"
            className="qf-input"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={TOTP_CODE_LENGTH}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            placeholder="000000"
            aria-invalid={error !== null}
            aria-describedby={error ? 'totp-disable-error' : undefined}
          />
        </div>
        {error ? (
          <p
            id="totp-disable-error"
            data-testid="totp-disable-error"
            role="alert"
            className="text-[length:var(--fs-12)] text-[color:var(--danger-600)]"
          >
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-[var(--s-2)]">
          <button
            type="button"
            className="qf-btn qf-btn--ghost"
            onClick={() => onOpenChange(false)}
          >
            취소
          </button>
          <button
            type="submit"
            data-testid="totp-disable-submit"
            className="qf-btn qf-btn--danger"
            disabled={!canSubmit || disable.isPending}
            aria-busy={disable.isPending}
          >
            {disable.isPending ? '해제 중…' : '해제'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
