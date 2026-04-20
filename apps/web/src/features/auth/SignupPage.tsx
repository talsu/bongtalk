import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { SignupRequest, SignupRequestSchema } from '@qufox/shared-types';
import { Button } from '../../design-system/primitives';
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
    <main className="min-h-screen flex items-center justify-center bg-background">
      <section className="w-full max-w-md rounded-2xl border border-border-subtle bg-bg-surface p-8 shadow">
        <h1 className="text-2xl font-semibold text-foreground">Create account</h1>
        <p className="mt-1 text-sm text-text-muted">Start talking on qufox in under a minute.</p>
        <form className="mt-6 space-y-4" onSubmit={onSubmit}>
          <div>
            <label className="block text-sm font-medium text-foreground">Email</label>
            <input
              data-testid="signup-email"
              type="email"
              autoComplete="email"
              className="mt-1 w-full rounded-md border border-border-strong bg-bg-surface px-3 py-2 text-sm text-foreground"
              {...register('email')}
            />
            {errors.email && <p className="mt-1 text-xs text-danger">{errors.email.message}</p>}
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground">Username</label>
            <input
              data-testid="signup-username"
              type="text"
              autoComplete="username"
              className="mt-1 w-full rounded-md border border-border-strong bg-bg-surface px-3 py-2 text-sm text-foreground"
              {...register('username')}
            />
            {errors.username && (
              <p className="mt-1 text-xs text-danger">{errors.username.message}</p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground">Password</label>
            <input
              data-testid="signup-password"
              type="password"
              autoComplete="new-password"
              className="mt-1 w-full rounded-md border border-border-strong bg-bg-surface px-3 py-2 text-sm text-foreground"
              {...register('password')}
            />
            {errors.password && (
              <p className="mt-1 text-xs text-danger">{errors.password.message}</p>
            )}
          </div>
          {serverError && (
            <p data-testid="signup-error" className="text-xs text-danger">
              {serverError}
            </p>
          )}
          <Button
            data-testid="signup-submit"
            type="submit"
            disabled={isSubmitting}
            className="w-full"
          >
            {isSubmitting ? 'Creating…' : 'Sign up'}
          </Button>
        </form>
        <p className="mt-6 text-sm text-text-muted">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-foreground underline">
            Log in
          </Link>
        </p>
      </section>
    </main>
  );
}
