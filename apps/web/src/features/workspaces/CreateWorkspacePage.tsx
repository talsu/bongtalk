import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { CreateWorkspaceRequest, CreateWorkspaceRequestSchema } from '@qufox/shared-types';
import { Button } from '../../design-system/primitives';
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
    <main className="min-h-screen flex items-center justify-center bg-background">
      <section className="w-full max-w-md rounded-2xl border border-border-subtle bg-bg-surface p-8 shadow">
        <h1 className="text-2xl font-semibold text-foreground">New workspace</h1>
        <p className="mt-1 text-sm text-text-muted">
          Pick a name and a URL slug. You can invite teammates next.
        </p>
        <form className="mt-6 space-y-4" onSubmit={onSubmit}>
          <div>
            <label className="block text-sm font-medium text-foreground">Name</label>
            <input
              data-testid="ws-name"
              type="text"
              className="mt-1 w-full rounded-md border border-border-strong bg-bg-surface px-3 py-2 text-sm text-foreground"
              {...register('name')}
            />
            {errors.name && <p className="mt-1 text-xs text-danger">{errors.name.message}</p>}
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground">Slug</label>
            <input
              data-testid="ws-slug"
              type="text"
              className="mt-1 w-full rounded-md border border-border-strong bg-bg-surface px-3 py-2 text-sm text-foreground"
              {...register('slug')}
            />
            {errors.slug && <p className="mt-1 text-xs text-danger">{errors.slug.message}</p>}
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground">Description</label>
            <input
              data-testid="ws-description"
              type="text"
              className="mt-1 w-full rounded-md border border-border-strong bg-bg-surface px-3 py-2 text-sm text-foreground"
              {...register('description')}
            />
          </div>
          {serverError && (
            <p data-testid="ws-create-error" className="text-xs text-danger">
              {serverError}
            </p>
          )}
          <Button
            data-testid="ws-create-submit"
            type="submit"
            disabled={isPending}
            className="w-full"
          >
            {isPending ? 'Creating…' : 'Create workspace'}
          </Button>
        </form>
      </section>
    </main>
  );
}
