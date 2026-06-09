import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { LoginRequest, LoginRequestSchema } from '@qufox/shared-types';
import { Button, Input, Icon } from '../../design-system/primitives';
import { BrandMark } from '../../design-system/brand/BrandMark';
import { useAuth } from './AuthProvider';
import { useReactivateAccount } from '../settings/useSecurity';

export function LoginPage(): JSX.Element {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const reactivate = useReactivateAccount();
  const [serverError, setServerError] = useState<string | null>(null);
  // S77c (D14 / FR-PS-16): 비활성 계정 로그인 시 서버가 ACCOUNT_DEACTIVATED 로 응답한다. 그러면 입력한
  // 자격증명을 보관해 "계정 복구" CTA 로 reactivate 를 호출한다(자격증명은 이미 서버가 검증함).
  const [deactivated, setDeactivated] = useState<{ email: string; password: string } | null>(null);
  // CF8 (a11y HIGH-03): ACCOUNT_DEACTIVATED 안내가 뜨면 "계정 복구" 버튼으로 포커스를 옮겨 SR/키보드
  // 사용자가 복구 어포던스를 즉시 만나게 한다(role="alert" 통지 직후 액션으로 이동).
  const reactivateRef = useRef<HTMLButtonElement | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginRequest>({ resolver: zodResolver(LoginRequestSchema) });

  useEffect(() => {
    if (deactivated) reactivateRef.current?.focus();
  }, [deactivated]);

  const from = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? '/';

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);
    setDeactivated(null);
    try {
      await login(values);
      navigate(from, { replace: true });
    } catch (e) {
      const err = e as Error & { errorCode?: string };
      if (err.errorCode === 'ACCOUNT_DEACTIVATED') {
        // 복구 CTA 분기 — 자격증명을 보관(서버가 이미 검증)하고 안내 문구를 띄운다.
        setDeactivated({ email: values.email, password: values.password });
        return;
      }
      setServerError(err.message);
    }
  });

  const onReactivate = async (): Promise<void> => {
    if (!deactivated) return;
    setServerError(null);
    try {
      await reactivate.mutateAsync({ email: deactivated.email, password: deactivated.password });
      // 복구 성공 → 다시 로그인 시도(이제 활성 상태).
      await login({ email: deactivated.email, password: deactivated.password });
      navigate(from, { replace: true });
    } catch (e) {
      setServerError((e as Error).message);
    }
  };

  return (
    <main className="flex min-h-full items-center justify-center bg-background p-[var(--s-6)]">
      <section
        className="w-full max-w-md p-[var(--s-9)]"
        style={{
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-xl)',
          boxShadow: 'var(--elev-2)',
        }}
      >
        {/* AUTH-1 (PRD D18 / FR-AUTH-17): 심볼+eyebrow+제목+부제목을 세로 중앙 정렬 블록으로
            묶어 카드 상단에 둔다(로그인 목업). 폼 필드는 아래에서 좌측 정렬을 유지한다. */}
        <div className="mb-[var(--s-7)] flex flex-col items-center text-center">
          {/* a11y(HIGH-3): 바로 뒤 eyebrow "qufox · sign in" 가 맥락을 주므로 심볼은 장식
              처리(decorative)해 "qufox, qufox sign in" 중복 낭독을 피한다(WCAG 1.1.1). */}
          <BrandMark variant="symbol" size={56} decorative className="mb-[var(--s-5)]" />
          <div className="qf-eyebrow mb-[var(--s-3)]">qufox · sign in</div>
          <h1 className="text-[var(--fs-24)] font-semibold tracking-[var(--tracking-tight)] text-text-strong">
            다시 만나서 반가워요
          </h1>
          <p className="mt-[var(--s-2)] text-[length:var(--fs-13)] text-text-muted">
            바로 대화를 이어가세요.
          </p>
        </div>
        <form className="mt-[var(--s-7)] flex flex-col gap-[var(--s-5)]" onSubmit={onSubmit}>
          <div className="qf-field">
            <label className="qf-field__label" htmlFor="login-email">
              Email
            </label>
            <Input
              id="login-email"
              data-testid="login-email"
              type="email"
              autoComplete="email"
              invalid={!!errors.email}
              {...register('email')}
            />
            {errors.email && <p className="qf-field__error">{errors.email.message}</p>}
          </div>
          <div className="qf-field">
            <label className="qf-field__label" htmlFor="login-password">
              Password
            </label>
            <Input
              id="login-password"
              data-testid="login-password"
              type="password"
              autoComplete="current-password"
              invalid={!!errors.password}
              {...register('password')}
            />
            {errors.password && <p className="qf-field__error">{errors.password.message}</p>}
          </div>
          {serverError && (
            // CF2 (a11y BLK-01): 로그인/재활성화 서버 에러를 라이브영역으로 노출해 SR 가 즉시 통지받게 한다.
            <p data-testid="login-error" role="alert" className="qf-field__error">
              {serverError}
            </p>
          )}
          {/* S77c (D14 / FR-PS-16): 비활성 계정 안내 + 복구 CTA. AUTH-1 (PRD D18 / C-1):
              DS .qf-notice--warn 구조로 교체해 좌측 강조선 + 아이콘으로 색 단독 의존을 피한다. */}
          {deactivated && (
            <div
              data-testid="login-deactivated-notice"
              role="alert"
              className="qf-notice qf-notice--warn"
            >
              <Icon name="alert" className="qf-notice__icon" aria-hidden />
              <div className="qf-notice__body flex flex-col gap-[var(--s-2)]">
                <p>비활성화된 계정입니다. 30일 이내라면 계정을 복구할 수 있습니다.</p>
                <Button
                  ref={reactivateRef}
                  data-testid="login-reactivate"
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={reactivate.isPending}
                  onClick={() => void onReactivate()}
                >
                  {reactivate.isPending ? '복구 중…' : '계정 복구'}
                </Button>
              </div>
            </div>
          )}
          <Button
            data-testid="login-submit"
            type="submit"
            disabled={isSubmitting}
            size="lg"
            className="w-full"
          >
            {isSubmitting ? '로그인 중…' : '로그인'}
          </Button>
        </form>
        <p className="mt-[var(--s-6)] text-[length:var(--fs-13)] text-text-muted">
          계정이 없으신가요?{' '}
          <Link to="/signup" className="font-medium text-link hover:text-link-hover">
            가입하기
          </Link>
        </p>
        {/* AUTH-3 (PRD D18 / C-7): AUTH-1 에서 페이지 부재로 보류했던 "비밀번호 찾기" 링크.
            "가입하기" 와 같은 스타일/줄로 둔다. */}
        <p className="mt-[var(--s-2)] text-[length:var(--fs-13)] text-text-muted">
          비밀번호를 잊으셨나요?{' '}
          <Link
            to="/forgot-password"
            data-testid="login-forgot-link"
            className="font-medium text-link hover:text-link-hover"
          >
            비밀번호 찾기
          </Link>
        </p>
      </section>
    </main>
  );
}
