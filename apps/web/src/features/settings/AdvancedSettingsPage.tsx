import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TOTP_CODE_LENGTH } from '@qufox/shared-types';
import { Dialog } from '../../design-system/primitives';
import { useAuth } from '../auth/AuthProvider';
import { useNotifications } from '../../stores/notification-store';
import { useDeactivateAccount, useTwoFactorStatus } from './useSecurity';

/**
 * S77c (D14 / FR-PS-16·19 + FR-PS-18): 설정 > 고급 탭 — 위험구역(계정 비활성화).
 *
 * "계정 비활성화" CTA → alertDialog 확인(30일 복구 안내 + 현재 비번 입력, 2FA 활성 시 인증 코드) →
 * POST /users/me/deactivate → 서버가 session:revoked emit + 모든 세션 무효화 → 자동 로그아웃 →
 * 로그인 페이지로 이동. 계정 삭제(영구)는 30일 후 자동 익명화 크론이 처리하므로(FR-PS-19) 별도 즉시
 * 하드삭제 버튼을 두지 않는다 — 비활성화가 곧 삭제 예약이며 30일 내 복구할 수 있음을 안내한다.
 */
export function AdvancedSettingsPage(): JSX.Element {
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <div
      data-testid="advanced-settings-page"
      className="mx-auto flex w-full max-w-2xl flex-col gap-[var(--s-5)]"
    >
      <header>
        {/* CF12 (ui LOW): h1 에 text-text-strong 보강(본문 대비 위계 강화). */}
        <h1 className="text-[length:var(--fs-18)] font-semibold text-text-strong">고급</h1>
      </header>

      {/* 위험구역 (FR-PS-16·19) */}
      <section
        aria-label="위험구역"
        data-testid="advanced-danger-zone"
        className="flex flex-col gap-[var(--s-3)] rounded-[var(--r-lg)] border border-border-subtle bg-bg-subtle p-[var(--s-4)]"
      >
        <div className="flex flex-col gap-[var(--s-1)]">
          <h2 className="text-[length:var(--fs-14)] font-semibold text-text-strong">
            계정 비활성화
          </h2>
          <p className="text-[length:var(--fs-13)] text-text-muted">
            계정을 비활성화하면 즉시 로그아웃되며 다른 사용자에게 표시되지 않습니다. 30일 이내에
            로그인해 복구할 수 있으며, 30일이 지나면 개인정보가 영구적으로 삭제됩니다.
          </p>
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            data-testid="account-deactivate-open"
            className="qf-btn qf-btn--danger qf-btn--sm"
            onClick={() => setConfirmOpen(true)}
          >
            계정 비활성화
          </button>
        </div>
      </section>

      <DeactivateConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen} />
    </div>
  );
}

function DeactivateConfirmDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const navigate = useNavigate();
  const { logout } = useAuth();
  const notify = useNotifications((s) => s.push);
  const deactivate = useDeactivateAccount();
  const twoFactor = useTwoFactorStatus(open);
  const totpEnabled = twoFactor.data?.totpEnabled ?? false;

  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<'password' | 'code' | null>(null);
  // CF6 (a11y HIGH-01): 처리중/성공을 polite 라이브영역으로 통지한다(에러는 별도 role="alert").
  const [status, setStatus] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setPassword('');
      setCode('');
      setError(null);
      setErrorField(null);
      setStatus(null);
      const t = setTimeout(() => firstRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open]);

  const onSubmit = async (): Promise<void> => {
    setError(null);
    setErrorField(null);
    setStatus('계정을 비활성화하는 중입니다…');
    try {
      await deactivate.mutateAsync({
        currentPassword: password,
        ...(totpEnabled ? { totpCode: code } : {}),
      });
      setStatus('계정을 비활성화했습니다.');
      // 서버가 이미 세션을 끊었으므로 클라 상태도 즉시 비운다(logout 은 best-effort — 토큰은 이미 무효).
      onOpenChange(false);
      await logout();
      notify({
        variant: 'success',
        title: '계정을 비활성화했습니다.',
        body: '30일 이내에 로그인하면 계정을 복구할 수 있습니다.',
      });
      navigate('/login', { replace: true });
    } catch (err) {
      const e = err as Error & { errorCode?: string };
      // 실패 시 처리중 상태를 비워(에러는 role="alert" 가 통지) 라이브영역 중복 통지를 피한다.
      setStatus(null);
      if (e.errorCode === 'PASSWORD_INCORRECT') {
        setError('비밀번호가 올바르지 않습니다.');
        setErrorField('password');
        return;
      }
      if (e.errorCode === 'TOTP_INVALID' || e.errorCode === 'TOTP_CODE_REQUIRED') {
        setError('인증 코드가 올바르지 않습니다.');
        setErrorField('code');
        return;
      }
      notify({ variant: 'danger', title: '계정 비활성화 실패', body: e.message });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      alertDialog
      title="계정을 비활성화할까요?"
      description="즉시 로그아웃되며 30일 이내에 로그인하면 복구할 수 있습니다. 30일이 지나면 개인정보가 영구 삭제됩니다."
    >
      <form
        data-testid="deactivate-confirm-form"
        className="flex flex-col gap-[var(--s-3)]"
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit();
        }}
      >
        <div className="flex flex-col gap-[var(--s-1)]">
          {/* CF7 (a11y HIGH-02): 필수 입력 표기 + tracking 토큰화(CF12). */}
          <label
            htmlFor="deactivate-password"
            className="text-[length:var(--fs-12)] uppercase tracking-[var(--tracking-caps)] text-text-muted"
          >
            현재 비밀번호 (필수)
          </label>
          <input
            id="deactivate-password"
            ref={firstRef}
            data-testid="deactivate-password"
            type="password"
            className="qf-input"
            autoComplete="current-password"
            required
            aria-required="true"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={errorField === 'password'}
            aria-describedby={errorField === 'password' ? 'deactivate-error' : undefined}
          />
        </div>
        {totpEnabled ? (
          <div className="flex flex-col gap-[var(--s-1)]">
            <label
              htmlFor="deactivate-code"
              className="text-[length:var(--fs-12)] uppercase tracking-[var(--tracking-caps)] text-text-muted"
            >
              인증 코드 (필수)
            </label>
            <input
              id="deactivate-code"
              data-testid="deactivate-code"
              type="text"
              className="qf-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={TOTP_CODE_LENGTH}
              required
              aria-required="true"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="000000"
              aria-invalid={errorField === 'code'}
              aria-describedby={errorField === 'code' ? 'deactivate-error' : undefined}
            />
          </div>
        ) : null}
        {/* CF6 (a11y HIGH-01): 처리중/성공 polite 라이브영역(에러는 아래 role="alert" 가 담당). */}
        <p
          data-testid="deactivate-status"
          aria-live="polite"
          aria-atomic="true"
          className="sr-only"
        >
          {status ?? ''}
        </p>
        {error ? (
          <p
            id="deactivate-error"
            data-testid="deactivate-error"
            role="alert"
            className="qf-field__error"
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
            data-testid="deactivate-confirm"
            className="qf-btn qf-btn--danger"
            disabled={
              password.length === 0 ||
              (totpEnabled && code.length !== TOTP_CODE_LENGTH) ||
              deactivate.isPending
            }
            aria-busy={deactivate.isPending}
          >
            {deactivate.isPending ? '처리 중…' : '비활성화'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
