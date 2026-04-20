import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { LoginRequest, LoginRequestSchema } from '@qufox/shared-types';
import { Button } from '../../design-system/primitives';
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
    <main className="min-h-screen flex items-center justify-center bg-background">
      <section className="w-full max-w-md rounded-2xl border border-border-subtle bg-bg-surface p-8 shadow">
        <BrandMark variant="wordmark" size={28} className="mb-5" />
        <h1 className="text-2xl font-semibold text-foreground">Log in</h1>
        <p className="mt-1 text-sm text-text-muted">Welcome back.</p>
        <form className="mt-6 space-y-4" onSubmit={onSubmit}>
          <div>
            <label className="block text-sm font-medium text-foreground">Email</label>
            <input
              data-testid="login-email"
              type="email"
              autoComplete="email"
              className="mt-1 w-full rounded-md border border-border-strong bg-bg-surface px-3 py-2 text-sm text-foreground"
              {...register('email')}
            />
            {errors.email && <p className="mt-1 text-xs text-danger">{errors.email.message}</p>}
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground">Password</label>
            <input
              data-testid="login-password"
              type="password"
              autoComplete="current-password"
              className="mt-1 w-full rounded-md border border-border-strong bg-bg-surface px-3 py-2 text-sm text-foreground"
              {...register('password')}
            />
            {errors.password && (
              <p className="mt-1 text-xs text-danger">{errors.password.message}</p>
            )}
          </div>
          {serverError && (
            <p data-testid="login-error" className="text-xs text-danger">
              {serverError}
            </p>
          )}
          <Button
            data-testid="login-submit"
            type="submit"
            disabled={isSubmitting}
            className="w-full"
          >
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
        <p className="mt-6 text-sm text-text-muted">
          Need an account?{' '}
          <Link to="/signup" className="font-medium text-foreground underline">
            Sign up
          </Link>
        </p>
      </section>
    </main>
  );
}
