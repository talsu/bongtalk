import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../../design-system/primitives';
import { useAuth } from '../auth/AuthProvider';
import { useNotifications } from '../../stores/notification-store';
import {
  useChangeEmail,
  useChangePassword,
  useTwoFactorStatus,
} from './useSecurity';
import { TotpSetupWizard } from './TotpSetupWizard';
import { TotpDisableModal } from './TotpDisableModal';
import { SessionsSection } from './SessionsSection';

/**
 * S77b (D14 / FR-PS-15·20 + FR-PS-18): 설정 > 내 계정 탭(명시적 저장).
 *
 *   - EmailSection:    현재 이메일 표시 + 변경 모달(현재 비번 + 신규 이메일 → 인증메일 발송).
 *   - PasswordSection: 변경 모달(현재 비번 + 새 비번).
 *   - TotpSection:     2FA 상태 + 설정 마법사(3단계) / 해제 모달(비번+코드).
 *   - SessionsSection: 활성 세션 목록 + 개별/전체 로그아웃.
 *
 * 명시적 저장(FR-PS-18) — 각 액션은 모달 안에서 사용자가 확인해야 적용된다.
 */
export function AccountSettingsPage(): JSX.Element {
  const { user } = useAuth();
  const twoFactor = useTwoFactorStatus();

  const [emailOpen, setEmailOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);

  const totpEnabled = twoFactor.data?.totpEnabled ?? false;

  return (
    <div
      data-testid="account-settings-page"
      className="mx-auto flex w-full max-w-2xl flex-col gap-[var(--s-5)]"
    >
      <header>
        <h1 className="text-[length:var(--fs-18)] font-semibold">내 계정</h1>
      </header>

      {/* 이메일 (FR-PS-15) */}
      <section aria-label="이메일" className="flex items-center justify-between gap-[var(--s-3)]">
        <div className="flex flex-col">
          <span className="text-[length:var(--fs-12)] uppercase tracking-wide text-text-muted">
            이메일
          </span>
          <span data-testid="account-email" className="text-[length:var(--fs-14)]">
            {user?.email ?? '—'}
          </span>
        </div>
        <button
          type="button"
          data-testid="account-change-email"
          className="qf-btn qf-btn--secondary qf-btn--sm"
          onClick={() => setEmailOpen(true)}
        >
          변경
        </button>
      </section>

      {/* 비밀번호 (FR-PS-15) */}
      <section aria-label="비밀번호" className="flex items-center justify-between gap-[var(--s-3)]">
        <div className="flex flex-col">
          <span className="text-[length:var(--fs-12)] uppercase tracking-wide text-text-muted">
            비밀번호
          </span>
          <span className="text-[length:var(--fs-14)] text-text-muted">••••••••</span>
        </div>
        <button
          type="button"
          data-testid="account-change-password"
          className="qf-btn qf-btn--secondary qf-btn--sm"
          onClick={() => setPasswordOpen(true)}
        >
          변경
        </button>
      </section>

      {/* 2단계 인증 (FR-PS-15·20) */}
      <section aria-label="2단계 인증" className="flex items-center justify-between gap-[var(--s-3)]">
        <div className="flex flex-col">
          <span className="text-[length:var(--fs-12)] uppercase tracking-wide text-text-muted">
            2단계 인증 (TOTP)
          </span>
          <span data-testid="totp-status" className="text-[length:var(--fs-14)]">
            {twoFactor.isLoading ? '불러오는 중…' : totpEnabled ? '활성화됨' : '비활성화됨'}
          </span>
        </div>
        {totpEnabled ? (
          <button
            type="button"
            data-testid="totp-disable-open"
            className="qf-btn qf-btn--danger qf-btn--sm"
            onClick={() => setDisableOpen(true)}
          >
            해제
          </button>
        ) : (
          <button
            type="button"
            data-testid="totp-setup-open"
            className="qf-btn qf-btn--primary qf-btn--sm"
            disabled={twoFactor.isLoading}
            onClick={() => setSetupOpen(true)}
          >
            설정
          </button>
        )}
      </section>

      {/* 세션 (FR-PS-15) */}
      <SessionsSection />

      <ChangeEmailModal open={emailOpen} onOpenChange={setEmailOpen} />
      <ChangePasswordModal open={passwordOpen} onOpenChange={setPasswordOpen} />
      <TotpSetupWizard
        open={setupOpen}
        onOpenChange={setSetupOpen}
        onCompleted={() => void twoFactor.refetch()}
      />
      <TotpDisableModal
        open={disableOpen}
        onOpenChange={setDisableOpen}
        onDisabled={() => void twoFactor.refetch()}
      />
    </div>
  );
}

function ChangeEmailModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const notify = useNotifications((s) => s.push);
  const changeEmail = useChangeEmail();
  const [password, setPassword] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setPassword('');
      setNewEmail('');
      setError(null);
      const t = setTimeout(() => firstRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open]);

  const onSubmit = async (): Promise<void> => {
    setError(null);
    try {
      const res = await changeEmail.mutateAsync({ currentPassword: password, newEmail });
      notify({
        variant: 'success',
        title: '인증 메일을 보냈습니다.',
        body: `${res.pendingEmail} 로 보낸 인증 메일을 확인해 주세요.`,
      });
      onOpenChange(false);
    } catch (err) {
      const e = err as Error & { errorCode?: string };
      if (e.errorCode === 'PASSWORD_INCORRECT') {
        setError('비밀번호가 올바르지 않습니다.');
        return;
      }
      notify({ variant: 'danger', title: '이메일 변경 실패', body: e.message });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="이메일 변경"
      description="새 이메일로 인증 메일을 보냅니다. 확인 후 변경이 완료됩니다."
    >
      <form
        data-testid="change-email-modal"
        className="flex flex-col gap-[var(--s-3)]"
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit();
        }}
      >
        <Labeled label="현재 비밀번호" htmlFor="ce-password">
          <input
            id="ce-password"
            ref={firstRef}
            data-testid="change-email-password"
            type="password"
            className="qf-input"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Labeled>
        <Labeled label="새 이메일" htmlFor="ce-email">
          <input
            id="ce-email"
            data-testid="change-email-input"
            type="email"
            className="qf-input"
            autoComplete="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            aria-invalid={error !== null}
            aria-describedby={error ? 'ce-error' : undefined}
          />
        </Labeled>
        {error ? (
          <p id="ce-error" data-testid="change-email-error" role="alert" className="text-[length:var(--fs-12)] text-[color:var(--danger-600)]">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-[var(--s-2)]">
          <button type="button" className="qf-btn qf-btn--ghost" onClick={() => onOpenChange(false)}>
            취소
          </button>
          <button
            type="submit"
            data-testid="change-email-submit"
            className="qf-btn qf-btn--primary"
            disabled={password.length === 0 || newEmail.length === 0 || changeEmail.isPending}
            aria-busy={changeEmail.isPending}
          >
            {changeEmail.isPending ? '전송 중…' : '인증 메일 보내기'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ChangePasswordModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const notify = useNotifications((s) => s.push);
  const changePassword = useChangePassword();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setCurrent('');
      setNext('');
      setError(null);
      const t = setTimeout(() => firstRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open]);

  const tooShort = next.length > 0 && next.length < 8;

  const onSubmit = async (): Promise<void> => {
    setError(null);
    if (next.length < 8) {
      setError('새 비밀번호는 8자 이상이어야 합니다.');
      return;
    }
    try {
      await changePassword.mutateAsync({ currentPassword: current, newPassword: next });
      notify({ variant: 'success', title: '비밀번호를 변경했습니다.' });
      onOpenChange(false);
    } catch (err) {
      const e = err as Error & { errorCode?: string };
      if (e.errorCode === 'PASSWORD_INCORRECT') {
        setError('현재 비밀번호가 올바르지 않습니다.');
        return;
      }
      if (e.errorCode === 'AUTH_WEAK_PASSWORD') {
        setError('새 비밀번호가 정책을 충족하지 않습니다(8자 이상 · 문자/숫자/기호 조합).');
        return;
      }
      notify({ variant: 'danger', title: '비밀번호 변경 실패', body: e.message });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="비밀번호 변경">
      <form
        data-testid="change-password-modal"
        className="flex flex-col gap-[var(--s-3)]"
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit();
        }}
      >
        <Labeled label="현재 비밀번호" htmlFor="cp-current">
          <input
            id="cp-current"
            ref={firstRef}
            data-testid="change-password-current"
            type="password"
            className="qf-input"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Labeled>
        <Labeled label="새 비밀번호" htmlFor="cp-new">
          <input
            id="cp-new"
            data-testid="change-password-new"
            type="password"
            className="qf-input"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            aria-invalid={tooShort || error !== null}
            aria-describedby={error ? 'cp-error' : undefined}
          />
        </Labeled>
        {error ? (
          <p id="cp-error" data-testid="change-password-error" role="alert" className="text-[length:var(--fs-12)] text-[color:var(--danger-600)]">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-[var(--s-2)]">
          <button type="button" className="qf-btn qf-btn--ghost" onClick={() => onOpenChange(false)}>
            취소
          </button>
          <button
            type="submit"
            data-testid="change-password-submit"
            className="qf-btn qf-btn--primary"
            disabled={current.length === 0 || next.length < 8 || changePassword.isPending}
            aria-busy={changePassword.isPending}
          >
            {changePassword.isPending ? '변경 중…' : '변경'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function Labeled({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-[var(--s-1)]">
      <label
        htmlFor={htmlFor}
        className="text-[length:var(--fs-12)] uppercase tracking-wide text-text-muted"
      >
        {label}
      </label>
      {children}
    </div>
  );
}
