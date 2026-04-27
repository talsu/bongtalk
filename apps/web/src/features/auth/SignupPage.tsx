import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { SignupRequest, SignupRequestSchema } from '@qufox/shared-types';
import { Button, Input } from '../../design-system/primitives';
import { BrandMark } from '../../design-system/brand/BrandMark';
import { useAuth } from './AuthProvider';

export function SignupPage(): JSX.Element {
  const { signup } = useAuth();
  const navigate = useNavigate();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignupRequest>({ resolver: zodResolver(SignupRequestSchema) });

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
        <BrandMark variant="wordmark" size={28} className="mb-[var(--s-6)]" />
        <div className="qf-eyebrow mb-[var(--s-3)]">qufox · sign up</div>
        <h1 className="text-[var(--fs-24)] font-semibold tracking-[var(--tracking-tight)] text-text-strong">
          계정 만들기
        </h1>
        <p className="mt-[var(--s-2)] text-[length:var(--fs-13)] text-text-muted">
          1분 안에 대화를 시작할 수 있어요.
        </p>
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
          </div>
          {serverError && (
            <p data-testid="signup-error" className="qf-field__error">
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
