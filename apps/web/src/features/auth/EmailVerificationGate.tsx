import { useCallback, useEffect, useRef, useState } from 'react';
import { EMAIL_VERIFY_RESEND_COOLDOWN_SEC } from '@qufox/shared-types';
import { Button } from '../../design-system/primitives';
import { BrandMark } from '../../design-system/brand/BrandMark';
import { resendVerificationEmail } from '../../lib/api';
import { useAuth } from './AuthProvider';

const CARD_STYLE = {
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-xl)',
  boxShadow: 'var(--elev-2)',
} as const;

/**
 * S66 (D13 / FR-W05b): 이메일 인증 대기 화면. emailVerified=false 로그인/가입 시 워크
 * 스페이스 진입 대신 렌더된다(App 라우팅의 전역 가드). DS 에 .qf-verify-email-gate 클래스는
 * PRD 목업에만 정의돼 있고 CSS 는 미정의이므로(DS 4파일 수정 금지), 시맨틱 훅으로 클래스만
 * 부여하고 시각 표현은 기존 qf-* + 토큰으로 구성한다. 재발송 60초 쿨다운 카운트다운 +
 * "이미 인증했어요"(/auth/me 재조회) 버튼을 제공한다.
 */
export function EmailVerificationGate(): JSX.Element {
  const { user, logout, refreshMe } = useAuth();
  const [cooldown, setCooldown] = useState(0);
  const [resending, setResending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const startCooldown = useCallback((sec: number) => {
    setCooldown(sec);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setCooldown((prev) => {
        if (prev <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  const onResend = useCallback(async () => {
    if (cooldown > 0 || resending) return;
    setResending(true);
    setError(null);
    setNotice(null);
    try {
      const res = await resendVerificationEmail();
      startCooldown(res.cooldownSec || EMAIL_VERIFY_RESEND_COOLDOWN_SEC);
      setNotice(
        res.remainingToday > 0
          ? '인증 메일을 다시 보냈습니다. 받은 편지함을 확인해 주세요.'
          : '인증 메일을 다시 보냈습니다. 오늘 재발송 한도에 도달했습니다.',
      );
    } catch (e) {
      const err = e as Error & { errorCode?: string; retryAfterSec?: number };
      if (err.errorCode === 'EMAIL_VERIFICATION_RATE_LIMITED') {
        // 쿨다운/일일 한도 — 남은 시간이 있으면 카운트다운을 동기화한다.
        if (typeof err.retryAfterSec === 'number' && err.retryAfterSec > 0) {
          startCooldown(Math.min(err.retryAfterSec, EMAIL_VERIFY_RESEND_COOLDOWN_SEC));
        }
        setError('잠시 후 다시 시도해 주세요. 재발송은 일정 시간 간격으로만 가능합니다.');
      } else {
        setError('인증 메일 재발송에 실패했습니다. 잠시 후 다시 시도해 주세요.');
      }
    } finally {
      setResending(false);
    }
  }, [cooldown, resending, startCooldown]);

  const onAlreadyVerified = useCallback(async () => {
    if (checking) return;
    setChecking(true);
    setError(null);
    setNotice(null);
    const verified = await refreshMe();
    setChecking(false);
    if (!verified) {
      setError('아직 인증이 확인되지 않았습니다. 메일의 인증 링크를 클릭한 뒤 다시 시도해 주세요.');
    }
    // verified=true 면 AuthProvider 의 user.emailVerified 가 true 로 바뀌어 전역
    // 가드가 게이트를 해제하고 워크스페이스로 진입한다(별도 네비게이션 불요).
  }, [checking, refreshMe]);

  return (
    <main
      data-testid="verify-email-gate"
      className="qf-verify-email-gate flex min-h-full items-center justify-center bg-background p-[var(--s-6)]"
    >
      <section className="w-full max-w-md p-[var(--s-9)] text-center" style={CARD_STYLE}>
        <BrandMark variant="wordmark" size={28} className="mb-[var(--s-6)]" />
        <div className="qf-eyebrow mb-[var(--s-3)]">email verification</div>
        <h1 className="text-[length:var(--fs-24)] font-semibold tracking-[var(--tracking-tight)] text-text-strong">
          이메일 인증이 필요합니다
        </h1>
        <p className="mt-[var(--s-3)] text-[length:var(--fs-13)] text-text-muted">
          인증 메일을 보냈습니다. 받은 편지함을 확인해 주세요.
        </p>
        {user?.email && (
          <p className="mt-[var(--s-2)] text-[length:var(--fs-12)] text-text-muted">
            <span className="font-mono">{user.email}</span>
          </p>
        )}

        <div className="mt-[var(--s-7)] flex flex-col gap-[var(--s-3)]">
          <Button
            type="button"
            data-testid="verify-already"
            size="lg"
            disabled={checking}
            onClick={onAlreadyVerified}
          >
            {checking ? '확인 중…' : '이미 인증했어요'}
          </Button>
          <Button
            type="button"
            data-testid="verify-resend"
            variant="secondary"
            size="lg"
            disabled={cooldown > 0 || resending}
            onClick={onResend}
          >
            {cooldown > 0
              ? `재발송 (${cooldown}초 후 가능)`
              : resending
                ? '보내는 중…'
                : '인증 메일 다시 보내기'}
          </Button>
        </div>

        {notice && (
          <p
            data-testid="verify-notice"
            className="mt-[var(--s-4)] text-[length:var(--fs-12)] text-text-muted"
          >
            {notice}
          </p>
        )}
        {error && (
          <p
            data-testid="verify-error"
            className="mt-[var(--s-4)] text-[length:var(--fs-12)] text-warning"
          >
            {error}
          </p>
        )}

        <button
          type="button"
          data-testid="verify-logout"
          className="qf-btn qf-btn--link mt-[var(--s-6)] text-[length:var(--fs-13)]"
          onClick={() => void logout()}
        >
          다른 계정으로 로그인
        </button>
      </section>
    </main>
  );
}
