import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { LoginRequest, LoginRequestSchema } from '@qufox/shared-types';
import { Button, Input } from '../../design-system/primitives';
import { BrandMark } from '../../design-system/brand/BrandMark';
import { useAuth } from './AuthProvider';

export function LoginPage(): JSX.Element {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginRequest>({ resolver: zodResolver(LoginRequestSchema) });

  const from = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? '/';

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);
    try {
      await login(values);
      navigate(from, { replace: true });
    } catch (e) {
      setServerError((e as Error).message);
    }
  });

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-[var(--s-6)]">
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
        <div className="qf-eyebrow mb-[var(--s-3)]">qufox · sign in</div>
        <h1 className="text-[var(--fs-24)] font-semibold tracking-[var(--tracking-tight)] text-text-strong">
          다시 만나서 반가워요
        </h1>
        <p className="mt-[var(--s-2)] text-[length:var(--fs-13)] text-text-muted">
          이메일과 비밀번호를 입력해 로그인하세요.
        </p>
        <form className="mt-[var(--s-7)] flex flex-col gap-[var(--s-5)]" onSubmit={onSubmit}>
          <div className="qf-field">
            <label className="qf-field__label">Email</label>
            <Input
              data-testid="login-email"
              type="email"
              autoComplete="email"
              invalid={!!errors.email}
              {...register('email')}
            />
            {errors.email && <p className="qf-field__error">{errors.email.message}</p>}
          </div>
          <div className="qf-field">
            <label className="qf-field__label">Password</label>
            <Input
              data-testid="login-password"
              type="password"
              autoComplete="current-password"
              invalid={!!errors.password}
              {...register('password')}
            />
            {errors.password && <p className="qf-field__error">{errors.password.message}</p>}
          </div>
          {serverError && (
            <p data-testid="login-error" className="qf-field__error">
              {serverError}
            </p>
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
      </section>
    </main>
  );
}
