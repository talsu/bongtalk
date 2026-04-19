import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { CreateWorkspaceRequest, CreateWorkspaceRequestSchema } from '@qufox/shared-types';
import { useCreateWorkspace } from './useWorkspaces';

export function CreateWorkspacePage(): JSX.Element {
  const navigate = useNavigate();
  const { mutateAsync, isPending } = useCreateWorkspace();
  const [serverError, setServerError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CreateWorkspaceRequest>({ resolver: zodResolver(CreateWorkspaceRequestSchema) });

  const onSubmit = handleSubmit(async (values) => {
    setServerError(null);
    try {
      const ws = await mutateAsync(values);
      navigate(`/w/${ws.slug}`, { replace: true });
    } catch (e) {
      setServerError((e as Error).message);
    }
  });

  return (
    <main className="min-h-screen flex items-center justify-center bg-slate-50">
      <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow">
        <h1 className="text-2xl font-semibold text-slate-900">New workspace</h1>
        <p className="mt-1 text-sm text-slate-500">
          Pick a name and a URL slug. You can invite teammates next.
        </p>
        <form className="mt-6 space-y-4" onSubmit={onSubmit}>
          <div>
            <label className="block text-sm font-medium text-slate-700">Name</label>
            <input
              data-testid="ws-name"
              type="text"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              {...register('name')}
            />
            {errors.name && <p className="mt-1 text-xs text-red-600">{errors.name.message}</p>}
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700">Slug</label>
            <input
              data-testid="ws-slug"
              type="text"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              {...register('slug')}
            />
            {errors.slug && <p className="mt-1 text-xs text-red-600">{errors.slug.message}</p>}
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700">Description</label>
            <input
              data-testid="ws-description"
              type="text"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              {...register('description')}
            />
          </div>
          {serverError && (
            <p data-testid="ws-create-error" className="text-xs text-red-600">
              {serverError}
            </p>
          )}
          <button
            data-testid="ws-create-submit"
            type="submit"
            disabled={isPending}
            className="w-full rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {isPending ? 'Creating…' : 'Create workspace'}
          </button>
        </form>
      </section>
    </main>
  );
}
