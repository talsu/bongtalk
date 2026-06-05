import { useEffect, useRef, useState } from 'react';
import { TOTP_CODE_LENGTH, type TotpSetupResponse } from '@qufox/shared-types';
import { Dialog } from '../../design-system/primitives';
import { useNotifications } from '../../stores/notification-store';
import { useTotpSetup, useTotpVerify } from './useSecurity';

/**
 * S77b (D14 / FR-PS-15·20): TOTP 2FA 설정 마법사(3단계).
 *
 *   1) QR        — setup 응답의 QR data-URI + base32 secret 수동 입력.
 *   2) 코드 입력 — 인증 앱의 6자리 코드를 verify.
 *   3) 백업코드  — 평문 백업코드 10개 1회 표시 + 저장 확인 체크박스(확인 시에만 완료).
 *
 * 진입 시 자동으로 setup 을 호출해 시크릿/QR 을 받는다. 백업코드는 1회만 표시되므로(재조회
 * 불가) 저장 확인 체크박스를 켜야 "완료" 가 활성화된다. 모달을 닫으면 평문 백업코드는 폐기된다.
 */
export function TotpSetupWizard({
  open,
  onOpenChange,
  onCompleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCompleted: () => void;
}): JSX.Element {
  const notify = useNotifications((s) => s.push);
  const setup = useTotpSetup();
  const verify = useTotpVerify();

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [setupData, setSetupData] = useState<TotpSetupResponse | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [savedConfirmed, setSavedConfirmed] = useState(false);
  const codeInputRef = useRef<HTMLInputElement | null>(null);
  // AF4 (a11y HIGH-03): step3 진입 시 백업코드 heading 으로 포커스를 옮긴다(tabIndex=-1).
  const backupHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const startedRef = useRef(false);

  // 진입(open) 시 1회 setup 호출. 닫히면 상태 리셋.
  useEffect(() => {
    if (!open) {
      startedRef.current = false;
      setStep(1);
      setSetupData(null);
      setCode('');
      setCodeError(null);
      setBackupCodes([]);
      setSavedConfirmed(false);
      return;
    }
    if (startedRef.current) return;
    startedRef.current = true;
    setup
      .mutateAsync()
      .then((data) => setSetupData(data))
      .catch((err: Error & { errorCode?: string }) => {
        const msg =
          err.errorCode === 'ENCRYPTION_UNAVAILABLE'
            ? '2단계 인증을 일시적으로 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.'
            : err.message;
        notify({ variant: 'danger', title: '2단계 인증 설정 실패', body: msg });
        onOpenChange(false);
      });
    // open 1회만 트리거(스텝/노티 deps 제외 — exhaustive-deps 룰 없음).
  }, [open]); // eslint-disable-line

  // 코드 입력 단계 진입 시 입력란에 포커스(진입 포커스 a11y). AF4: step3 진입 시 백업코드
  // heading 으로 포커스를 옮겨 스크린리더가 경고를 즉시 읽게 한다.
  useEffect(() => {
    if (step === 2) codeInputRef.current?.focus();
    if (step === 3) backupHeadingRef.current?.focus();
  }, [step]);

  const onVerify = async (): Promise<void> => {
    setCodeError(null);
    if (code.length !== TOTP_CODE_LENGTH || !/^\d+$/.test(code)) {
      setCodeError(`인증 앱의 ${TOTP_CODE_LENGTH}자리 코드를 입력해 주세요.`);
      return;
    }
    try {
      const res = await verify.mutateAsync(code);
      setBackupCodes(res.backupCodes);
      setStep(3);
    } catch (err) {
      const e = err as Error & { errorCode?: string };
      if (e.errorCode === 'TOTP_INVALID') {
        setCodeError('코드가 올바르지 않습니다. 인증 앱의 최신 코드를 확인해 주세요.');
        return;
      }
      notify({ variant: 'danger', title: '인증 실패', body: e.message });
    }
  };

  const onCopyBackup = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(backupCodes.join('\n'));
      notify({ variant: 'success', title: '백업 코드를 복사했습니다.' });
    } catch {
      notify({ variant: 'danger', title: '복사에 실패했습니다.' });
    }
  };

  const onComplete = (): void => {
    notify({ variant: 'success', title: '2단계 인증을 활성화했습니다.' });
    onCompleted();
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="2단계 인증 설정"
      description={
        step === 1
          ? 'QR 코드를 인증 앱으로 스캔하세요.'
          : step === 2
            ? '인증 앱에 표시된 6자리 코드를 입력하세요.'
            : '백업 코드를 안전한 곳에 보관하세요. 이 화면을 닫으면 다시 볼 수 없습니다.'
      }
    >
      <div data-testid="totp-setup-wizard" className="flex flex-col gap-[var(--s-4)]">
        {/* 단계 표시(스크린리더 통지) */}
        <p className="sr-only" role="status" aria-live="polite">
          {`2단계 인증 설정 — ${step}/3 단계`}
        </p>

        {step === 1 ? (
          <div className="flex flex-col items-center gap-[var(--s-3)]">
            {setupData ? (
              <>
                <img
                  data-testid="totp-qr"
                  src={setupData.qrDataUri}
                  alt="2단계 인증 QR 코드"
                  // UF1 (ui W-1): 종전 `bg-bg-default` 는 tailwind config 에 `bg-default` 키가
                  // 없어 배경이 적용되지 않았다. QR 은 코드 인식을 위해 흰 배경이 필요하므로
                  // 유효 클래스 `bg-white` 로 교체한다(패딩으로 quiet-zone 확보).
                  className="h-44 w-44 rounded-[var(--r-md)] bg-white p-[var(--s-2)]"
                />
                <p className="text-[length:var(--fs-12)] text-text-muted">
                  QR 을 스캔할 수 없으면 아래 키를 직접 입력하세요.
                </p>
                <code
                  data-testid="totp-secret"
                  className="select-all break-all rounded-[var(--r-md)] bg-bg-subtle px-[var(--s-2)] py-[var(--s-1)] text-[length:var(--fs-13)]"
                >
                  {setupData.secret}
                </code>
              </>
            ) : (
              <p role="status" className="text-text-muted">
                불러오는 중…
              </p>
            )}
            <div className="flex w-full justify-end">
              <button
                type="button"
                data-testid="totp-step1-next"
                className="qf-btn qf-btn--primary"
                disabled={!setupData}
                onClick={() => setStep(2)}
              >
                다음
              </button>
            </div>
          </div>
        ) : null}

        {step === 2 ? (
          <form
            className="flex flex-col gap-[var(--s-2)]"
            onSubmit={(e) => {
              e.preventDefault();
              void onVerify();
            }}
          >
            <label
              htmlFor="totp-code"
              className="text-[length:var(--fs-12)] uppercase tracking-wide text-text-muted"
            >
              인증 코드
            </label>
            <input
              id="totp-code"
              ref={codeInputRef}
              data-testid="totp-code-input"
              className="qf-input"
              // MAJOR-02 (a11y): 숫자 OTP 이지만 type="number" 의 스피너/로케일 이슈를 피하려
              // type="text" 를 명시한다(inputMode=numeric 로 모바일 숫자 키패드 유지).
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={TOTP_CODE_LENGTH}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              aria-invalid={codeError !== null}
              aria-describedby={codeError ? 'totp-code-error' : undefined}
              placeholder="000000"
            />
            {codeError ? (
              // UF2 (ui W-4): raw --danger-600 직접참조 대신 DS qf-field__error 클래스(--danger-400)
              // 를 써 다크 대비/토큰 일관성을 맞춘다.
              <p
                id="totp-code-error"
                data-testid="totp-code-error"
                role="alert"
                className="qf-field__error"
              >
                {codeError}
              </p>
            ) : null}
            <div className="flex justify-between">
              <button type="button" className="qf-btn qf-btn--ghost" onClick={() => setStep(1)}>
                이전
              </button>
              <button
                type="submit"
                data-testid="totp-verify"
                className="qf-btn qf-btn--primary"
                disabled={verify.isPending}
                aria-busy={verify.isPending}
              >
                {verify.isPending ? '확인 중…' : '확인'}
              </button>
            </div>
          </form>
        ) : null}

        {step === 3 ? (
          <div className="flex flex-col gap-[var(--s-3)]">
            {/* AF4 (a11y HIGH-03): 진입 포커스(tabIndex=-1) + aria-live=assertive 로 "안전 보관 ·
               닫으면 다시 못 봄" 경고를 스크린리더가 즉시 통지한다. */}
            <h3
              ref={backupHeadingRef}
              tabIndex={-1}
              data-testid="totp-backup-heading"
              role="alert"
              aria-live="assertive"
              className="text-[length:var(--fs-15)] font-semibold focus:outline-none"
            >
              백업 코드를 안전한 곳에 보관하세요. 이 화면을 닫으면 다시 볼 수 없습니다.
            </h3>
            <ul
              data-testid="totp-backup-codes"
              className="grid grid-cols-2 gap-[var(--s-1)] rounded-[var(--r-md)] bg-bg-subtle p-[var(--s-3)]"
            >
              {backupCodes.map((c) => (
                <li
                  key={c}
                  className="select-all text-center font-mono text-[length:var(--fs-13)] tracking-widest"
                >
                  {c}
                </li>
              ))}
            </ul>
            <div className="flex justify-end">
              <button
                type="button"
                data-testid="totp-copy-backup"
                // MAJOR-03 (a11y): "복사" 텍스트만으론 무엇을 복사하는지 불명 → aria-label 보강.
                aria-label="백업 코드 복사"
                className="qf-btn qf-btn--secondary qf-btn--sm"
                onClick={() => void onCopyBackup()}
              >
                복사
              </button>
            </div>
            <label className="flex items-center gap-[var(--s-2)] text-[length:var(--fs-13)]">
              <input
                type="checkbox"
                data-testid="totp-saved-confirm"
                checked={savedConfirmed}
                onChange={(e) => setSavedConfirmed(e.target.checked)}
              />
              백업 코드를 안전한 곳에 저장했습니다.
            </label>
            <div className="flex justify-end">
              <button
                type="button"
                data-testid="totp-complete"
                className="qf-btn qf-btn--primary"
                disabled={!savedConfirmed}
                onClick={onComplete}
              >
                완료
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
