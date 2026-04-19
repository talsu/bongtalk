import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { SignupRequest, SignupRequestSchema } from '@qufox/shared-types';
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
    <main className="min-h-screen flex items-center justify-center bg-slate-50">
      <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow">
        <h1 className="text-2xl font-semibold text-slate-900">Create account</h1>
        <p className="mt-1 text-sm text-slate-500">Start talking on qufox in under a minute.</p>
        <form className="mt-6 space-y-4" onSubmit={onSubmit}>
          <div>
            <label className="block text-sm font-medium text-slate-700">Email</label>
            <input
              data-testid="signup-email"
              type="email"
              autoComplete="email"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              {...register('email')}
            />
            {errors.email && <p className="mt-1 text-xs text-red-600">{errors.email.message}</p>}
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700">Username</label>
            <input
              data-testid="signup-username"
              type="text"
              autoComplete="username"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              {...register('username')}
            />
            {errors.username && (
              <p className="mt-1 text-xs text-red-600">{errors.username.message}</p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700">Password</label>
            <input
              data-testid="signup-password"
              type="password"
              autoComplete="new-password"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              {...register('password')}
            />
            {errors.password && (
              <p className="mt-1 text-xs text-red-600">{errors.password.message}</p>
            )}
          </div>
          {serverError && (
            <p data-testid="signup-error" className="text-xs text-red-600">
              {serverError}
            </p>
          )}
          <button
            data-testid="signup-submit"
            type="submit"
            disabled={isSubmitting}
            className="w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {isSubmitting ? 'Creating…' : 'Sign up'}
          </button>
        </form>
        <p className="mt-6 text-sm text-slate-500">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-slate-900 underline">
            Log in
          </Link>
        </p>
      </section>
    </main>
  );
}
