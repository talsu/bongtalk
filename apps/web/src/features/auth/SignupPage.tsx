import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { SignupRequest, SignupRequestSchema } from '@qufox/shared-types';
import { Button, Input, StrengthMeter } from '../../design-system/primitives';
import { BrandMark } from '../../design-system/brand/BrandMark';
import { useAuth } from './AuthProvider';

export function SignupPage(): JSX.Element {
  const { signup } = useAuth();
  const navigate = useNavigate();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<SignupRequest>({ resolver: zodResolver(SignupRequestSchema) });
  // AUTH-1 (PRD D18 / C-6): 비밀번호 강도 미터에 실시간 입력값을 전달한다.
  const password = watch('password') ?? '';

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);
    try {
      await signup(values);
      navigate('/', { replace: true });
    } catch (e) {
      setServerError((e as Error).message);
    }
  });

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
        {/* AUTH-1 (PRD D18): 심볼+eyebrow+제목+부제목 세로 중앙 정렬 블록(로그인과 동일 패턴). */}
        <div className="mb-[var(--s-7)] flex flex-col items-center text-center">
          {/* a11y(HIGH-3): 바로 뒤 eyebrow "qufox · sign up" 가 맥락을 주므로 심볼은 장식
              처리(decorative)해 "qufox, qufox sign up" 중복 낭독을 피한다(WCAG 1.1.1). */}
          <BrandMark variant="symbol" size={48} decorative className="mb-[var(--s-5)]" />
          <div className="qf-eyebrow mb-[var(--s-3)]">qufox · sign up</div>
          <h1 className="text-[length:var(--fs-24)] font-semibold tracking-[var(--tracking-tight)] text-text-strong">
            qufox에 오신 걸 환영해요
          </h1>
          <p className="mt-[var(--s-2)] text-[length:var(--fs-13)] text-text-muted">
            1분이면 대화를 시작할 수 있어요.
          </p>
        </div>
        <form className="mt-[var(--s-7)] flex flex-col gap-[var(--s-5)]" onSubmit={onSubmit}>
          <div className="qf-field">
            <label className="qf-field__label" htmlFor="signup-email">
              Email
            </label>
            <Input
              id="signup-email"
              data-testid="signup-email"
              type="email"
              autoComplete="email"
              invalid={!!errors.email}
              {...register('email')}
            />
            {errors.email && <p className="qf-field__error">{errors.email.message}</p>}
          </div>
          <div className="qf-field">
            <label className="qf-field__label" htmlFor="signup-username">
              Username
            </label>
            <Input
              id="signup-username"
              data-testid="signup-username"
              type="text"
              autoComplete="username"
              invalid={!!errors.username}
              {...register('username')}
            />
            {errors.username && <p className="qf-field__error">{errors.username.message}</p>}
          </div>
          <div className="qf-field">
            <label className="qf-field__label" htmlFor="signup-password">
              Password
            </label>
            <Input
              id="signup-password"
              data-testid="signup-password"
              type="password"
              autoComplete="new-password"
              invalid={!!errors.password}
              {...register('password')}
            />
            {errors.password && <p className="qf-field__error">{errors.password.message}</p>}
            {/* AUTH-1 (PRD D18 / C-6): 입력 중 비밀번호 강도를 실시간 표시한다(빈 값이면 숨김). */}
            <StrengthMeter password={password} />
          </div>
          {serverError && (
            // a11y(HIGH-1): 가입 실패 사유를 SR 이 즉시 통지받도록 라이브 영역화(LoginPage 와 동일).
            <p data-testid="signup-error" role="alert" className="qf-field__error">
              {serverError}
            </p>
          )}
          <Button
            data-testid="signup-submit"
            type="submit"
            disabled={isSubmitting}
            size="lg"
            className="w-full"
          >
            {isSubmitting ? '만드는 중…' : '가입하기'}
          </Button>
        </form>
        <p className="mt-[var(--s-6)] text-[length:var(--fs-13)] text-text-muted">
          이미 계정이 있으신가요?{' '}
          <Link to="/login" className="font-medium text-link hover:text-link-hover">
            로그인
          </Link>
        </p>
      </section>
    </main>
  );
}
